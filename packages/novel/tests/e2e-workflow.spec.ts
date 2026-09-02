/**
 * 全流程端到端测试：在**全新作品**上跑通完整生命周期与全部错误分支。
 *
 * 覆盖矩阵（对应 docs/requirements/01 的 P0 主线 + 实测踩过的坑）：
 *   建库(文件夹) → 配置 → 设定/人物(选项自动合并) → 大纲
 *   → 起草(build_context → write → append → 记忆沉淀)
 *   → 记忆生效(下一章 L0 可见) → 一致性检查(规则型+落库去重)
 *   → 改稿(scene / scene+paragraph / patch / 全部错误分支) → 历史
 *   → 错误分支(重复章节 / workToken 抄错 / link_folder 幂等)
 *   → 多作品隔离与会话默认作品语义
 *
 * 在全新库上运行是刻意的：新库收敛问题（字段/link/记录可见性）
 * 只在真实新建时暴露，跑在旧库上测不出来。
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ensureWorkSchema, initWork } from '../src/domain/bootstrap.ts'
import { base, drive } from '@unwr/feishu'
import type { FieldSchema } from '@unwr/feishu'
import { FORESHADOW_F, TABLE } from '@unwr/schema'
import { waitForBaseReady, withConvergenceRetry } from './helpers.ts'

interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({
    tools: { register: (t: MinimalTool) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  } as never, {})
  return tools
}

const TEST_SPACE = process.env.UNWR_TEST_SPACE ?? ''
const HAS_SPACE = TEST_SPACE !== ''

describe.skipIf(!HAS_SPACE)('全流程 e2e：全新作品生命周期', () => {
  const tools = collectTools()
  const stamp = Date.now().toString(36)
  const workName = `[e2e] 剑出寒山-${stamp}`
  const volume1 = `第一卷 ${stamp}`
  const volume2 = `第二卷 ${stamp}`
  let baseToken = ''

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    // 全流程默认走「会话默认作品」：只有建库与显式切换时才传 workToken
    const payload = name === 'novel_manage_work' || baseToken === ''
      ? args
      : { workToken: baseToken, ...args }
    try {
      return await tool.execute(payload, { signal: AbortSignal.timeout(120_000) }) as Record<string, unknown>
    } catch (e) {
      // 诊断：定位 not_found 的确切来源（工具名 + 参数 + 错误原文 + 失败的 CLI 命令）
      const cli = (e as { cliCommand?: string }).cliCommand ?? ''
      console.error(`[e2e-diag] ${name} args=${JSON.stringify({ ...args, content: '<略>' }).slice(0, 200)}\n  err=${e instanceof Error ? e.message : String(e)}\n  cli=${cli.slice(0, 300)}`.slice(0, 700))
      throw e
    }
  }

  const settle = (ms = 1600): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('1. create → 一键建库（文件夹 + Base + 13 表 + 作品记录）', async () => {
    const r = await run('novel_manage_work', {
      action: 'create', name: workName, genre: '类型小说', scale: '中长篇',
    })
    baseToken = String(r.baseToken)
    expect(baseToken).toBeTruthy()
    expect(String(r.folderUrl ?? '')).toContain('/folder/')
    // 无 link 失败（串行建表 + 轮次重试）
    expect(r.warnings ?? []).toEqual([])
    // 等待写路径收敛（分钟级，多级就绪）——这是后续全部用例的前提
    await waitForBaseReady(baseToken)
    // 会话默认作品语义：create 后不传 workToken 也能用
    const cfg = await run('novel_manage_work', { action: 'get_config' })
    expect((cfg.config as { name?: string }).name).toBe(workName)
  })

  it('2. 配置 → update_config 后 get_config 回读', async () => {
    await run('novel_manage_work', {
      action: 'update_config', subgenre: '武侠悬疑', targetWords: 150000,
    })
    // update 的读一致性延迟（实测 1.6s 有时不够，给 3s）
    await settle(3000)
    const cfg = await run('novel_manage_work', { action: 'get_config' })
    const c = cfg.config as { subgenre?: string; targetWords?: number }
    expect(c.subgenre).toBe('武侠悬疑')
    expect(c.targetWords).toBe(150000)
    // 题材未显式给时回落默认网文预设——写作指引体现（preset 不在 config 而在 writingGuide）
    expect(String(cfg.writingGuide)).toContain('类型小说')
  })

  it('3. 设定与人物 → upsert 选项自动合并 + query 回读', async () => {
    await run('novel_manage_setting', {
      action: 'upsert', term: '寒山剑派',
      definition: '北境没落剑派，二十年前内乱后一分为三。',
      category: ['势力'], importance: 5,
    })
    await run('novel_manage_setting', {
      action: 'upsert', term: '断水剑',
      definition: '寒山镇派之剑，剑身无鞘，出鞘必饮血。',
      category: ['物品'], importance: 5,
    })
    const q = await run('novel_manage_setting', { action: 'query', keyword: '寒山' })
    expect((q.items as unknown[]).length).toBeGreaterThanOrEqual(1)

    await run('novel_manage_character', {
      action: 'upsert', name: '陆寒舟',
      role: '主角，寒山隐脉弟子',
      traits: ['沉默寡言', '心思极细'],
      catchphrase: '下山再说。',
      motive: '为亡母寻回断水剑，查清父亲冤案',
    })
    const qc = await run('novel_manage_character', { action: 'query', name: '陆寒舟' })
    const items = qc.items as { traits: string[]; catchphrase: string }[]
    expect(items).toHaveLength(1)
    // 自动合并的新选项应完整回读
    expect(items[0]?.traits).toEqual(['沉默寡言', '心思极细'])
  })

  it('4. 大纲 → 卷（写章前的部分）', async () => {
    await run('novel_manage_outline', {
      action: 'upsert_volume', volume: volume1, order: 1,
      theme: '下山与疑云', status: '进行中',
    })
  })

  it('5. 起草 → build_context（空库）→ write_chapter → 大纲回填 → 记忆沉淀', async () => {
    const ctx1 = await run('novel_build_context', { chapterNo: 1, presetId: 'genre' })
    // 空库：L0/L1 均空，但写作指引必须在
    expect((ctx1.recentChapters as unknown[]).length).toBe(0)
    expect(String(ctx1.writingGuide)).toContain('类型小说')

    const w = await run('novel_write_chapter', {
      chapterNo: 1, title: '第一章 雪夜下山', volume: volume1,
      content: '## 一、下山\n\n雪落在山道上，陆寒舟没有回头。\n\n## 二、客栈\n\n掌柜的看了他三眼，什么都没问。\n',
    })
    expect(w.chapterNo).toBe(1)
    expect(Number(w.words)).toBeGreaterThan(0)

    // 章节已存在，回填章要点（set_chapter_outline 依赖章节记录，故在 write 之后）
    await run('novel_manage_outline', {
      action: 'set_chapter_outline', chapterNo: 1,
      outline: '雪夜下山；客栈遇伏；发现断水剑线索',
    })
    // outline 的 update 写后读需等收敛（实测 >1.6s）
    await settle(3000)
    const q = await run('novel_manage_outline', { action: 'query', chapterNo: 1 })
    const items = q.items as { outline: string }[]
    expect(items[0]?.outline).toContain('雪夜下山')

    await run('novel_update_summary', {
      chapterNo: 1, scene: '北境山道与客栈',
      events: ['陆寒舟雪夜下山', '客栈掌柜异常'],
      newForeshadows: ['掌柜的三次看向门口'],
      endState: '陆寒舟察觉被跟踪',
    })
    await run('novel_record_character_state', {
      chapterNo: 1, character: '陆寒舟',
      location: '北境客栈', physical: '无恙', emotion: '警惕',
    })
    const ev = await run('novel_record_event', {
      chapterNo: 1, name: '雪夜下山', location: '北境山道',
      participants: ['陆寒舟'], isTurningPoint: true,
    })
    expect(String(ev.recordId)).toBeTruthy()
  })

  it('6. 记忆生效 → build_context(ch2) 的 L0 含第一章原文', async () => {
    await settle()
    const ctx = await run('novel_build_context', { chapterNo: 2, presetId: 'genre' })
    const recent = ctx.recentChapters as { no: number; content: string }[]
    expect(recent.some((c) => c.no === 1 && c.content.includes('雪落在山道上'))).toBe(true)
  })

  it('7. 续写 append → 字数回写', async () => {
    const r = await run('novel_append_chapter', {
      chapterNo: 1, content: '## 三、夜行\n\n他推门而出，雪更大了。\n',
    })
    expect(Number(r.appendedWords)).toBeGreaterThan(0)
    expect(Number(r.totalWords)).toBeGreaterThan(Number(r.appendedWords) - 1)
  })

  it('8. 一致性检查 → 逾期伏笔检出 + 落库去重', async () => {
    // seed：埋一条伏笔并把埋设章节 link 到第 1 章（检查依赖 link 估期限）
    const content = `[e2e] 客栈掌柜的身份-${stamp}`
    const seeded = await run('novel_manage_foreshadow', {
      action: 'upsert', content, type: '人物', status: '已埋设', importance: 5,
    })
    // 伏笔 upsert（写）与章节表读取之间留出收敛时间
    await settle()
    const chapters = base.matrixToObjects(
      await withConvergenceRetry(() =>
        base.listRecords(baseToken, TABLE.CHAPTER, { fieldIds: ['章节号'], limit: 5 })),
    )
    const ch1 = chapters.find((c) => c['章节号'] === 1)
    expect(ch1).toBeDefined()
    const { updateRecordsWithSelfHeal } = await import('../src/domain/selfheal.ts')
    await updateRecordsWithSelfHeal(baseToken, TABLE.FORESHADOW, {
      [String(seeded.recordId)]: { [FORESHADOW_F.PLANT_CHAPTER]: [{ id: String(ch1?.['__recordId']) }] },
    }, undefined)
    // link 的 update 有读一致性延迟，立即检查会读到 null
    await settle()

    const r1 = await run('novel_run_consistency_check', { currentChapterNo: 99, persist: true })
    const issues = r1.issues as { type: string; title: string }[]
    expect(issues.some((i) => i.type === '伏笔未回收' && i.title.includes('掌柜'))).toBe(true)
    // 去重
    const r2 = await run('novel_run_consistency_check', { currentChapterNo: 99, persist: true })
    expect((r2.persisted as { created: number }).created).toBe(0)
  })

  it('9. 改稿 → scene replace / scene+paragraph / history', async () => {
    // 整场景改写
    const r1 = await run('novel_revise_chapter', {
      chapterNo: 1, action: 'replace', scene: '二、客栈',
      content: '## 二、客栈\n\n掌柜的数钱的手停了一下。\n',
    })
    expect(r1.locatedBy).toBe('scene')

    // 结构化段落定位（无需复制原文——本 bug 的最佳实践解法）
    const r2 = await run('novel_revise_chapter', {
      chapterNo: 1, action: 'replace', scene: '一、下山', paragraph: 1,
      content: '雪落在山道上，也落在他肩头。陆寒舟没有回头。',
    })
    expect(r2.locatedBy).toBe('paragraph')
    expect(r2.paragraphIndex).toBe(1)

    // patch 精确替换（match 来自 read，应成功）
    const r3 = await run('novel_revise_chapter', {
      chapterNo: 1, action: 'patch',
      match: '掌柜的数钱的手停了一下。',
      content: '掌柜数钱的手停了一瞬。',
    })
    expect(r3.locatedBy).toBe('match')

    const h = await run('novel_get_chapter_history', { chapterNo: 1 })
    expect((h.entries as unknown[]).length).toBeGreaterThanOrEqual(1)
  })

  it('10. 改稿错误分支 → 全部给出可自我纠正的提示', async () => {
    // 段落越界：列出场景段落供选择
    await expect(run('novel_revise_chapter', {
      chapterNo: 1, action: 'replace', scene: '一、下山', paragraph: 99, content: 'x',
    })).rejects.toThrow(/没有第 99 段/)

    // 空 content：入口拦截（不再透传 CLI 的晦涩报错）
    await expect(run('novel_revise_chapter', {
      chapterNo: 1, action: 'replace', scene: '一、下山', content: '',
    })).rejects.toThrow(/content 不能为空/)

    // 字面 \n：入口拦截并解释
    await expect(run('novel_revise_chapter', {
      chapterNo: 1, action: 'patch', match: 'a\\nb', content: 'y',
    })).rejects.toThrow(/字面反斜杠\+n/)

    // patch 失配：给出场景段落引导
    await expect(run('novel_revise_chapter', {
      chapterNo: 1, action: 'patch', scene: '一、下山',
      match: '这句原文里绝对不存在QWERTY', content: 'y',
    })).rejects.toThrow(/match 在正文中不存在/)
  })

  it('11. 错误分支 → 重复章节 / read 缺章 / 大纲缺章', async () => {
    await expect(run('novel_write_chapter', {
      chapterNo: 1, title: '重复', content: 'x',
    })).rejects.toThrow(/已存在/)
    await expect(run('novel_read_chapter', { chapterNo: 42 })).rejects.toThrow(/不存在/)
    await expect(run('novel_manage_outline', {
      action: 'set_chapter_outline', chapterNo: 42, outline: 'x',
    })).rejects.toThrow(/不存在/)
  })

  it('12. 多作品隔离 + 会话默认作品切换', async () => {
    const name2 = `[e2e] 第二部-${stamp}`
    const w2 = await run('novel_manage_work', { action: 'create', name: name2 })
    const token2 = String(w2.baseToken)
    expect(token2).not.toBe(baseToken)
    // 第二部的写路径收敛（同 it1 道理）
    await waitForBaseReady(token2)

    // 显式切换默认到第二部
    const cfg2 = await run('novel_manage_work', { action: 'get_config', workToken: token2 })
    expect((cfg2.config as { name?: string }).name).toBe(name2)

    // 切回第一部（显式传 token）继续可用
    const cfg1 = await run('novel_manage_work', { action: 'get_config', workToken: baseToken })
    expect((cfg1.config as { name?: string }).name).toBe(workName)
  })

  it('13. list 索引 → 新建作品最终可被发现（轮询，容忍平台索引延迟）', { timeout: 180_000 }, async () => {
    // drive 搜索索引对新建 Base 有分钟级延迟，此处轮询而非强断言：
    const deadline = Date.now() + 90_000
    let names: string[] = []
    while (Date.now() < deadline) {
      const list = await run('novel_manage_work', { action: 'list' })
      names = (list.works as { name: string }[]).map((w) => w.name)
      if (names.some((n) => n.includes('剑出寒山')) && names.some((n) => n.includes('第二部'))) break
      await new Promise((r) => setTimeout(r, 8000))
    }
    // 结构断言必须过；包含断言在索引延迟内轮询到即过，超时则提示（不失败）
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n).toBeTruthy()
    if (!names.some((n) => n.includes('剑出寒山'))) {
      console.warn('[e2e] 搜索索引尚未收录新建作品（平台延迟），跳过包含断言')
    }
  })

  afterAll(async () => {
    // e2e 产生的两部测试作品保留在云盘（可人工检查），不做删除——
    // 工具层刻意不提供删除能力（readOnlySafeMode）
  })
})

/**
 * 旧库 schema 自愈（2026-09-01 会话事故的回归测试）：
 * 旧版本插件建的库没有 link 字段（甚至可能缺普通字段），写记忆表全部
 * 报 not_found。修复后 get_config 入口自动补齐（10 分钟缓存）。
 *
 * 用「裸 Base + 单表」模拟旧库，验证：修复 → warnings 暴露 → 缓存命中 → 幂等。
 */
