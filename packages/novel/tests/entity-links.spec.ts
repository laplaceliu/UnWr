/**
 * 实体工具的章节关联（link 字段）写入/读取测试（纯 mock）。
 *
 * 背景（2026-09-03 全表审计发现）：伏笔/剧情线的 link 字段（埋设章节、
 * 计划回收章节、关联章节等）**从来没有写入口**——领域层的一致性检查
 * （伏笔逾期 H3）与 breakthrough 的剧情线激活/待回收伏笔全依赖它们，
 * 于是这些特性端到端失效（link 恒空 → plantedChapter 恒 0）。
 *
 * 本文件守住修复后的行为：
 *   1. upsert 伏笔带章节号 → link 真正写进库（两阶段：标量 + 回填）
 *   2. 章节不存在 → 告警且跳过该关联，不阻塞建档
 *   3. 已有记录的更新走带验证的回填路径
 *   4. query 把 link 反解回章节号（模型能读到现状再决定怎么改）
 *   5. 剧情线 chapterNos 整体替换语义（部分章节缺失时写回已解析子集）
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAPTER_F, FORESHADOW_F, PLOTLINE_F, TABLE,
} from '@unwr/schema'

/** 表名 → (recordId → 字段名 → 值)。 */
const store = new Map<string, Map<string, Record<string, unknown>>>()
/** 表名 → 字段定义（selfheal 验证用）。 */
const tableSchemas = new Map<string, { name: string; type: string }[]>()

function seedTable(name: string, fields: { name: string; type: string }[]): void {
  tableSchemas.set(name, fields)
  store.set(name, new Map())
}

function addRecord(table: string, values: Record<string, unknown>): string {
  const rid = `rec_${table}_${store.get(table)!.size + 1}`
  store.get(table)!.set(rid, { ...values })
  return rid
}

vi.mock('@unwr/feishu', () => {
  class FeishuError extends Error {
    readonly kind: string
    readonly code?: number
    constructor(kind: string, message: string, opts?: { code?: number }) {
      super(message)
      this.kind = kind
      this.code = opts?.code
    }
  }

  const tableOf = (t: string): Map<string, Record<string, unknown>> => {
    if (!store.has(t)) store.set(t, new Map())
    return store.get(t)!
  }
  const fieldsOf = (t: string): { name: string; type: string }[] =>
    tableSchemas.get(t) ?? []

  return {
    FeishuError,
    hintFor: () => '',
    base: {
      listTables: vi.fn(async () => ({
        tables: [...tableSchemas.keys()].map((name) => ({ name, id: name })),
      })),
      listFields: vi.fn(async (_t: string, table: string) => ({
        fields: fieldsOf(table).map((f) => ({ ...f })),
      })),
      getField: vi.fn(async (_t: string, table: string, field: string) => ({
        field: fieldsOf(table).find((f) => f.name === field || f.name === field.replace(/^fld_/, '')) ?? { name: field, type: 'text' },
      })),
      updateField: vi.fn(async () => ({})),
      listRecords: vi.fn(async (_t: string, table: string, opts: {
        fieldIds?: readonly string[]
        filter?: { conditions?: [string, string, unknown][] }
      }) => {
        const fs = fieldsOf(table)
        const wanted = opts.fieldIds ?? fs.map((f) => f.name)
        let rows = [...tableOf(table).entries()]
        for (const [field, op, value] of opts.filter?.conditions ?? []) {
          if (op !== '==') continue
          rows = rows.filter(([, rec]) => {
            const cell = rec[field]
            const flat = Array.isArray(cell) ? cell : [cell]
            return flat.includes(value as never)
          })
        }
        return {
          items: rows.map(([rid, rec]) => ({
            __recordId: rid,
            ...Object.fromEntries(wanted.map((f) => [f, rec[f] ?? null])),
          })),
        }
      }),
      listAllRecords: vi.fn(async (_t: string, table: string, opts: { fieldIds?: readonly string[] }) => {
        const fs = fieldsOf(table)
        const wanted = opts.fieldIds ?? fs.map((f) => f.name)
        return {
          items: [...tableOf(table).entries()].map(([rid, rec]) => ({
            __recordId: rid,
            ...Object.fromEntries(wanted.map((f) => [f, rec[f] ?? null])),
          })),
        }
      }),
      // 两种入参形状都要支持：record-list 返回 {items}（已是对象），
      // record-get 返回矩阵 {fields, data, record_id_list}（需按列对位展开）。
      // 漏掉矩阵形状会让 selfheal 的回填验证拿到 undefined → 永远验证失败
      // → 3s/6s/9s 退避 → 所有用例超时。
      matrixToObjects: vi.fn((res: {
        items?: Record<string, unknown>[]
        fields?: string[]
        data?: unknown[][]
        record_id_list?: string[]
      }) => {
        if (res.items !== undefined) return res.items
        const rows = res.data ?? []
        return rows.map((row, i) => {
          const o: Record<string, unknown> = {}
          ;(res.fields ?? []).forEach((f, j) => { o[f] = row[j] })
          const rid = res.record_id_list?.[i]
          if (rid !== undefined) o['__recordId'] = rid
          return o
        })
      }),
      createRecords: vi.fn(async (_t: string, table: string, rows: Record<string, unknown>[]) =>
        rows.map((row) => addRecord(table, row))),
      updateRecords: vi.fn(async (_t: string, table: string, patch: Record<string, Record<string, unknown>>) => {
        const tbl = tableOf(table)
        for (const [rid, fields] of Object.entries(patch)) {
          tbl.set(rid, { ...(tbl.get(rid) ?? {}), ...fields })
        }
        return { updated: Object.keys(patch).length }
      }),
      getRecords: vi.fn(async (_t: string, table: string, ids: readonly string[]) => {
        const fs = fieldsOf(table)
        const tbl = tableOf(table)
        return {
          fields: fs.map((f) => f.name),
          field_id_list: fs.map((f) => `fld_${f.name}`),
          field_type_list: fs.map((f) => f.type),
          data: ids.map((rid) => fs.map((f) => tbl.get(rid)?.[f.name] ?? null)),
          record_id_list: [...ids],
        }
      }),
    },
    docs: {},
    drive: {},
    wiki: {},
  }
})

