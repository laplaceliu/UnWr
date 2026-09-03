/**
 * query* 函数的"可序列化"测试——守住 DSH lossless JSON 不变量。
 *
 * 实机 2026-09-03：novel_manage_foreshadow {action:"query"} 在 link 反解失败
 * 时整对象被 DSH `value is not lossless JSON` 拒收（chapterNoOf() 返回的
 * undefined 进了对象字面量键）。修复策略：用 `presentSparse()` 在 spread 阶段
 * 跳过 undefined 键——让对象**真的不包含**那个字段，而不是值为 undefined。
 *
 * 本测试守住"含 undefined 时仍能 JSON.stringify + 反复往返"，并断言：
 *   1. 三个章节号字段都为 undefined 时，对象中键必须**不存在**（无 'in' 检查）
 *   2. 章节号部分缺失/部分就绪时，只写出存在的键
 *   3. BookSummaryEntry 同理
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'

/** 简易 in-memory：表名 → records。 */
const chapterRows: { __recordId: string; 章节号: number }[] = []
const foreshadowRows: { __recordId: string; 伏笔内容: string; 类型?: string[]; 状态?: string[]
  重要度?: number; 埋设章节?: unknown[]; 计划回收章节?: unknown[]; 实际回收章节?: unknown[] }[] = []
const memoryRows: { __recordId: string; 摘要标题: string; 层级?: string[]; 摘要内容?: string
  覆盖起始章节?: unknown; 覆盖结束章节?: unknown }[] = []

vi.mock('@unwr/feishu', () => {
  return {
    FeishuError: class extends Error {
      readonly kind: string
      constructor(kind: string, message: string) { super(message); this.kind = kind }
    },
    hintFor: () => '',
    base: {
      // TABLE.* 在 schema/src/tables.ts 是中文：'章节表' / '伏笔表' / '记忆索引表'。
      listRecords: vi.fn(async (_t: string, table: string, _opts: unknown) => {
        if (table === '章节表') return { items: chapterRows, has_more: false }
        if (table === '伏笔表') return { items: foreshadowRows, has_more: false }
        if (table === '记忆索引表') return { items: memoryRows, has_more: false }
        return { items: [], has_more: false }
      }),
      listAllRecords: vi.fn(async (_t: string, table: string) => {
        if (table === '章节表') return { items: chapterRows, has_more: false }
        if (table === '伏笔表') return { items: foreshadowRows, has_more: false }
        if (table === '记忆索引表') return { items: memoryRows, has_more: false }
        return { items: [], has_more: false }
      }),
      matrixToObjects: vi.fn((res: { items: unknown[] }) => res.items as Record<string, unknown>[]),
      listTables: vi.fn(async () => ({ tables: [] })),
      getRecords: vi.fn(async () => ({ items: [] })),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
      updateRecords: vi.fn(async () => ({ updated: 0 })),
      createRecords: vi.fn(async () => []),
    },
    docs: {},
    drive: {},
    wiki: {},
  }
})

const { queryForeshadows } = await import('../src/domain/entity.ts')
const { queryBookSummaries } = await import('../src/domain/memory.ts')

/** 模拟 DSH 的 walkJsonValue——逐属性 check undefined。 */
function snapshotJsonValue(v: unknown): void {
  if (v === null || v === undefined) {
    throw new Error('value is not lossless JSON: undefined/null at top level')
  }
  if (Array.isArray(v)) {
    for (const x of v) snapshotJsonValue(x)
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) {
        throw new Error(`value is not lossless JSON: field "${k}" is undefined`)
      }
      snapshotJsonValue(val)
    }
  }
}

