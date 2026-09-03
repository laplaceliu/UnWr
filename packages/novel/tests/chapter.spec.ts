/**
 * 章节与记忆工具的端到端测试。
 *
 * 覆盖「读 → 写 → 记忆沉淀」闭环，对真实飞书测试库操作。
 * 未设置 UNWR_TEST_BASE 时全部跳过。
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'
import { countWords, maxChapterNo, normalizeContent } from '../src/domain/chapter.ts'
import { renderSummary, splitParticipantNote } from '../src/domain/memory.ts'

/** 工具定义的最小视图。 */
interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({ tools: { register: (t: MinimalTool) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } } as never, {})
  return tools
}

const TEST_BASE = process.env.UNWR_TEST_BASE ?? ''
const HAS_BASE = TEST_BASE !== ''

describe('纯函数（不依赖飞书）', () => {
  it('countWords 剥离 Markdown 标记后统计中文字数', () => {
    // 标题与场景小标题的文字也计入：标题(2) + 场景一(3) + 正文(7) = 12
    expect(countWords('# 标题\n\n## 场景一\n\n这是一段正文。')).toBe(12)
    // 代码块不计入
    expect(countWords('正文\n\n```js\nconst a = 1\n```')).toBe(2)
    // 链接只保留文字：「见这里」= 3
    expect(countWords('见[这里](https://x.com)')).toBe(3)
  })

  it('normalizeContent 剥离首行 h1 并给出提示', () => {
    const r = normalizeContent('# 第一章 雨夜\n\n## 一\n\n正文')
    // 剥离后不应再有 h1（`##` 仍以 # 开头，故不能用 startsWith('#') 判断）
    expect(/^#\s/m.test(r.content)).toBe(false)
    expect(r.content).toContain('## 一')
    expect(r.warnings[0]).toContain('章标题由 title 参数承担')
  })

  it('normalizeContent 对无 ## 分节的正文给出提示', () => {
    const r = normalizeContent('只有一段正文，没有分节。')
    expect(r.warnings.some((w) => w.includes('##' ))).toBe(true)
  })

  it('renderSummary 按固定模板渲染', () => {
    const text = renderSummary({
      scene: '城南酒肆',
      events: ['沈砚入城', '与柳三娘交锋'],
      endState: '线索指向城西',
    })
    expect(text).toContain('【场景】城南酒肆')
    expect(text).toContain('- 沈砚入城')
    expect(text).toContain('【章末状态】线索指向城西')
  })

  it('splitParticipantNote 拆分尾随括号注记（e2e 实测：整串传入恒匹配失败）', () => {
    // 实机出现过的三种形态
    expect(splitParticipantNote('陆铮（不在场）')).toEqual({ name: '陆铮', note: '不在场' })
    expect(splitParticipantNote('匿名发件人（未识别）')).toEqual({ name: '匿名发件人', note: '未识别' })
    expect(splitParticipantNote('林警司（三级警司，值班民警）')).toEqual({ name: '林警司', note: '三级警司，值班民警' })
    // 半角括号与空白
    expect(splitParticipantNote(' 苏晚棠 (到场) ')).toEqual({ name: '苏晚棠', note: '到场' })
    // 无注记
    expect(splitParticipantNote('陆铮')).toEqual({ name: '陆铮' })
    // 括号不闭合 → 不剥（保守）
    expect(splitParticipantNote('陆铮（不在场')).toEqual({ name: '陆铮（不在场' })
    // 整串都在括号里 → 原样返回，不当姓名用
    expect(splitParticipantNote('（路人）')).toEqual({ name: '（路人）' })
    // 注记为空 → 视为无注记
    expect(splitParticipantNote('陆铮（）')).toEqual({ name: '陆铮' })
  })
})

describe('工具注册', () => {
  it('注册了章节与记忆相关工具', () => {
    const tools = collectTools()
    // 不断言完整列表（会随开发增长而频繁失效），只断言核心工具都在
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'novel_append_chapter',
        'novel_build_context',
        'novel_read_chapter',
        'novel_record_character_state',
        'novel_record_event',
        'novel_update_summary',
        'novel_upsert_book_summary',
        'novel_write_chapter',
      ]),
    )
  })

  it('所有工具名符合 DSH 命名约定', () => {
    for (const name of collectTools().keys()) {
      expect(/^[A-Za-z0-9_-]{1,64}$/.test(name)).toBe(true)
    }
  })

  it('novel_write_chapter 必填参数正确', () => {
    const tool = collectTools().get('novel_write_chapter')
    const params = tool?.parameters as { required?: string[] } | undefined
    // workToken 不再是必填：会话上下文默认承接（resolveWorkToken）；title + content 才是必填。
    expect(params?.required ?? []).toEqual(expect.arrayContaining(['title', 'content']))
    expect(params?.required ?? []).not.toContain('workToken')
  })
})

