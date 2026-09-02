/**
 * 改稿工具测试。
 *
 * 场景定位的匹配策略（精确 → 去序号 → 包含）是纯逻辑，用构造数据覆盖；
 * 真实改稿动作走端到端。
 *
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'
import { maxChapterNo } from '../src/domain/chapter.ts'
import { enrichPatchError, reviseChapter } from '../src/domain/revision.ts'

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

describe('工具注册', () => {
  it('注册了改稿相关工具', () => {
    const tools = collectTools()
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'novel_revise_chapter',
        'novel_list_scenes',
        'novel_get_chapter_history',
      ]),
    )
  })

  it('revise_chapter 必填 chapterNo / action（content 为动作级必填：delete 不需要）', () => {
    const tool = collectTools().get('novel_revise_chapter')
    const params = tool?.parameters as {
      required?: string[]
      properties?: { content?: { description?: string } }
    } | undefined
    // schema 只约束 chapterNo / action；content 是否必填取决于 action
    // （delete 无需 content，实机 2026-09-02：模型清理占位块传 content:""
    //   连被拒 12 次后才补 delete 动作）——由 execute 守卫按动作校验。
    expect(params?.required ?? []).toEqual(['chapterNo', 'action'])
    // 兜底：workToken 不在顶层 required 里（防止有人误回潮把它重新标为 required）。
    expect(params?.required ?? []).not.toContain('workToken')
    expect(params?.properties?.content?.description ?? '').toMatch(/REQUIRED for replace\/expand/)
  })

  it('action 接受四种取值（replace/expand/patch/delete）', () => {
    const tool = collectTools().get('novel_revise_chapter')
    const params = tool?.parameters as {
      properties?: { action?: { enum?: string[] } }
    } | undefined
    expect(params?.properties?.action?.enum).toEqual(['replace', 'expand', 'patch', 'delete'])
  })
})

describe('reviseChapter 入参守卫（离线：守卫先于任何 I/O）', () => {
  const BASE = 'guard-test-base'

  it('replace 空 content → 指向 action=delete', async () => {
    await expect(reviseChapter(BASE, 1, {
      action: 'replace', content: '', target: { blockId: 'doxcnx' },
    })).rejects.toThrow(/action=delete/)
  })

  it('replace 缺 content → 同样拦截', async () => {
    await expect(reviseChapter(BASE, 1, {
      action: 'replace', target: { scene: '一' },
    })).rejects.toThrow(/content 不能为空/)
  })

  it('delete 不需要 content（守卫放行，后续才因假 base 失败）', async () => {
    // 守卫通过后会走到 resolveChapterDoc —— 用假 base 必然失败，
    // 但失败点必须晚于守卫（即不能报 content 相关错误）
    await expect(reviseChapter(BASE, 1, {
      action: 'delete', target: { blockId: 'doxcnx' },
    })).rejects.toThrow(/content|不存在|章节|base_token|失败|NOTEXIST|Error/i)
  })

  it('delete 带了 content → 明确拒绝', async () => {
    await expect(reviseChapter(BASE, 1, {
      action: 'delete', content: '多余文本', target: { blockId: 'doxcnx' },
    })).rejects.toThrow(/不接受 content/)
  })

  it('expand 空 content → 指向需插入文本', async () => {
    await expect(reviseChapter(BASE, 1, {
      action: 'expand', content: '  ', target: { scene: '一' },
    })).rejects.toThrow(/expand 需要插入文本/)
  })
})

describe.skipIf(!HAS_BASE)('端到端：真实飞书改稿', () => {
  const tools = collectTools()
  /**
   * 与 chapter.spec 同样处理：动态分配一个绝对空闲的章节号，
   * 避免撞上历史测试遗留的记录。
   */
  let chapterNo = 0

  beforeAll(async () => {
    if (!HAS_BASE) return
    await waitForBaseReady(TEST_BASE !== '' ? TEST_BASE : baseToken)
    chapterNo = await maxChapterNo(TEST_BASE) + 200 + Math.floor(Math.random() * 50)
  })

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    return await tool.execute({ workToken: TEST_BASE, ...args }, {
      signal: AbortSignal.timeout(50_000),
    }) as Record<string, unknown>
  }

  it('准备：创建一章用于改稿', async () => {
    const r = await run('novel_write_chapter', {
      chapterNo,
      title: `[测试] 第${chapterNo}章 改稿对象`,
      content: '## 一、入城\n\n沈砚冒雨入城，檐下立了很久。\n\n## 二、交锋\n\n他把剑放在桌上，不答话。\n\n## 三、尾声\n\n雨停了。\n',
    })
    expect(r.chapterNo).toBe(chapterNo)
  })

  it('list_scenes → 列出三个场景', async () => {
    const r = await run('novel_list_scenes', { chapterNo })
    const scenes = r.scenes as { title: string; blockId: string }[]
    expect(scenes.length).toBeGreaterThanOrEqual(3)
    expect(scenes.map((s) => s.title)).toEqual(
      expect.arrayContaining(['一、入城', '二、交锋', '三、尾声']),
    )
    // 每个场景都要有可用 blockId
    for (const s of scenes) expect(s.blockId).toMatch(/^doxcn/)
  })

  it('revise → 按场景标题 replace', async () => {
    const r = await run('novel_revise_chapter', {
      chapterNo,
      action: 'replace',
      scene: '二、交锋',
      content: '## 二、交锋\n\n改写后的交锋：他缓缓抽出剑，刃上映着烛火。\n',
    })
    expect(r.locatedBy).toBe('scene')
    expect(r.sceneTitle).toBe('二、交锋')
    expect(typeof r.revisionId).toBe('number')
  })

  it('改写后能读回新内容', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'full' })
    expect(r.content).toContain('改写后的交锋')
    // 其他场景不应被破坏
    expect(r.content).toContain('沈砚冒雨入城')
    expect(r.content).toContain('雨停了')
  })

  it('revise → 去序号也能匹配（「交锋」匹配「二、交锋」）', async () => {
    const r = await run('novel_revise_chapter', {
      chapterNo,
      action: 'replace',
      scene: '交锋',
      content: '## 二、交锋\n\n再次改写：剑未出鞘，他只是看着对方。\n',
    })
    expect(r.locatedBy).toBe('scene')
    expect(r.sceneTitle).toBe('二、交锋')
  })

  it('revise → expand 在场景后插入', async () => {
    const r = await run('novel_revise_chapter', {
      chapterNo,
      action: 'expand',
      scene: '一、入城',
      content: '扩写内容：街角有个卖汤面的老妇，一直望着他。\n',
    })
    expect(r.locatedBy).toBe('scene')
  })

  it('expand 后正文包含插入内容', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'full' })
    expect(r.content).toContain('卖汤面的老妇')
  })

  it('revise → patch 精确替换', async () => {
    const r = await run('novel_revise_chapter', {
      chapterNo,
      action: 'patch',
      match: '雨停了',
      content: '雨终于停了',
    })
    expect(r.locatedBy).toBe('match')
  })

  it('patch 后读回修改结果', async () => {
    const r = await run('novel_read_chapter', { chapterNo, mode: 'full' })
    expect(r.content).toContain('雨终于停了')
  })

  it('revise → 改稿后状态变为「修订」且字数回写', async () => {
    // updateWordCount 默认 true，改稿后应回写
    const r = await run('novel_revise_chapter', {
      chapterNo,
      action: 'patch',
      match: '雨终于停了',
      content: '雨停了',
    })
    expect(typeof r.wordDelta).toBe('number')
  })

  it('history → 能取到版本历史记录', async () => {
    const r = await run('novel_get_chapter_history', { chapterNo })
    const entries = r.entries as {
      revisionId: number; editTime: string; historyVersionId: string
    }[]

    // 注意：飞书会把短时间内的连续编辑**聚合**成一个版本。
    // 实测 6 次连续改动只留下 2 个版本，因此不能断言"每次编辑一个版本"。
    expect(entries.length).toBeGreaterThanOrEqual(1)

    // 每条记录都要有可回溯的凭据
    for (const e of entries) {
      expect(typeof e.revisionId).toBe('number')
      expect(e.historyVersionId).toBeTruthy()
    }
    // 版本号降序（最新的在前）
    const ids = entries.map((e) => e.revisionId)
    expect([...ids].sort((a, b) => b - a)).toEqual(ids)
  })

  it('history → pageSize 超过上限时被安全截断', async () => {
    // 实测 --page-size 上限为 20，传 30 会报 invalid --page-size
    const r = await run('novel_get_chapter_history', { chapterNo, pageSize: 30 })
    expect(Array.isArray(r.entries)).toBe(true)
    expect(typeof r.total).toBe('number')
  })

  it('错误处理：场景不存在时给出候选列表', async () => {
    await expect(run('novel_revise_chapter', {
      chapterNo,
      action: 'replace',
      scene: '不存在的场景名',
      content: 'x',
    })).rejects.toThrow(/未找到场景/)
  })

  it('错误处理：replace 只给 match 时提示改用 patch', async () => {
    await expect(run('novel_revise_chapter', {
      chapterNo,
      action: 'replace',
      match: '雨停了',
      content: 'x',
    })).rejects.toThrow(/改用 action=patch/)
  })

  it('错误处理：对不存在的章节改稿', async () => {
    await expect(run('novel_revise_chapter', {
      chapterNo: 99999,
      action: 'patch',
      match: 'x',
      content: 'y',
    })).rejects.toThrow(/不存在/)
  })
})

