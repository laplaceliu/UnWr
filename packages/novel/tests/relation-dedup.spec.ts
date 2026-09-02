/**
 * 人物关系去重 & 软删除戳保护单元测试
 * ====================================
 *
 * 目的：mock @unwr/feishu/base，验证 `upsertRelation` 的关键不变量：
 *  - 同一对角色同一类型关系只创建一条记录（去重 key = (A, B, type)）
 *  - A↔B 视为同一条（字典序归一）
 *  - 已软删除的关系再 upsert 不会覆盖 status/description 字段
 *  - 已软删除的关系 upsert 时仍可更新 startChapter
 *  - force=true 时可以强行覆盖软删除戳
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TABLE, RELATION_F, CHARACTER_F, CHAPTER_F } from '@unwr/schema'

// 内存中的「飞书 Base」状态：每张表 = recordId -> fields
const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.CHARACTER]: {
    charA: { [CHARACTER_F.NAME]: '林北' },
    charB: { [CHARACTER_F.NAME]: '顾朝' },
  },
  // START_CHAPTER 是 link 字段（→ 章节表）：章节号须解析为 record id 才能回填
  [TABLE.CHAPTER]: {
    ch3: { [CHAPTER_F.NO]: 3 },
    ch50: { [CHAPTER_F.NO]: 50 },
  },
  [TABLE.RELATION]: {},
}

const counter = { id: 0 }

vi.mock('@unwr/feishu', () => {
  /** FeishuError mock：用 kind + code 模拟动态导入的可达性。 */
  class FeishuError extends Error {
    readonly kind: string
    readonly code?: number
    constructor(kind: string, message: string, code?: number) {
      super(message)
      this.kind = kind
      this.code = code
    }
  }
  const hintFor = (kind: string): string => {
    if (kind === 'not_found') return 'mock hint: resource not found'
    return ''
  }
  return {
    FeishuError,
    hintFor,
    base: {
      listRecords: vi.fn(async (_baseToken: string, table: string, opts: { filter?: { conditions?: unknown[] } }) => {
        // 简单模拟：返回所有记录，并把过滤条件后的 ID 字段填进 __recordId
        const items = Object.entries(store[table] ?? {}).map(([id, fields]) => ({
          __recordId: id,
          ...fields,
        }))
        // 取与过滤条件匹配的项
        if (opts.filter?.conditions !== undefined) {
          return {
            items: items.filter((row) => {
              return opts.filter!.conditions!.every((cond) => {
                const c = cond as [string, string, unknown]
                const [field, op, value] = c
                if (op !== '==') return true
                const cell = row[field]
                // link 字段写入侧是 [{id}]（两段式回填），select 是 ['值']——
                // 统一提取为原始值数组后再与条件值比较
                const flat = Array.isArray(cell)
                  ? cell.map((x) => (typeof x === 'object' && x !== null && 'id' in x ? (x as { id: unknown }).id : x))
                  : [cell]
                return flat.includes(value as never)
              })
            }),
          }
        }
        return { items }
      }),
      listAllRecords: vi.fn(async (_baseToken: string, table: string) => {
        return {
          items: Object.entries(store[table] ?? {}).map(([id, fields]) => ({ __recordId: id, ...fields })),
        }
      }),
      matrixToObjects: vi.fn((res: { items: Array<Record<string, unknown>> }) => res.items),
      updateRecords: vi.fn(
        async (_baseToken: string, table: string, byId: Record<string, Record<string, unknown>>) => {
          for (const [id, patch] of Object.entries(byId)) {
            if (store[table]?.[id] !== undefined) {
              store[table][id] = { ...store[table][id], ...patch }
            }
          }
          return { updated: Object.keys(byId).length }
        },
      ),
      createRecords: vi.fn(async (_baseToken: string, table: string, rows: Record<string, unknown>[]) => {
        const ids: string[] = []
        for (const row of rows) {
          counter.id += 1
          const id = `rec${counter.id}`
          store[table][id] = { ...row }
          ids.push(id)
        }
        return ids
      }),
      // 两段式的缓存校验路径：按 ID 直读，须返回库内真实记录
      getRecords: vi.fn(async (_baseToken: string, table: string, recordIds: readonly string[]) => {
        return {
          items: recordIds
            .filter((id) => store[table]?.[id] !== undefined)
            .map((id) => ({ __recordId: id, ...store[table]![id] })),
        }
      }),
      createBase: vi.fn(async () => ({ token: 'mock' })),
    },
  }
})

