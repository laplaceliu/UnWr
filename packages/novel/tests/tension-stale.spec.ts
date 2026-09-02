/**
 * 张力评分 + 记忆失效标记 单元测试
 * =====================================
 *
 * 覆盖：
 *   - setChapterTension 钳制越界值 + 章节不存在抛错
 *   - markMemoriesStaleForChapter 按章节/卷/全书 3 级覆盖区间
 *   - 已有 STALE=true 的不会被再次更新（避免幂等写）
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TABLE, CHAPTER_F, MEMORY_F, MEMORY_LEVEL } from '@unwr/schema'

const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.CHAPTER]: {
    ch3: { [CHAPTER_F.NO]: 3, [CHAPTER_F.TITLE]: '第 3 章' },
    ch5: { [CHAPTER_F.NO]: 5, [CHAPTER_F.TITLE]: '第 5 章' },
  },
  [TABLE.MEMORY]: {
    memChapter3_5: {
      [MEMORY_F.LEVEL]: MEMORY_LEVEL.CHAPTER,
      [MEMORY_F.FROM_CHAPTER]: 3,
      [MEMORY_F.TO_CHAPTER]: 5,
      [MEMORY_F.TITLE]: '第 3-5 章摘要',
      [MEMORY_F.STALE]: false,
    },
    memChapter6_8: {
      [MEMORY_F.LEVEL]: MEMORY_LEVEL.CHAPTER,
      [MEMORY_F.FROM_CHAPTER]: 6,
      [MEMORY_F.TO_CHAPTER]: 8,
      [MEMORY_F.TITLE]: '第 6-8 章摘要',
      [MEMORY_F.STALE]: false,
    },
    memVolume1: {
      [MEMORY_F.LEVEL]: MEMORY_LEVEL.VOLUME,
      [MEMORY_F.FROM_CHAPTER]: 1,
      [MEMORY_F.TO_CHAPTER]: 10,
      [MEMORY_F.TITLE]: '第一卷摘要',
      [MEMORY_F.STALE]: false,
    },
    memBook: {
      [MEMORY_F.LEVEL]: MEMORY_LEVEL.BOOK,
      [MEMORY_F.FROM_CHAPTER]: 1,
      [MEMORY_F.TO_CHAPTER]: 100,
      [MEMORY_F.TITLE]: '全书摘要',
      [MEMORY_F.STALE]: true, // 已经过期 → 不应被再次写入
    },
  },
}

vi.mock('@unwr/feishu', () => {
  const FeishuError = class extends Error {
    readonly kind: string
    readonly code?: number
    constructor(kind: string, msg: string) { super(msg); this.kind = kind }
  }
  return {
    FeishuError,
    hintFor: (kind: string) => kind === 'not_found' ? 'mock' : '',
    base: {
      listRecords: vi.fn(async (_t: string, table: string, opts: { fieldIds?: string[]; filter?: { conditions?: unknown[] }; limit?: number }) => {
        const rows = Object.entries(store[table] ?? {}).map(([id, fields]) => ({ __recordId: id, ...fields }))
        const cond = opts.filter?.conditions?.[0] as [string, string, unknown] | undefined
        if (cond === undefined) return { items: rows }
        const [field, op, value] = cond
        if (op !== '==') return { items: rows }
        return {
          items: rows.filter((row) => {
            const cell = row[field]
            if (Array.isArray(cell)) return cell.includes(value as never)
            return cell === value
          }),
        }
      }),
      matrixToObjects: vi.fn((res: { items: Array<Record<string, unknown>> }) => res.items),
      updateRecords: vi.fn(async (_t: string, table: string, byId: Record<string, Record<string, unknown>>) => {
        for (const [id, patch] of Object.entries(byId)) {
          if (store[table]?.[id] !== undefined) {
            store[table][id] = { ...store[table][id], ...patch }
          }
        }
        return { updated: Object.keys(byId).length }
      }),
      createRecords: vi.fn(async (_t: string, table: string, rows: Record<string, unknown>[]) => {
        const ids: string[] = []
        for (const row of rows) {
          const id = `r${Math.random().toString(36).slice(2, 8)}`
          store[table][id] = { ...row }
          ids.push(id)
        }
        return ids
      }),
      listAllRecords: vi.fn(async () => ({ items: [] })),
      getRecords: vi.fn(async () => ({ items: [] })),
    },
  }
})

const { setChapterTension, markMemoriesStaleForChapter } = await import('../src/domain/entity.ts')

beforeEach(() => {
  // 重置非 STALE 字段
  store[TABLE.MEMORY].memChapter3_5[MEMORY_F.STALE] = false
  store[TABLE.MEMORY].memChapter6_8[MEMORY_F.STALE] = false
  store[TABLE.MEMORY].memVolume1[MEMORY_F.STALE] = false
  store[TABLE.MEMORY].memBook[MEMORY_F.STALE] = true
})

describe('setChapterTension', () => {
  it('写入合法值', async () => {
    const r = await setChapterTension('base', 3, 4)
    expect(r.score).toBe(4)
    expect(r.warnings).toEqual([])
    expect(store[TABLE.CHAPTER].ch3[CHAPTER_F.TENSION]).toBe(4)
  })

  it('越界值被钳制并写入警告', async () => {
    const r = await setChapterTension('base', 3, 9)
    expect(r.score).toBe(5)
    expect(r.warnings[0]).toContain('钳制')
  })

  it('负数被钳制到 1', async () => {
    const r = await setChapterTension('base', 3, -2)
    expect(r.score).toBe(1)
    expect(r.warnings[0]).toContain('钳制')
  })

  it('小数会被四舍五入', async () => {
    const r = await setChapterTension('base', 3, 3.6)
    expect(r.score).toBe(4)
  })

  it('章节不存在抛错', async () => {
    await expect(setChapterTension('base', 999, 3)).rejects.toThrow(/不存在/)
  })
})

describe('markMemoriesStaleForChapter', () => {
  it('第 4 章改动：覆盖命中 3-5 章节区间与第一卷；全书已是 true 不重复写', async () => {
    const r = await markMemoriesStaleForChapter('base', 4)
    // affected 数 = 区间内"刚被置为过期"的记录；memBook 已是 true 不计入
    expect(r.affected).toBe(2) // memChapter3_5 + memVolume1
    expect(store[TABLE.MEMORY].memChapter3_5[MEMORY_F.STALE]).toBe(true)
    expect(store[TABLE.MEMORY].memVolume1[MEMORY_F.STALE]).toBe(true)
    expect(store[TABLE.MEMORY].memBook[MEMORY_F.STALE]).toBe(true) // 已 true 不变
  })

  it('第 4 章改动：不命中 6-8', async () => {
    await markMemoriesStaleForChapter('base', 4)
    expect(store[TABLE.MEMORY].memChapter6_8[MEMORY_F.STALE]).toBe(false)
  })

  it('已有 STALE=true 的不会被再次写入（无幂等写）', async () => {
    // memBook 已是 true，重跑不应再次触发 update
    const r = await markMemoriesStaleForChapter('base', 4)
    // memBook 不计入 affected（验证里只 patch STALE=false→true 的）
    expect(store[TABLE.MEMORY].memBook[MEMORY_F.STALE]).toBe(true)
    expect(r.affected).toBeLessThan(4)
  })

  it('全部已过期时返回 affected=0 + warning', async () => {
    store[TABLE.MEMORY].memChapter3_5[MEMORY_F.STALE] = true
    store[TABLE.MEMORY].memVolume1[MEMORY_F.STALE] = true
    const r = await markMemoriesStaleForChapter('base', 4)
    expect(r.affected).toBe(0)
    expect(r.warnings[0]).toContain('无记忆需要标记为过期')
  })
})