describe('queryForeshadows — presentSparse 守住 DSH lossless', () => {
  it('三个章节字段全为 undefined 时 → 键根本不存在（无 "in" 检查通过）', async () => {
    chapterRows.length = 0; foreshadowRows.length = 0
    // 章节表空 → chapterNoByRecordId() 返回空 map → chapterNoOf() 全 undefined
    foreshadowRows.push({
      __recordId: 'rec_fs_1', 伏笔内容: '陆家的断刀', 类型: ['import'],
      状态: ['pending'], 重要度: 5,
      // 三章节 link 字段都不传
    })
    const r = await queryForeshadows('b1')
    expect(r).toHaveLength(1)
    const f = r[0]!
    // 键不存在：'in' 是严格检查
    expect('plantChapter' in f).toBe(false)
    expect('planPayoffChapter' in f).toBe(false)
    expect('actualPayoffChapter' in f).toBe(false)
    // 不让 DSH 拒收——snapshot 整结果必须通过
    expect(() => snapshotJsonValue(r)).not.toThrow()
  })

  it('部分章节映射缺失 → 只写有值的键', async () => {
    chapterRows.length = 0; foreshadowRows.length = 0
    // 章节表里只存在第 3 章 → 第 5 章 link 必然映射失败
    chapterRows.push({ __recordId: 'rec_ch_3', 章节号: 3 })
    foreshadowRows.push({
      __recordId: 'rec_fs_2', 伏笔内容: '三尺青锋',
      类型: ['climax'], 状态: ['pending'], 重要度: 8,
      埋设章节: [{ id: 'rec_ch_3' }],          // 存在 → 映射到 3
      计划回收章节: [{ id: 'rec_ch_999' }],    // 不存在 → undefined
      // 实际回收章节 link 不填
    })
    const r = await queryForeshadows('b1')
    const f = r[0]!
    expect(f.plantChapter).toBe(3)
    expect('planPayoffChapter' in f).toBe(false)
    expect('actualPayoffChapter' in f).toBe(false)
    expect(() => snapshotJsonValue(r)).not.toThrow()
  })

  it('实测：旧实现（值=undefined）会被 snapshot 拒', () => {
    // 反向断言：确保我们对 "undefined 进对象" 的危险性心里有数。
    const broken = { content: 'x', plantChapter: undefined } as { content: string; plantChapter?: number | undefined }
    expect('plantChapter' in broken).toBe(true)
    expect(() => snapshotJsonValue(broken)).toThrow(/plantChapter/)
  })
})

describe('queryBookSummaries — presentSparse 守住 DSH lossless', () => {
  it('起始/结束章节字段空时 → 键根本不存在', async () => {
    chapterRows.length = 0; memoryRows.length = 0
    memoryRows.push({
      __recordId: 'rec_mem_1', 摘要标题: '第一卷 旧剑',
      层级: ['卷'], 摘要内容: '陆家旧事。',
      // 起始/结束章节都不传
    })
    const r = await queryBookSummaries('b1')
    expect(r).toHaveLength(1)
    const s = r[0]!
    expect('fromChapter' in s).toBe(false)
    expect('toChapter' in s).toBe(false)
    expect(() => snapshotJsonValue(r)).not.toThrow()
  })

  it('起始有结束无 → 只写 fromChapter', async () => {
    memoryRows.length = 0
    memoryRows.push({
      __recordId: 'rec_mem_2', 摘要标题: '第三卷 江声',
      层级: ['卷'], 摘要内容: '裴绛南归。',
      覆盖起始章节: 11,
      // 结束章节不传
    })
    const r = await queryBookSummaries('b1')
    const s = r[0]!
    expect(s.fromChapter).toBe(11)
    expect('toChapter' in s).toBe(false)
    expect(() => snapshotJsonValue(r)).not.toThrow()
  })

  it('chapter 字段是非数字（next 字符串等）→ numOrUndef 回 undefined → 跳过键', async () => {
    memoryRows.length = 0
    memoryRows.push({
      __recordId: 'rec_mem_3', 摘要标题: '全书摘要',
      层级: ['全书'], 摘要内容: '总览。',
      覆盖起始章节: 'abc' as unknown as undefined,
      覆盖结束章节: null as unknown as undefined,
    })
    const r = await queryBookSummaries('b1')
    const s = r[0]!
    expect('fromChapter' in s).toBe(false)
    expect('toChapter' in s).toBe(false)
    expect(() => snapshotJsonValue(r)).not.toThrow()
  })
})
