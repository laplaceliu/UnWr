/**
 * 实体管理（设定/人物/大纲/伏笔/剧情线/分支）与作品管理工具的测试。
 *
 * 端到端用 upsert 的幂等性验证：同一 key 写两次，第二次应 updated=true。
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'
import { maxChapterNo } from '../src/domain/chapter.ts'

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
const STAMP = Date.now().toString(36)

describe('工具注册', () => {
  it('注册了全部实体与作品管理工具', () => {
    const names = [...collectTools().keys()]
    expect(names).toEqual(expect.arrayContaining([
      'novel_manage_setting',
      'novel_manage_character',
      'novel_manage_outline',
      'novel_manage_foreshadow',
      'novel_manage_plotline',
      'novel_manage_branch',
      'novel_manage_work',
    ]))
  })

  it('manage_work 的 action 枚举正确', () => {
    const tool = collectTools().get('novel_manage_work')
    const params = tool?.parameters as {
      properties?: { action?: { enum?: string[] } }
    } | undefined
    expect(params?.properties?.action?.enum).toEqual([
      'list', 'create', 'get_config', 'update_config', 'link_folder',
    ])
  })

  it('upsert 类工具缺关键参数时给出明确错误', async () => {
    const tool = collectTools().get('novel_manage_setting')
    if (tool === undefined) throw new Error('未注册')
    await expect(tool.execute(
      { workToken: 'x', action: 'upsert' },
      { signal: AbortSignal.timeout(10_000) },
    )).rejects.toThrow(/term/)
  })
})

describe.skipIf(!HAS_BASE)('端到端：真实飞书', () => {
  const tools = collectTools()
  let chapterNo = 0

  beforeAll(async () => {
    if (!HAS_BASE) return
    await waitForBaseReady(TEST_BASE !== '' ? TEST_BASE : baseToken)
    chapterNo = await maxChapterNo(TEST_BASE) + 300 + Math.floor(Math.random() * 50)
  })

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    return await tool.execute({ workToken: TEST_BASE, ...args }, {
      signal: AbortSignal.timeout(50_000),
    }) as Record<string, unknown>
  }

  /**
   * 等待飞书 Base 的读一致性收敛（实测约 1 秒）。
   * 「写操作后立即查询断言」的用例必须先调用本函数，
   * 否则会间歇性读到旧值（有时索引先就绪就通过，有时不就绪就失败）。
   */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 1500))

  it('setting → upsert 创建后再次 upsert 为更新', async () => {
    const term = `[测试] 设定-${STAMP}`
    const r1 = await run('novel_manage_setting', {
      action: 'upsert', term, definition: '初版定义', importance: 3,
    })
    expect(r1.updated).toBe(false)

    const r2 = await run('novel_manage_setting', {
      action: 'upsert', term, definition: '修订后的定义', importance: 4,
    })
    expect(r2.updated).toBe(true)
    expect(r2.recordId).toBe(r1.recordId)

    // 注意：飞书 Base 的**更新**同样有读一致性延迟（约 1 秒），
    // 立即查询会读到旧值。这里等待后查询，属测试对最终一致性的适配。
    await new Promise((r) => setTimeout(r, 1500))

    // 查询应能看到新定义
    const q = await run('novel_manage_setting', { action: 'query', keyword: term })
    const items = q.items as { term: string; definition: string; importance: number }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.definition).toBe('修订后的定义')
    expect(items[0]?.importance).toBe(4)
  })

  it('character → upsert 并按姓名查询', async () => {
    const name = `[测试] 人物-${STAMP}`
    await run('novel_manage_character', {
      action: 'upsert', name,
      role: '测试角色',
      traits: ['外冷内热', '隐忍'],
      catchphrase: '……罢了',
      motive: '验证 upsert 语义',
    })
    await settle()
    const q = await run('novel_manage_character', { action: 'query', name })
    const items = q.items as { name: string; traits: string[]; catchphrase: string }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.traits).toEqual(['外冷内热', '隐忍'])
    expect(items[0]?.catchphrase).toBe('……罢了')
  })

  it('outline → 先建章再写大纲，查询可读回', async () => {
    // 建一章
    const w = await run('novel_write_chapter', {
      chapterNo,
      title: `[测试] 第${chapterNo}章 大纲对象`,
      content: '## 一\n\n占位正文。\n',
    })
    expect(w.chapterNo).toBe(chapterNo)

    await run('novel_manage_outline', {
      action: 'set_chapter_outline',
      chapterNo,
      outline: `三幕结构-${STAMP}`,
    })
    await settle()
    const q = await run('novel_manage_outline', { action: 'query', chapterNo })
    const items = q.items as { no: number; outline: string }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.outline).toContain(STAMP)
  })

  it('foreshadow → upsert 与按状态查询', async () => {
    const content = `[测试] 伏笔-${STAMP}`
    await run('novel_manage_foreshadow', {
      action: 'upsert', content, type: '主线', status: '已埋设', importance: 4,
    })
    await settle()
    const q = await run('novel_manage_foreshadow', { action: 'query', status: '已埋设' })
    const items = q.items as { content: string }[]
    expect(items.some((i) => i.content === content)).toBe(true)
  })

  it('plotline 与 branch → upsert 后可查询', async () => {
    await run('novel_manage_plotline', {
      action: 'upsert', name: `[测试] 主线-${STAMP}`,
      type: '主线', status: '推进', description: '测试',
    })
    await settle()
    const qp = await run('novel_manage_plotline', { action: 'query', type: '主线' })
    expect((qp.items as { name: string }[]).some((i) => i.name.includes(STAMP))).toBe(true)

    const branch = `[测试] 分支-${STAMP}`
    await run('novel_manage_branch', {
      action: 'upsert', title: branch,
      description: '分支 A：强攻', adoptStatus: '候选',
    })
    await settle()
    const qb = await run('novel_manage_branch', { action: 'query', adoptStatus: '候选' })
    expect((qb.items as { title: string }[]).some((i) => i.title === branch)).toBe(true)
  })

  it('work → get_config 返回配置与写作指引', async () => {
    const r = await run('novel_manage_work', { action: 'get_config', workToken: TEST_BASE })
    const cfg = r.config as Record<string, unknown>
    expect(typeof cfg).toBe('object')
    const guide = r.writingGuide as string
    expect(guide).toContain('题材')
    expect(guide).toContain('目标字数')
  })

  it('work → list 返回含测试库', async () => {
    const r = await run('novel_manage_work', { action: 'list' })
    const works = r.works as { baseToken: string }[]
    expect(works.length).toBeGreaterThan(0)
    expect(works.some((w) => w.baseToken === TEST_BASE)).toBe(true)
  })

  it('set_chapter_outline → 章节不存在时自动建章壳', async () => {
    // 大纲官先规划整卷章纲是自然工作流（实机 2026-09-02：强制"先建章"
    // 曾让批量章纲全部被拒）。缺失章节自动创建壳（状态=大纲）。
    const no = chapterNo + 500
    const r = await run('novel_manage_outline', {
      action: 'set_chapter_outline', chapterNo: no, outline: `自动建章-${STAMP}`,
    })
    expect((r as { created?: boolean }).created).toBe(true)
    // 二次写入同一章 = 更新，不再新建
    const r2 = await run('novel_manage_outline', {
      action: 'set_chapter_outline', chapterNo: no, outline: `v2-${STAMP}`,
    })
    expect((r2 as { created?: boolean }).created).toBe(false)
    expect((r2 as { recordId?: string }).recordId).toBe((r as { recordId?: string }).recordId)
  })
})
