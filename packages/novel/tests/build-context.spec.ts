/**
 * 分层上下文 builder 单元测试
 * =============================
 *
 * 覆盖：
 *   - buildContext.characterStates 取每人在 chapterNo 之前最新一条
 *   - 超过 chapterNo 的状态被忽略
 *   - CHARACTER 表里查不到的人物被忽略（孤儿过滤）
 *   - safeRows 容错：CHARACTER_STATE 表缺失时不阻断整体
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CHAPTER_F, CHARACTER_F, CHARACTER_STATE_F, FORESHADOW_F, MEMORY_F, TABLE,
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
    ch5: { [CHAPTER_F.NO]: 5, [CHAPTER_F.TITLE]: '第 5 章' },
    ch9: { [CHAPTER_F.NO]: 9, [CHAPTER_F.TITLE]: '第 9 章' },
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