// 注意：必须在 mock 后再 import，被 mock 的模块才能被替换
const { upsertRelation, deleteRelation, clearRelationCacheForTests } = await import('../src/domain/entity.ts')

beforeEach(() => {
  store[TABLE.RELATION] = {}
  counter.id = 0
  // 去重缓存跨用例隔离（store 重置后旧缓存指向已删记录）
  clearRelationCacheForTests()
})

describe('upsertRelation 去重', () => {
  it('新关系 → 1 条记录', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩',
    })
    expect(r1.recordId).toMatch(/^rec\d+$/)
    expect(r1.updated).toBe(false)
    expect(Object.keys(store[TABLE.RELATION])).toHaveLength(1)
  })

  it('同对角色同类型再 upsert → 同 recordId + updated=true', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩',
    })
    const r2 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩，兼有敬畏',
    })
    expect(r2.recordId).toBe(r1.recordId)
    expect(r2.updated).toBe(true)
    expect(Object.keys(store[TABLE.RELATION])).toHaveLength(1)
  })

  it('A↔B 反向被视为同一条（字典序归一）', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
    })
    const r2 = await upsertRelation('base', {
      characterA: '顾朝',
      characterB: '林北',
      type: '师徒',
    })
    expect(r2.recordId).toBe(r1.recordId)
    expect(r2.updated).toBe(true)
    expect(Object.keys(store[TABLE.RELATION])).toHaveLength(1)
  })

  it('同对角色不同类型允许共存（两条记录）', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
    })
    const r2 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '敌对',
    })
    expect(r1.recordId).not.toBe(r2.recordId)
    expect(Object.keys(store[TABLE.RELATION])).toHaveLength(2)
  })
})

describe('upsertRelation 软删除戳保护', () => {
  it('已被 deleteRelation 标记的关系，upsert 不覆盖 description', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩',
    })
    await deleteRelation('base', '林北', '顾朝', '师徒')

    // 软删除戳写入
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.DESCRIPTION]).toContain('[已删除]')
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.STATUS]).toEqual(['已破裂'])

    // 普通 upsert 不应抹平戳
    const r2 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩，兼有敬畏',
    })
    expect(r2.recordId).toBe(r1.recordId)
    expect(r2.warnings.length).toBeGreaterThan(0)
    // 戳未被抹平
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.DESCRIPTION]).toContain('[已删除]')
  })

  it('已被删除戳的关系，仍允许更新 startChapter', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩',
      startChapter: 3,
    })
    await deleteRelation('base', '林北', '顾朝', '师徒')

    await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      startChapter: 50,
    })
    // link 语义：章节号 50 已解析为章节表 record id，回填格式 [{id}]
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.START_CHAPTER])
      .toEqual([{ id: 'ch50' }])
    // 戳仍保留
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.DESCRIPTION]).toContain('[已删除]')
  })

  it('force=true 强行覆盖软删除戳', async () => {
    const r1 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '养育之恩',
    })
    await deleteRelation('base', '林北', '顾朝', '师徒')

    const r2 = await upsertRelation('base', {
      characterA: '林北',
      characterB: '顾朝',
      type: '师徒',
      description: '重新认识为亦师亦友',
      status: '存续',
      force: true,
    })
    expect(r2.recordId).toBe(r1.recordId)
    // 戳被覆盖
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.DESCRIPTION]).not.toContain('[已删除]')
    expect(store[TABLE.RELATION][r1.recordId][RELATION_F.STATUS]).toEqual(['存续'])
  })
})