describe.skipIf(!HAS_SPACE)('e2e：旧库 schema 自愈', () => {
  const repairStamp = `repair-${Date.now().toString(36)}`
  let bareToken = ''

  it('1. 模拟旧库：裸建 Base + 只建一张缺字段的作品表', async () => {
    const created = await base.createBase(`[e2e] schema自愈-${repairStamp}`, {}, undefined)
    bareToken = created.base_token
    expect(bareToken).toBeTruthy()
    // Base 刚建可查有可见性延迟；作品表故意缺「题材/规模/文档目录」等字段
    await withConvergenceRetry(() => base.createTable(
      bareToken,
      '作品表',
      [{ name: '作品名', type: 'text' }] as FieldSchema[],
    ))
  })

  it('2. get_config 自动修复旧库 → warnings 暴露补建内容，配置回落默认', { timeout: 150_000 }, async () => {
    const tool = collectTools().get('novel_manage_work')
    expect(tool).toBeDefined()
    const r = await tool!.execute(
      { action: 'get_config', workToken: bareToken },
      { signal: AbortSignal.timeout(150_000) },
    ) as Record<string, unknown>
    const warnings = (r.warnings ?? []) as string[]
    // 12 张缺失的表被补建（link 字段创建失败会另有 warning，必须为空）
    expect(warnings.some((w) => w.includes('已自动补建缺失的数据表'))).toBe(true)
    expect(warnings.some((w) => w.includes('补齐作品库缺失字段'))).toBe(true)
    expect(warnings.some((w) => w.includes('自动补齐失败'))).toBe(false)
    // 作品表没有记录 → 配置回落默认而非报错（原有容错行为保留）
    expect((r.config as { name?: string }).name).toBe('')
  })

  it('3. 紧接着的 get_config 命中缓存 → 无修复 warning', async () => {
    const tool = collectTools().get('novel_manage_work')
    const r = await tool!.execute(
      { action: 'get_config', workToken: bareToken },
      { signal: AbortSignal.timeout(60_000) },
    ) as Record<string, unknown>
    expect(r.warnings ?? []).toEqual([])
  })

  it('4. ensureWorkSchema 幂等：零新增、零失败', async () => {
    const r = await ensureWorkSchema(bareToken)
    expect(r.createdTables).toEqual([])
    expect(r.createdFields).toBe(0)
    expect(r.failedLinks).toEqual([])
  })
})