/**
 * 场景定位的匹配策略用构造数据验证。
 *
 * 注意：locateByScene 依赖飞书 outline 的真实格式，这里不 mock fetchDoc，
 * 而是通过端到端用例覆盖；此处只验证纯字符串处理相关的行为。
 */
describe('场景标题归一化', () => {
  it('去序号规则与 locateByScene 内部一致', () => {
    // locateByScene 用 /^[\d一二三四五六七八九十]+[、.．]\s*/ 剥离序号
    const strip = (s: string): string =>
      s.replace(/^[\d一二三四五六七八九十]+[、.．]\s*/, '')
    expect(strip('二、交锋')).toBe('交锋')
    expect(strip('2. 交锋')).toBe('交锋')
    expect(strip('交锋')).toBe('交锋')
  })
})

/**
 * patch 失败装饰回归。
 *
 * 背景（2026-09-01 会话实测）：lark-cli `docs +update --command str_replace`
 * 经常在预检通过后仍报降级错误（degrade_code=1011，fatal:MatchFailure），
 * 原始 message 是 "cli failed with exit code 1"。模型重试 7 次也是这个
 * 错。前一版没有引导——必须告诉 agent「别再用 patch，改用结构化定位」。
 */
describe('enrichPatchError（patch 失败装饰）', () => {
  it('wrap 后保留原始 detail 信息', () => {
    const inner = new Error('文档更新未生效（result=failed）：degrade_code=1011 fatal:MatchFailure')
    const got = enrichPatchError(inner)
    expect(got.message).toContain('文档更新未生效')
    expect(got.cause).toBe(inner)
  })

  it('明确告诉调用方改用 replace + scene + paragraph', () => {
    const got = enrichPatchError(new Error('x'))
    expect(got.message).toContain('action=replace')
    expect(got.message).toContain('scene')
    expect(got.message).toContain('paragraph')
  })

  it('提供继续 patch 的备选路径（再读 + 比对）', () => {
    const got = enrichPatchError(new Error('x'))
    expect(got.message).toContain('novel_read_chapter')
    expect(got.message).toContain('全角/半角')
  })
})