const { upsertForeshadow, queryForeshadows, upsertPlotline, queryPlotlines } =
  await import('../src/domain/entity.ts')
const { clearChapterIdCacheForTests } = await import('../src/domain/organize.ts')

const BASE = 'links-test-base'

beforeEach(() => {
  store.clear()
  tableSchemas.clear()
  clearChapterIdCacheForTests()

  seedTable(TABLE.CHAPTER, [
    { name: CHAPTER_F.NO, type: 'number' },
    { name: CHAPTER_F.TITLE, type: 'text' },
    { name: '所属卷', type: 'link' },
  ])
  seedTable(TABLE.FORESHADOW, [
    { name: FORESHADOW_F.CONTENT, type: 'text' },
    { name: FORESHADOW_F.TYPE, type: 'select' },
    { name: FORESHADOW_F.STATUS, type: 'select' },
    { name: FORESHADOW_F.IMPORTANCE, type: 'number' },
    { name: FORESHADOW_F.NOTE, type: 'text' },
    { name: FORESHADOW_F.PLANT_CHAPTER, type: 'link' },
    { name: FORESHADOW_F.PLAN_PAYOFF_CHAPTER, type: 'link' },
    { name: FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER, type: 'link' },
  ])
  seedTable(TABLE.PLOTLINE, [
    { name: PLOTLINE_F.NAME, type: 'text' },
    { name: PLOTLINE_F.TYPE, type: 'select' },
    { name: PLOTLINE_F.STATUS, type: 'select' },
    { name: PLOTLINE_F.DESCRIPTION, type: 'text' },
    { name: PLOTLINE_F.CHAPTERS, type: 'link' },
  ])
})

function seedChapter(no: number): string {
  return addRecord(TABLE.CHAPTER, { [CHAPTER_F.NO]: no, [CHAPTER_F.TITLE]: `第 ${no} 章` })
}

