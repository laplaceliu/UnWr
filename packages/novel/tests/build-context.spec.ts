/**
 * 分层上下文 builder 单元测试
 * =============================
 *
 * 覆盖：
 *   - buildContext.characterStates 取每人在 chapterNo 之前最新一条
 *   - 超过 chapterNo 的状态被忽略
 *   - CHARACTER 表里查不到的人物被忽略（孤儿过滤）
 *   - safeRows 容错：CHARACTER_STATE 表缺失时不阻断整体
 *   - relevantSettings：点名命中优先、已废弃排除、按重要度补齐、limit 截断
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CHAPTER_F, CHARACTER_F, CHARACTER_STATE_F, FORESHADOW_F, MEMORY_F, SETTING_F,
  SETTING_STATUS, TABLE,
} from '@unwr/schema'

const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.CHARACTER]: {
    charA: { [CHARACTER_F.NAME]: '林北' },
    charB: { [CHARACTER_F.NAME]: '顾朝' },
  },
  [TABLE.CHARACTER_STATE]: {
    stateA_ch2: {
      [CHARACTER_STATE_F.CHARACTER]: ['charA'],
      [CHARACTER_STATE_F.CHAPTER]: ['ch2'],
      [CHARACTER_STATE_F.SUMMARY]: '林北在第 2 章状态',
      [CHARACTER_STATE_F.LOCATION]: '京城',
      [CHARACTER_STATE_F.PHYSICAL]: '轻伤',
      [CHARACTER_STATE_F.EMOTION]: '犹豫',
      [CHARACTER_STATE_F.BELONGINGS]: '长剑',
    },
    stateA_ch5: {
      // 同一人物更晚章节的状态应被采纳
      [CHARACTER_STATE_F.CHARACTER]: ['charA'],
      [CHARACTER_STATE_F.CHAPTER]: ['ch5'],
      [CHARACTER_STATE_F.SUMMARY]: '林北在第 5 章状态（最新）',
      [CHARACTER_STATE_F.LOCATION]: '边关',
      [CHARACTER_STATE_F.PHYSICAL]: '健康',
      [CHARACTER_STATE_F.EMOTION]: '坚定',
      [CHARACTER_STATE_F.BELONGINGS]: '断剑',
    },
    stateA_ch9: {
      // 超过目标章节 8，应被忽略
      [CHARACTER_STATE_F.CHARACTER]: ['charA'],
      [CHARACTER_STATE_F.CHAPTER]: ['ch9'],
      [CHARACTER_STATE_F.SUMMARY]: '林北在第 9 章状态（应忽略）',
    },
    stateB_ch3: {
      [CHARACTER_STATE_F.CHARACTER]: ['charB'],
      [CHARACTER_STATE_F.CHAPTER]: ['ch3'],
      [CHARACTER_STATE_F.SUMMARY]: '顾朝在第 3 章',
    },
    stateOrphan_ch1: {
      [CHARACTER_STATE_F.CHARACTER]: ['ghost'], // CHARACTER 表中不存在
      [CHARACTER_STATE_F.CHAPTER]: ['ch2'],
      [CHARACTER_STATE_F.SUMMARY]: '孤儿应被忽略',
    },
  },
  [TABLE.CHAPTER]: {
    ch2: { [CHAPTER_F.NO]: 2, [CHAPTER_F.TITLE]: '第 2 章' },
    ch3: { [CHAPTER_F.NO]: 3, [CHAPTER_F.TITLE]: '第 3 章' },
    ch5: {
      [CHAPTER_F.NO]: 5,
      [CHAPTER_F.TITLE]: '第 5 章',
      // 摘要里点名了两个设定词条 → 它们应被判定为相关
      [CHAPTER_F.SUMMARY]: '林北抵达北境，青冥剑断裂',
    },
    ch9: { [CHAPTER_F.NO]: 9, [CHAPTER_F.TITLE]: '第 9 章' },
  },
  [TABLE.SETTING]: {
    // 命中，重要度低
    setSword: {
      [SETTING_F.TERM]: '青冥剑',
      [SETTING_F.DEFINITION]: '林北佩剑',
      [SETTING_F.IMPORTANCE]: 2,
      [SETTING_F.STATUS]: SETTING_STATUS.ACTIVE,
    },
    // 命中，重要度高 → 应排在青冥剑之前
    setNorth: {
      [SETTING_F.TERM]: '北境',
      [SETTING_F.DEFINITION]: '极寒之地',
      [SETTING_F.IMPORTANCE]: 5,
      [SETTING_F.STATUS]: SETTING_STATUS.ACTIVE,
    },
    // 未命中，重要度中等 → 余额补齐时排第一
    setTrade: {
      [SETTING_F.TERM]: '盐铁司',
      [SETTING_F.DEFINITION]: '掌管盐铁',
      [SETTING_F.IMPORTANCE]: 4,
      [SETTING_F.STATUS]: SETTING_STATUS.ACTIVE,
    },
    // 未命中，重要度低
    setTea: {
      [SETTING_F.TERM]: '茶马道',
      [SETTING_F.DEFINITION]: '商道',
      [SETTING_F.IMPORTANCE]: 1,
      [SETTING_F.STATUS]: SETTING_STATUS.PENDING,
    },
    // 已废弃：即使重要度最高也必须排除
    setDeprecated: {
      [SETTING_F.TERM]: '旧历法',
      [SETTING_F.DEFINITION]: '已被取代',
      [SETTING_F.IMPORTANCE]: 5,
      [SETTING_F.STATUS]: SETTING_STATUS.DEPRECATED,
    },
  },
  [TABLE.FORESHADOW]: {},
  [TABLE.MEMORY]: {},
}

vi.mock('@unwr/feishu', () => {
  const FeishuError = class extends Error {
    readonly kind: string
    constructor(kind: string, msg: string) { super(msg); this.kind = kind }
  }
  return {
    FeishuError,
    hintFor: () => '',
    base: {
      listRecords: vi.fn(async (_t: string, table: string, _opts?: unknown) => {
        const rows = Object.entries(store[table] ?? {}).map(([id, fields]) => ({ __recordId: id, ...fields }))
        return { items: rows }
      }),
      listAllRecords: vi.fn(async (_t: string, table: string, opts?: { fieldIds?: string[] }) => {
        const rows = Object.entries(store[table] ?? {}).map(([id, fields]) => ({ __recordId: id, ...fields }))
        return { items: rows }
      }),
      matrixToObjects: vi.fn((res: { items: Array<Record<string, unknown>> }) => res.items),
      updateRecords: vi.fn(async () => ({ updated: 0 })),
      createRecords: vi.fn(async () => [] as string[]),
      getRecords: vi.fn(async () => ({ items: [] })),
    },
    docs: {
      fetchDoc: vi.fn(async () => ({ content: '' })),
    },
  }
})

// 默认空 GenrePreset（避免依赖 schema 详细定义）
const emptyPreset = {} as Parameters<typeof import('../src/context/builder.ts').buildContext>[2]

const { buildContext } = await import('../src/context/builder.ts')

describe('buildContext.characterStates', () => {
  it('每人物取 chapterNo 之前的最新一条', async () => {
    const ctx = await buildContext('base', 8, emptyPreset)
    const lin = ctx.characterStates.find((s) => s.name === '林北')
    const gu = ctx.characterStates.find((s) => s.name === '顾朝')
    expect(lin?.summary).toContain('第 5 章状态')
    expect(lin?.summary).not.toContain('应忽略')
    expect(gu?.summary).toContain('第 3 章')
  })

  it('超过目标章节的状态被排除', async () => {
    const ctx = await buildContext('base', 6, emptyPreset)
    const lin = ctx.characterStates.find((s) => s.name === '林北')
    // 6 章时第 5 章状态是「之前最新」，第 9 章被排除
    expect(lin?.summary).toContain('第 5 章状态（最新）')
  })

  it('CHARACTER 表查不到的人物被忽略（孤儿过滤）', async () => {
    const ctx = await buildContext('base', 8, emptyPreset)
    const ghost = ctx.characterStates.find((s) => s.name === 'ghost')
    expect(ghost).toBeUndefined()
    // 应只有 林北 + 顾朝 两条
    expect(ctx.characterStates).toHaveLength(2)
  })

  it('同一人物多条记录只取 chapterNo 之前最新的一条', async () => {
    const ctx = await buildContext('base', 5, emptyPreset)
    const lin = ctx.characterStates.find((s) => s.name === '林北')
    // 5 章时第 5 章状态刚好命中
    expect(lin?.summary).toContain('第 5 章状态（最新）')
  })
})

describe('buildContext.relevantSettings', () => {
  // chapterNo=9 时第 5 章摘要进入 L1 → 其中的「北境」「青冥剑」构成命中
  it('作用域里点名出现的词条优先，且按重要度降序', async () => {
    const ctx = await buildContext('base', 9, emptyPreset)
    const terms = ctx.relevantSettings.map((s) => s.term)
    expect(terms.slice(0, 2)).toEqual(['北境', '青冥剑'])
    // 未命中的按重要度补在后面
    expect(terms.slice(2)).toEqual(['盐铁司', '茶马道'])
  })

  it('已废弃词条一律不注入', async () => {
    const ctx = await buildContext('base', 9, emptyPreset)
    expect(ctx.relevantSettings.map((s) => s.term)).not.toContain('旧历法')
  })

  it('全部未命中时退化为按重要度取 Top N，并受 settingLimit 截断', async () => {
    const ctx = await buildContext('base', 2, emptyPreset, {
      recentFullChapters: 3,
      summaryHorizon: 12,
      foreshadowLimit: 20,
      settingLimit: 2,
    })
    // 第 2 章没有任何摘要/原文 → 无命中，按重要度取前 2（旧历法已废弃，不参评）
    expect(ctx.relevantSettings.map((s) => s.term)).toEqual(['北境', '盐铁司'])
  })

  it('设定表为空时降级为空数组，不阻断组装', async () => {
    const saved = store[TABLE.SETTING] ?? {}
    store[TABLE.SETTING] = {}
    try {
      const ctx = await buildContext('base', 9, emptyPreset)
      expect(ctx.relevantSettings).toEqual([])
    } finally {
      store[TABLE.SETTING] = saved
    }
  })
})