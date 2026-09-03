/**
 * 章节出场人物（cast）双向 link 写入测试（纯 mock）。
 *
 * 背景（2026-09-03 全表审计发现）：章节表.出场人物 / 人物表.出场章节
 * 之前**没有写入口**——写章时 cast 只能停留在模型上下文，落到库里只能
 * 靠「记忆沉淀」阶段从章节正文里事后反推，于是跨章上下文里查不到本章的
 * 出场人物、跨人物上下文里查不到出场章节，召回质量断崖。
 *
 * 本文件守住修复后的行为：
 *   1. writeChapter 接受 cast：双向写入（章节表.出场人物 ∪ cast，
 *      人物表.出场章节 ∪ this chapterNo）
 *   2. 名字尾随括号注记（"陆铮（不在场）"）→ name="陆铮"、note="不在场"
 *   3. 名字解析不到 → warning 返回，**不阻塞写章**
 *   4. 重复 cast → 幂等（union 去重），不会越滚越大
 *   5. 空 cast / 未传 cast → 无副作用
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAPTER_F, CHARACTER_F, TABLE } from '@unwr/schema'

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
        field: fieldsOf(table).find((f) => f.name === field) ?? { name: field, type: 'text' },
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
      // 两种入参形状都要支持：record-list 返回 {items}，record-get 返回矩阵。
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

const { recordChapterCast } = await import('../src/domain/chapter.ts')

const BASE = 'cast-test-base'

beforeEach(() => {
  store.clear()
  tableSchemas.clear()

  seedTable(TABLE.CHAPTER, [
    { name: CHAPTER_F.NO, type: 'number' },
    { name: CHAPTER_F.TITLE, type: 'text' },
    { name: CHAPTER_F.STATUS, type: 'select' },
    { name: CHAPTER_F.CAST, type: 'link' },
  ])
  seedTable(TABLE.CHARACTER, [
    { name: CHARACTER_F.NAME, type: 'text' },
    { name: CHARACTER_F.APPEARANCES, type: 'link' },
  ])
})

function seedChapter(no: number, title = `第 ${no} 章`): string {
  return addRecord(TABLE.CHAPTER, { [CHAPTER_F.NO]: no, [CHAPTER_F.TITLE]: title })
}

function seedCharacter(name: string): string {
  return addRecord(TABLE.CHARACTER, { [CHARACTER_F.NAME]: name })
}

describe('recordChapterCast', () => {
  it('cast 为空 → 无副作用、无警告', async () => {
    const ch3 = seedChapter(3)
    const warnings = await recordChapterCast(BASE, 3, [])
    expect(warnings).toEqual([])
    expect(store.get(TABLE.CHAPTER)!.get(ch3)![CHAPTER_F.CAST]).toBeUndefined()
  })

  it('双向写入：章节.出场人物 ∪ cast，人物.出场章节 ∪ this chapter', async () => {
    const ch1 = seedChapter(1)
    const xiao = seedCharacter('小雪')
    const ye = seedCharacter('叶鸿')

    const warnings = await recordChapterCast(BASE, 1, ['小雪', '叶鸿'])
    expect(warnings).toEqual([])

    const chRec = store.get(TABLE.CHAPTER)!.get(ch1)!
    expect(chRec[CHAPTER_F.CAST]).toEqual([{ id: xiao }, { id: ye }])
    expect(store.get(TABLE.CHARACTER)!.get(xiao)![CHARACTER_F.APPEARANCES]).toEqual([{ id: ch1 }])
    expect(store.get(TABLE.CHARACTER)!.get(ye)![CHARACTER_F.APPEARANCES]).toEqual([{ id: ch1 }])
  })

  it('名字尾随括号注记 → name 提取、note 丢弃；不影响写入', async () => {
    const ch1 = seedChapter(1)
    const lu = seedCharacter('陆铮')

    const warnings = await recordChapterCast(BASE, 1, ['陆铮（不在场）'])
    expect(warnings).toEqual([])

    const chRec = store.get(TABLE.CHAPTER)!.get(ch1)!
    expect(chRec[CHAPTER_F.CAST]).toEqual([{ id: lu }])
    expect(store.get(TABLE.CHARACTER)!.get(lu)![CHARACTER_F.APPEARANCES]).toEqual([{ id: ch1 }])
  })

  it('重复 cast → 幂等：union 去重不滚雪球', async () => {
    const ch1 = seedChapter(1)
    const xiao = seedCharacter('小雪')

    await recordChapterCast(BASE, 1, ['小雪'])
    await recordChapterCast(BASE, 1, ['小雪', '小雪'])

    const chRec = store.get(TABLE.CHAPTER)!.get(ch1)!
    expect(chRec[CHAPTER_F.CAST]).toEqual([{ id: xiao }])
    expect(store.get(TABLE.CHARACTER)!.get(xiao)![CHARACTER_F.APPEARANCES]).toEqual([{ id: ch1 }])
  })

  it('人物已出场过 → 追加本章不抹掉旧出场（union）', async () => {
    const ch1 = seedChapter(1)
    const ch3 = seedChapter(3)
    const xiao = seedCharacter('小雪')

    await recordChapterCast(BASE, 1, ['小雪'])
    await recordChapterCast(BASE, 3, ['小雪'])

    const xiaoRec = store.get(TABLE.CHARACTER)!.get(xiao)!
    expect(xiaoRec[CHARACTER_F.APPEARANCES]).toEqual([{ id: ch1 }, { id: ch3 }])
    expect(store.get(TABLE.CHAPTER)!.get(ch3)![CHAPTER_F.CAST]).toEqual([{ id: xiao }])
  })

  it('名字解析不到 → warning 返回、不阻塞写入', async () => {
    const ch1 = seedChapter(1)
    seedCharacter('小雪')

    const warnings = await recordChapterCast(BASE, 1, ['小雪', '不存在的角色'])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/不存在的角色/)
    // 已解析的仍然写入
    const chRec = store.get(TABLE.CHAPTER)!.get(ch1)!
    expect(chRec[CHAPTER_F.CAST]).toHaveLength(1)
  })

  it('章节记录找不到 → warning 返回、不阻塞后续', async () => {
    seedCharacter('小雪')
    const warnings = await recordChapterCast(BASE, 99, ['小雪'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/第 99 章.*不存在/)
  })
})