describe('upsertForeshadow 章节关联', () => {
  it('新建伏笔带 plantChapter/planPayoffChapter → link 写入章节记录', async () => {
    const ch1 = seedChapter(1)
    const ch3 = seedChapter(3)

    const r = await upsertForeshadow(BASE, {
      content: '青莲旧符的篆字',
      status: '已埋设',
      importance: 5,
      plantChapter: 1,
      planPayoffChapter: 3,
    })

    expect(r.warnings).toEqual([])
    const rec = store.get(TABLE.FORESHADOW)!.get(r.recordId)!
    expect(rec[FORESHADOW_F.PLANT_CHAPTER]).toEqual([{ id: ch1 }])
    expect(rec[FORESHADOW_F.PLAN_PAYOFF_CHAPTER]).toEqual([{ id: ch3 }])
  })

  it('章节不存在 → 告警并跳过该关联，伏笔本体照常建档', async () => {
    seedChapter(1) // 只建了第 1 章

    const r = await upsertForeshadow(BASE, {
      content: '无案卷宗的缺口',
      plantChapter: 1,
      planPayoffChapter: 99, // 不存在
    })

    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/第 99 章不存在/)
    const rec = store.get(TABLE.FORESHADOW)!.get(r.recordId)!
    expect(rec[FORESHADOW_F.PLANT_CHAPTER]).not.toBeNull()
    // mock 的 createRecords 只存传入字段，未关联的字段键不存在
    expect(rec[FORESHADOW_F.PLAN_PAYOFF_CHAPTER]).toBeFalsy()
  })

  it('更新已有伏笔（标记回收）→ link 回填走带验证路径', async () => {
    const ch1 = seedChapter(1)
    const ch5 = seedChapter(5)
    const planted = await upsertForeshadow(BASE, {
      content: '青莲旧符的篆字', plantChapter: 1, planPayoffChapter: 5,
    })

    const r = await upsertForeshadow(BASE, {
      content: '青莲旧符的篆字',
      status: '已回收',
      actualPayoffChapter: 5,
    })
    expect(r.recordId).toBe(planted.recordId)
    expect(r.updated).toBe(true)

    const rec = store.get(TABLE.FORESHADOW)!.get(r.recordId)!
    expect(rec[FORESHADOW_F.STATUS]).toEqual(['已回收'])
    expect(rec[FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER]).toEqual([{ id: ch5 }])
    // 原有的埋设关联不被更新操作抹掉
    expect(rec[FORESHADOW_F.PLANT_CHAPTER]).toEqual([{ id: ch1 }])
  })

  it('query 把 link 反解回章节号', async () => {
    seedChapter(1)
    seedChapter(5)
    await upsertForeshadow(BASE, {
      content: '青莲旧符的篆字', plantChapter: 1, planPayoffChapter: 5,
    })
    await upsertForeshadow(BASE, { content: '未关联章节的伏笔' })

    const items = await queryForeshadows(BASE)
    const withLinks = items.find((f) => f.content === '青莲旧符的篆字')!
    expect(withLinks.plantChapter).toBe(1)
    expect(withLinks.planPayoffChapter).toBe(5)
    const bare = items.find((f) => f.content === '未关联章节的伏笔')!
    expect(bare.plantChapter).toBeUndefined()
  })
})

describe('upsertPlotline chapterNos', () => {
  it('新建剧情线带 chapterNos → 关联章节整体写入', async () => {
    const ids = [seedChapter(1), seedChapter(2), seedChapter(3)]

    const r = await upsertPlotline(BASE, {
      name: '齐王逼宫线', type: '主线', chapterNos: [1, 2, 3],
    })
    expect(r.warnings).toEqual([])
    const rec = store.get(TABLE.PLOTLINE)!.get(r.recordId)!
    expect(rec[PLOTLINE_F.CHAPTERS]).toEqual(ids.map((id) => ({ id })))
  })

  it('更新时整体替换：新列表覆盖旧列表', async () => {
    seedChapter(1)
    seedChapter(4)
    const created = await upsertPlotline(BASE, { name: '齐王逼宫线', chapterNos: [1] })
    const ch4Id = store.get(TABLE.CHAPTER)!
      .entries().find(([, v]) => v[CHAPTER_F.NO] === 4)![0]

    await upsertPlotline(BASE, { name: '齐王逼宫线', chapterNos: [4] })
    const rec = store.get(TABLE.PLOTLINE)!.get(created.recordId)!
    expect(rec[PLOTLINE_F.CHAPTERS]).toEqual([{ id: ch4Id }])
  })

  it('部分章节不存在 → 告警并写回已解析子集', async () => {
    seedChapter(1)
    const r = await upsertPlotline(BASE, {
      name: '齐王逼宫线', chapterNos: [1, 7, 8],
    })
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toMatch(/第 7 章不存在/)
    const rec = store.get(TABLE.PLOTLINE)!.get(r.recordId)!
    const linked = rec[PLOTLINE_F.CHAPTERS] as { id: string }[]
    expect(linked).toHaveLength(1)
  })

  it('query 返回章节号列表', async () => {
    seedChapter(2)
    seedChapter(6)
    await upsertPlotline(BASE, { name: '齐王逼宫线', chapterNos: [2, 6] })

    const items = await queryPlotlines(BASE)
    expect(items[0]?.chapters).toEqual([2, 6])
  })
})
