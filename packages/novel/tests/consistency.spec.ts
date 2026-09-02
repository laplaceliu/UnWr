/**
 * 一致性检查测试。
 *
 * 纯函数部分用构造数据覆盖判定逻辑（不依赖飞书，可反复跑）；
 * 端到端部分验证真实库上的调用与落库。
 *
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'
import {
  checkForeshadows, checkPresence, checkTimeline,
} from '../src/domain/consistency.ts'

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

/* ------------------------------------------------------------------ */
/* 纯函数：H3 伏笔未回收                                                */
/* ------------------------------------------------------------------ */

describe('H3 伏笔未回收（纯函数）', () => {
  const titles = new Map([[1, '第一章'], [5, '第五章'], [10, '第十章']])

  it('逾期伏笔被检出', () => {
    const issues = checkForeshadows(
      [{ '伏笔内容': '剑谱下落', '状态': ['已埋设'], '重要度': 5, '计划回收章节': ['第五章'] }],
      titles, new Map(), 12, 3,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.type).toBe('伏笔未回收')
    expect(issues[0]?.severity).toBe(5)
    expect(issues[0]?.location).toContain('逾期')
  })

  it('在容差内不算逾期', () => {
    const issues = checkForeshadows(
      [{ '伏笔内容': '剑谱下落', '状态': ['已埋设'], '重要度': 5, '计划回收章节': ['第十章'] }],
      titles, new Map(), 12, 3,
    )
    expect(issues).toHaveLength(0)
  })

  it('已回收的伏笔不检出', () => {
    const issues = checkForeshadows(
      [{ '伏笔内容': '剑谱下落', '状态': ['已回收'], '重要度': 5, '计划回收章节': ['第五章'] }],
      titles, new Map(), 12, 3,
    )
    expect(issues).toHaveLength(0)
  })

  it('无计划回收章节时，按埋设章 + 20 章默认窗口估算', () => {
    // 埋设于第 1 章，默认窗口 20 → 第 21 章到期；当前 25 章应检出
    const issues = checkForeshadows(
      [{ '伏笔内容': '师门惨案', '状态': ['已埋设'], '重要度': 4, '埋设章节': ['第一章'] }],
      titles, new Map(), 25, 3,
    )
    expect(issues).toHaveLength(1)
  })

  it('重要度高的排前面', () => {
    const issues = checkForeshadows(
      [
        { '伏笔内容': '次要', '状态': ['已埋设'], '重要度': 2, '计划回收章节': ['第一章'] },
        { '伏笔内容': '关键', '状态': ['已埋设'], '重要度': 5, '计划回收章节': ['第一章'] },
      ],
      titles, new Map(), 30, 0,
    )
    expect(issues[0]?.title).toContain('关键')
    expect(issues[1]?.title).toContain('次要')
  })
})

/* ------------------------------------------------------------------ */
/* 纯函数：H5 人物方位与状态                                            */
/* ------------------------------------------------------------------ */