describe.skipIf(!HAS_BASE)('端到端：真实飞书闭环', () => {
  const tools = collectTools()
  const baseToken = TEST_BASE
  let createdDocId = ''
  /**
   * 章节号在 beforeAll 里动态分配，取「当前最大章节号 + 随机偏移」。
   *
   * 曾用固定随机区间（900 + random*90），但测试反复运行会留下历史记录，
   * 随机号迟早撞上——表现为"创建章节"失败、"冲突检测"反而通过，
   * 症状极具误导性。取当前最大值之上可保证绝不碰撞。
   */
  let chapterNo = 0

  beforeAll(async () => {
    if (!HAS_BASE) return
    await waitForBaseReady(TEST_BASE !== '' ? TEST_BASE : baseToken)
    chapterNo = await maxChapterNo(baseToken) + 100 + Math.floor(Math.random() * 50)
  })

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    return await tool.execute({ workToken: baseToken, ...args }, {
      signal: AbortSignal.timeout(50_000),
    }) as Record<string, unknown>
  }

  it('write → 创建章节文档与索引', async () => {
    const r = await run('novel_write_chapter', {
      chapterNo,
      title: `[测试] 第${chapterNo}章 冒烟`,
      volume: '测试卷',
      outline: '用于端到端测试',
      content: '## 一、入城\n\n雨下得很大。沈砚站在酒肆檐下。\n\n## 二、交锋\n\n他不答话，只把剑放在桌上。\n',
    })
    expect(r.chapterNo).toBe(chapterNo)
    expect(typeof r.documentId).toBe('string')
    expect(typeof r.recordId).toBe('string')
    expect(r.words).toBeGreaterThan(0)
    createdDocId = String(r.documentId)
  })

  it('write → 章节号冲突时报错而非重复创建', async () => {
    await expect(run('novel_write_chapter', {
      chapterNo,
      title: '重复章节',
      content: '重复内容',
    })).rejects.toThrow(/已存在/)
  })

  it('write → 给已有大纲章壳写入正文（破解死锁）', async () => {
    // 大纲工具会自动建章壳（无 docUrl），write_chapter 应当能填充而不是拒绝。
    // 见 novel_write_chapter 描述 (b) 分支。
    const shellNo = chapterNo + 50
    // 1. 先用 novel_manage_outline set_chapter_outline 建章壳
    const setOutline = await run('novel_manage_outline', {
      action: 'set_chapter_outline',
      chapterNo: shellNo,
      outline: '## 大纲要点\n1. 触发冲突场景\n2. 验证能落入正文',
      storyTime: '三年后·秋',
    })
    expect(setOutline.created).toBe(true)
    expect(typeof setOutline.recordId).toBe('string')

    // 2. 写入正文：应走「填充正文」路径而非拒绝
    const r = await run('novel_write_chapter', {
      chapterNo: shellNo,
      title: `[测试] 第${shellNo}章 死锁破除`,
      content: '## 一、起\n\n大纲落地为正文。沈砚长出一口气。\n',
    })
    expect(r.chapterNo).toBe(shellNo)
    expect(typeof r.documentId).toBe('string')
    expect(typeof r.recordId).toBe('string')

    // 3. 验证 read 能读到正文（之前 readChapter 会因无 docUrl 报错）
    const read = await run('novel_read_chapter', { chapterNo: shellNo, mode: 'full' })
    expect(read.content).toContain('大纲落地为正文')
  })

  it('read → 能读回刚写的正文', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'full' })
    expect(r.content).toContain('沈砚站在酒肆檐下')
    expect(r.words).toBeGreaterThan(0)
  })

  it('read → outline 模式可列出场景分节', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'outline' })
    // xml 格式下应为 h2 标签
    expect(String(r.content)).toMatch(/<h2|入城/)
  })

  it('read → search 模式可定位关键词', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'search', keyword: '剑' })
    expect(r.content).toBeTruthy()
  })

  it('append → 续写并回写字数', async () => {
    const before = await run('novel_read_chapter', { chapterNo, mode: 'full' })
    const r = await run('novel_append_chapter', {
      chapterNo,
      content: '## 三、尾声\n\n柳三娘擦着碗，抬眼看了他一下。\n',
    })
    expect(r.appendedWords).toBeGreaterThan(0)
    expect(r.totalWords).toBeGreaterThan(Number(before.words))
  })

  it('memory → 写入章节摘要', async () => {
    const r = await run('novel_update_summary', {
      chapterNo,
      scene: '城南酒肆',
      events: ['沈砚入城', '与柳三娘交锋'],
      endState: '线索指向城西',
    })
    expect(typeof r.recordId).toBe('string')
    expect(String(r.summaryText)).toContain('【场景】城南酒肆')
  })

  it('memory → 记录人物状态快照', async () => {
    const r = await run('novel_record_character_state', {
      chapterNo,
      character: '沈砚',
      location: '城南酒肆',
      physical: '左手旧伤未愈',
      emotion: '警惕',
    })
    expect(r.warnings).toBeDefined()
  })

  it('memory → 记录事件索引', async () => {
    const r = await run('novel_record_event', {
      chapterNo,
      name: `[测试] 事件-${chapterNo}`,
      summary: '沈砚抵达城南',
      location: '城南酒肆',
      participants: ['沈砚', '柳三娘'],
    })
    expect(typeof r.recordId).toBe('string')
  })

  it('memory → 写入卷级摘要', async () => {
    const r = await run('novel_upsert_book_summary', {
      action: 'upsert',
      level: '卷',
      title: `[测试] 卷-${chapterNo}`,
      content: '测试卷摘要',
      fromChapter: chapterNo,
      toChapter: chapterNo,
    })
    expect(typeof r.recordId).toBe('string')
  })

  it('build_context → 刚写完的章处于 L0 原文层（读全文而非摘要）', async () => {
    const r = await run('novel_build_context', { chapterNo: chapterNo + 1, presetId: 'genre' })
    // 分层规则：L0 = [N-K, N) 取原文；L1 = [N-M, N-K) 取摘要（K=3, M=12）
    // 刚写完的章距 N 只有 1 章，应落在 L0，以原文形式出现
    const recent = r.recentChapters as { no: number }[]
    expect(recent.some((c) => c.no === chapterNo)).toBe(true)
    // 且此时它不应同时出现在 L1 摘要层（避免重复注入）
    const summaries = r.chapterSummaries as { no: number }[]
    expect(summaries.some((s) => s.no === chapterNo)).toBe(false)
  })

  it('build_context → 写过几章后，该章降级为 L1 摘要层', async () => {
    // 距 N=chapterNo+5 时，该章进入 [N-12, N-3) = [chapterNo-7, chapterNo+2)，属 L1
    const r = await run('novel_build_context', { chapterNo: chapterNo + 5, presetId: 'genre' })
    const summaries = r.chapterSummaries as { no: number; summary: string }[]
    const found = summaries.find((s) => s.no === chapterNo)
    expect(found).toBeDefined()
    // 摘要内容应包含我们写入的场景
    expect(found?.summary ?? '').toContain('城南酒肆')
  })

  afterAll(async () => {
    // 清理：删除本次创建的正文文档（章节索引保留，便于人工核查）
    if (createdDocId === '') return
    try {
      const { docs } = await import('@unwr/feishu')
      // 飞书 CLI 未提供文档删除能力，改为清空内容
      await docs.appendDoc(createdDocId, '\n\n> [测试文档，可忽略]', AbortSignal.timeout(20_000))
    } catch {
      // 清理失败不影响测试结果
    }
  })
})