describe('H5 人物方位与状态（纯函数）', () => {
  const titles = new Map([[1, '第一章'], [2, '第二章'], [3, '第三章']])

  it('相邻章位置变化被检出，且置信度为启发式 0.6', () => {
    const issues = checkPresence(
      [
        { '人物': '沈砚', '章节': ['第一章'], '所在位置': '城南', '身体状况': '无恙', '持有物品': '' },
        { '人物': '沈砚', '章节': ['第二章'], '所在位置': '城西', '身体状况': '无恙', '持有物品': '' },
      ],
      titles,
    )
    const locationIssue = issues.find((i) => i.title.includes('位置'))
    expect(locationIssue).toBeDefined()
    expect(locationIssue?.confidence).toBe(0.6)
  })

  it('位置未变不检出', () => {
    const issues = checkPresence(
      [
        { '人物': '沈砚', '章节': ['第一章'], '所在位置': '城南', '身体状况': '无恙', '持有物品': '' },
        { '人物': '沈砚', '章节': ['第二章'], '所在位置': '城南', '身体状况': '无恙', '持有物品': '' },
      ],
      titles,
    )
    expect(issues.filter((i) => i.title.includes('位置'))).toHaveLength(0)
  })

  it('短时间内伤势消失被检出', () => {
    const issues = checkPresence(
      [
        { '人物': '沈砚', '章节': ['第一章'], '所在位置': '', '身体状况': '左手重伤', '持有物品': '' },
        { '人物': '沈砚', '章节': ['第二章'], '所在位置': '', '身体状况': '行动如常', '持有物品': '' },
      ],
      titles,
    )
    const injury = issues.find((i) => i.title.includes('伤势'))
    expect(injury).toBeDefined()
    expect(injury?.severity).toBe(3)
  })

  it('伤势持续存在不检出', () => {
    const issues = checkPresence(
      [
        { '人物': '沈砚', '章节': ['第一章'], '所在位置': '', '身体状况': '左手重伤', '持有物品': '' },
        { '人物': '沈砚', '章节': ['第二章'], '所在位置': '', '身体状况': '伤势未愈', '持有物品': '' },
      ],
      titles,
    )
    expect(issues.filter((i) => i.title.includes('伤势'))).toHaveLength(0)
  })

  it('不同人物分别检查，不互相污染', () => {
    const issues = checkPresence(
      [
        { '人物': '沈砚', '章节': ['第一章'], '所在位置': '城南', '身体状况': '', '持有物品': '' },
        { '人物': '柳三娘', '章节': ['第一章'], '所在位置': '酒肆', '身体状况': '', '持有物品': '' },
        { '人物': '沈砚', '章节': ['第二章'], '所在位置': '城南', '身体状况': '', '持有物品': '' },
        { '人物': '柳三娘', '章节': ['第二章'], '所在位置': '酒肆', '身体状况': '', '持有物品': '' },
      ],
      titles,
    )
    expect(issues).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 纯函数：H4 时间线                                                    */
/* ------------------------------------------------------------------ */

describe('H4 时间线矛盾（纯函数）', () => {
  const titles = new Map([[1, '第一章'], [2, '第二章'], [3, '第三章']])

  it('故事内时间倒退被检出', () => {
    // 用字典序明确的标记，避免中文数字排序带来的歧义
    const issues = checkTimeline(
      [
        { '事件名': '出师', '章节': ['第一章'], '故事内时间': 'T3' },
        { '事件名': '入门', '章节': ['第二章'], '故事内时间': 'T1' },
      ],
      titles,
    )
    expect(issues).toHaveLength(1)
    // 置信度低（依赖文本排序）
    expect(issues[0]?.confidence).toBe(0.5)
  })

  it('时间顺序正常时不检出', () => {
    const issues = checkTimeline(
      [
        { '事件名': '甲', '章节': ['第一章'], '故事内时间': 'T1' },
        { '事件名': '乙', '章节': ['第二章'], '故事内时间': 'T2' },
        { '事件名': '丙', '章节': ['第三章'], '故事内时间': 'T3' },
      ],
      titles,
    )
    expect(issues).toHaveLength(0)
  })

  it('link 字段为 record id 形态时也能解析出章节号', () => {
    // 实测飞书 link 字段读回是 [{id: 'recXX'}]，不含章节号
    const recMap = new Map([['recA', 1], ['recB', 5]])
    const issues = checkForeshadows(
      [{ '伏笔内容': '剑谱下落', '状态': ['已埋设'], '重要度': 5, '计划回收章节': [{ id: 'recB' }] }],
      titles, recMap, 12, 3,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.location).toContain('第 5 章')
  })

  it('未填故事内时间的事件被跳过', () => {
    const issues = checkTimeline(
      [{ '事件名': '无时间', '章节': ['第一章'], '故事内时间': '' }],
      titles,
    )
    expect(issues).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/* 工具注册                                                            */
/* ------------------------------------------------------------------ */

describe('检查工具注册', () => {
  it('注册了两个检查工具', () => {
    const tools = collectTools()
    expect(tools.has('novel_run_consistency_check')).toBe(true)
    expect(tools.has('novel_get_semantic_check_pack')).toBe(true)
  })

  it('run_consistency_check 无必填（都可选）', () => {
    const tool = collectTools().get('novel_run_consistency_check')
    const params = tool?.parameters as { required?: string[] } | undefined
    // workToken 不必填：会话上下文默认承接；其他校验字段（targetType 等）也都可选。
    // 上一版「只需 workToken」是错的，现在实际整个 parameters.required 应该是空的。
    expect(params?.required ?? []).toEqual([])
    expect(params?.required ?? []).not.toContain('workToken')
  })

  it('semantic_check_pack 必填 chapterNo（workToken 不必填）', () => {
    const tool = collectTools().get('novel_get_semantic_check_pack')
    const params = tool?.parameters as { required?: string[] } | undefined
    expect(params?.required ?? []).toEqual(
      expect.arrayContaining(['chapterNo']),
    )
    expect(params?.required ?? []).not.toContain('workToken')
  })
})

/* ------------------------------------------------------------------ */
/* 端到端                                                              */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_BASE)('端到端：真实飞书', () => {
  const tools = collectTools()

  beforeAll(async () => {
    if (!HAS_BASE) return
    // 新建库收敛为分钟级：不等待则伏笔表查询/写入会间歇性 not_found
    await waitForBaseReady(TEST_BASE)
  })

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    return await tool.execute({ workToken: TEST_BASE, ...args }, {
      signal: AbortSignal.timeout(50_000),
    }) as Record<string, unknown>
  }

  it('run_consistency_check 返回结构化结果', async () => {
    const r = await run('novel_run_consistency_check', { persist: false })
    expect(typeof r.total).toBe('number')
    expect(typeof r.blocking).toBe('number')
    expect(Array.isArray(r.issues)).toBe(true)
    // 表查询不应整体失败
    expect((r.checkedTables as string[]).length).toBeGreaterThan(0)
  })

  it('semantic_check_pack 返回审阅材料与检查清单', async () => {
    const r = await run('novel_get_semantic_check_pack', { chapterNo: 4 })
    expect(Array.isArray(r.characters)).toBe(true)
    expect(Array.isArray(r.settings)).toBe(true)
    expect(Array.isArray(r.foreshadows)).toBe(true)
    const checklist = r.reviewChecklist as string[]
    expect(checklist.length).toBeGreaterThan(0)
    expect(checklist.some((c) => c.includes('口癖'))).toBe(true)
  })

  it('未回收伏笔能被真实检出', async () => {
    // **不依赖库里的历史数据**：seed 一条必逾期伏笔，并挂上「埋设章节」link——
    // 检查逻辑需要埋设章节来估算回收期限（无 link 的伏笔无法判断，会跳过）
    const content = `[测试] 必逾期伏笔-${Date.now().toString(36)}`
    const seeded = await run('novel_manage_foreshadow', {
      action: 'upsert', content, type: '主线', status: '已埋设', importance: 5,
    })
    // 用 base 层直接挂 link（manage_foreshadow 暂不支持 link 参数）
    const { base } = await import('@unwr/feishu')
    const { FORESHADOW_F, TABLE } = await import('@unwr/schema')
    const chapters = base.matrixToObjects(
      await base.listRecords(TEST_BASE, TABLE.CHAPTER, {
        fieldIds: ['章节号'], limit: 1,
      }),
    )
    const chapterRecordId = chapters[0]?.['__recordId']
    if (typeof chapterRecordId === 'string') {
      await base.updateRecords(TEST_BASE, TABLE.FORESHADOW, {
        [String(seeded.recordId)]: { [FORESHADOW_F.PLANT_CHAPTER]: [{ id: chapterRecordId }] },
      })
      // link 的 update 同样有读一致性延迟，立即检查会读到 null
      await new Promise((r) => setTimeout(r, 2000))
    }

    const r = await run('novel_run_consistency_check', { currentChapterNo: 999, persist: false })
    const issues = r.issues as { type: string; title: string }[]
    expect(issues.some((i) => i.type === '伏笔未回收')).toBe(true)
  })

  it('persist=true 时落库，重复运行不重复写入', async () => {
    const first = await run('novel_run_consistency_check', {
      currentChapterNo: 998, persist: true,
    })
    const persisted1 = first.persisted as { created: number; skipped: number } | undefined
    expect(persisted1).toBeDefined()

    // 第二次运行同样条件：应全部跳过（去重）
    const second = await run('novel_run_consistency_check', {
      currentChapterNo: 998, persist: true,
    })
    const persisted2 = second.persisted as { created: number; skipped: number } | undefined
    expect(persisted2?.created).toBe(0)
    expect(persisted2?.skipped).toBeGreaterThan(0)
  })
})
