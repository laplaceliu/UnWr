/**
 * 重名字段修复（repairDuplicateFields）的行为测试（纯 mock）。
 *
 * 实机事故 2026-09-03：事件表 `章节`×2（A 独占 12 条、B 独占 43 条、都有 36 条）。
 * 读取侧并集合并（packages/feishu/tests/matrix.spec.ts）先止血，这里守住**根治**：
 * ensureWorkSchema 应改名多余列 → 并集回填 → record-get 验证 → 删除多余列。
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { LINK_FIELDS, TABLE_SCHEMAS } from '@unwr/schema'

interface MockField { id: string; name: string; type: string }

/** 表名 → 字段列表；由各用例自行布置。 */
const fieldState = new Map<string, MockField[]>()
/** 表名 → 记录（recId → 字段id → 单元格值） */
const recordState = new Map<string, Record<string, Record<string, unknown>>>()

const calls = {
  updateField: [] as unknown[][],
  deleteField: [] as string[],
  updateRecords: [] as Record<string, Record<string, unknown>>[],
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

  /** 代码传来的可能是表名或 tbl_ 前缀 id，统一归一回表名 */
  const keyOf = (t: string): string =>
    fieldState.has(t) ? t : fieldState.has(t.replace(/^tbl_/, '')) ? t.replace(/^tbl_/, '') : t

  return {
    FeishuError,
    hintFor: () => '',
    base: {
      listTables: vi.fn(async () => ({
        tables: [...fieldState.keys()].map((name) => ({ name, id: `tbl_${name}` })),
      })),
      createTable: vi.fn(async (_t: string, name: string) => ({ id: `tbl_${name}` })),
      listFields: vi.fn(async (_t: string, table: string) => ({
        fields: (fieldState.get(keyOf(table)) ?? []).map((f) => ({ ...f })),
      })),
      getField: vi.fn(async (_t: string, table: string, fieldId: string) => ({
        field: (fieldState.get(keyOf(table)) ?? []).find((f) => f.id === fieldId)!,
      })),
      updateField: vi.fn(async (_t: string, table: string, fieldId: string, def: Record<string, unknown>) => {
        calls.updateField.push([fieldId, def])
        const f = (fieldState.get(keyOf(table)) ?? []).find((x) => x.id === fieldId)
        if (f !== undefined) f.name = def['name'] as string
        return {}
      }),
      createFields: vi.fn(async () => ({})),
      deleteField: vi.fn(async (_t: string, table: string, fieldId: string) => {
        calls.deleteField.push(fieldId)
        const fs = fieldState.get(keyOf(table))
        if (fs !== undefined) {
          const i = fs.findIndex((x) => x.id === fieldId)
          if (i >= 0) fs.splice(i, 1)
        }
      }),
      listAllRecords: vi.fn(async (_t: string, table: string, opts: { fieldIds?: readonly string[] }) => {
        const name = keyOf(table)
        const fs = fieldState.get(name) ?? []
        const ids = opts.fieldIds ?? fs.map((f) => f.id)
        const data = recordState.get(name) ?? {}
        const recIds = Object.keys(data)
        return {
          fields: fs.filter((f) => ids.includes(f.id)).map((f) => f.name),
          field_id_list: ids,
          field_type_list: ids.map(() => 'link'),
          data: recIds.map((rid) => ids.map((fid) => data[rid]![fid] ?? null)),
          record_id_list: recIds,
        }
      }),
      updateRecords: vi.fn(async (_t: string, table: string, patch: Record<string, Record<string, unknown>>) => {
        calls.updateRecords.push(patch)
        const name = keyOf(table)
        const store = recordState.get(name)
        const fs = fieldState.get(name) ?? []
        if (store !== undefined) {
          for (const [rid, fields] of Object.entries(patch)) {
            // 平台语义：patch 键是字段**名**，落在该名字对应的列上（按 id 存储）
            const mapped: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(fields)) {
              const f = fs.find((x) => x.name === k)
              mapped[f?.id ?? k] = v
            }
            store[rid] = { ...store[rid], ...mapped }
          }
        }
        return { updated: Object.keys(patch).length }
      }),
      getRecords: vi.fn(async (_t: string, table: string, recIds: readonly string[]) => {
        const name = keyOf(table)
        const fs = fieldState.get(name) ?? []
        const store = recordState.get(name) ?? {}
        return {
          fields: fs.map((f) => f.name),
          field_id_list: fs.map((f) => f.id),
          field_type_list: fs.map(() => 'link'),
          data: recIds.map((rid) => fs.map((f) => store[rid]?.[f.id] ?? null)),
          record_id_list: [...recIds],
        }
      }),
    },
    docs: {},
    drive: {},
    wiki: {},
  }
})

const { ensureWorkSchema, verifyRetryDelays } = await import('../src/domain/bootstrap.ts')

/** 实机验证延迟是秒级，测试里压到毫秒级 */
beforeEach(() => {
  verifyRetryDelays.splice(0, verifyRetryDelays.length, 0, 20, 40)
})

/**
 * 按 schema 播种全部 13 张表（普通字段 + link 字段都在），
 * 让建表/补字段/link 三个阶段全部 no-op——本文件只关注重名修复。
 */
beforeEach(() => {
  fieldState.clear()
  recordState.clear()
  for (const [tname, fields] of Object.entries(TABLE_SCHEMAS)) {
    fieldState.set(tname, fields.map((f, i) => ({ id: `fld_${tname}_${i}`, name: f.name, type: f.type })))
    recordState.set(tname, {})
  }
  for (const [tname, links] of Object.entries(LINK_FIELDS)) {
    const fs = fieldState.get(tname)
    if (fs === undefined) continue
    for (const { field } of links) {
      fs.push({ id: `fld_${tname}_${field.name}`, name: field.name, type: 'link' })
    }
  }
  calls.updateField.length = 0
  calls.deleteField.length = 0
  calls.updateRecords.length = 0
})

describe('repairDuplicateFields（经由 ensureWorkSchema 触发）', () => {
  it('重名 link 列：回填缺失值到保留列 → 验证 → 删除多余列', async () => {
    // 事件表：在真实 schema 字段之外补一个同名的 章节 列
    const ev = fieldState.get('事件表')!
    ev.push({ id: 'fldB', name: '章节', type: 'link' })
    const keepId = ev.find((f) => f.name === '章节' && f.id !== 'fldB')!.id
    const store = recordState.get('事件表')!
    store['rec1'] = { [keepId]: [{ id: 'chap1' }], fldB: null }
    store['rec2'] = { [keepId]: null, fldB: [{ id: 'chap2' }] }
    // 两列值相同 = 已完整，无需回填（对应实机 36 条"两边都有"的记录）
    store['rec3'] = { [keepId]: [{ id: 'chap1' }, { id: 'chap2' }], fldB: [{ id: 'chap1' }, { id: 'chap2' }] }

    const r = await ensureWorkSchema('base')

    expect(r.repairedDuplicates).toContain('事件表.章节(2→1)')
    // 1) 多余列被改名为 __legacy__原名__字段id
    const rename = calls.updateField.find(([id]) => id === 'fldB') as
      | [string, { name?: string }] | undefined
    expect(rename?.[1]?.name).toBe('__legacy__章节__fldB')
    // 2) 缺失值回填：只写 rec2（rec1 已有、rec3 已完整）
    expect(calls.updateRecords).toHaveLength(1)
    expect(calls.updateRecords[0]).toEqual({
      rec2: { 章节: [{ id: 'chap2' }] },
    })
    // 3) 验证通过后删除多余列
    expect(calls.deleteField).toEqual(['fldB'])
  })

  it('回填验证失败 → 绝不删除多余列（数据安全优先）', async () => {
    const ev = fieldState.get('事件表')!
    const keepId = ev.find((f) => f.name === '章节')!.id
    ev.push({ id: 'fldB', name: '章节', type: 'link' })
    recordState.get('事件表')!['rec1'] = { [keepId]: null, fldB: [{ id: 'chap2' }] }

    // 模拟写入被平台永久丢弃（最坏情形）：唯一一次写被吞掉，
    // 之后 3 轮验证都读不到 → 修复放弃且不删列
    const feishu = await import('@unwr/feishu') as unknown as {
      base: { updateRecords: Mock }
    }
    feishu.base.updateRecords.mockImplementationOnce(async (_t: string, _table: string, patch: Record<string, Record<string, unknown>>) => {
      calls.updateRecords.push(patch) // 记账但**不**写入 store
      return { updated: Object.keys(patch).length }
    })

    const r = await ensureWorkSchema('base')
    expect(r.repairedDuplicates).not.toContain('事件表.章节(2→1)')
    expect(calls.deleteField).toEqual([])
  })

  it('写入后短暂读旧值 → 退避重试验证通过 → 正常删除（实机 2026-09-03 场景）', async () => {
    const ev = fieldState.get('事件表')!
    const keepId = ev.find((f) => f.name === '章节')!.id
    ev.push({ id: 'fldB', name: '章节', type: 'link' })
    recordState.get('事件表')!['rec1'] = { [keepId]: null, fldB: [{ id: 'chap2' }] }

    // 前 2 次 record-get 读到旧值（写入已发生但读不到），第 3 次起读到新值
    const feishu = await import('@unwr/feishu') as unknown as {
      base: { getRecords: Mock }
    }
    let staleReads = 2
    const original = feishu.base.getRecords.getMockImplementation()
    feishu.base.getRecords.mockImplementation(async (...args: unknown[]) => {
      const impl = original as (...a: unknown[]) => Promise<unknown>
      const res = await impl(...args) as { data: unknown[][] }
      if (staleReads > 0) {
        staleReads--
        return { ...res, data: res.data.map((row) => row.map((c) => null)) }
      }
      return res
    })

    const r = await ensureWorkSchema('base')
    expect(r.repairedDuplicates).toContain('事件表.章节(2→1)')
    expect(calls.deleteField).toEqual(['fldB'])
  })

  it('重名但数据已完整（如全空的关联伏笔×2）→ 直接删除多余列', async () => {
    const ch = fieldState.get('章节表')!
    ch.push(
      { id: 'fldP2', name: '出场人物', type: 'link' },
      { id: 'fldF2', name: '关联伏笔', type: 'link' },
    )
    recordState.get('章节表')!['rec1'] = { fldP2: null, fldF2: null }

    const r = await ensureWorkSchema('base')
    expect(r.repairedDuplicates).toContain('章节表.出场人物(2→1)')
    expect(r.repairedDuplicates).toContain('章节表.关联伏笔(2→1)')
    expect(calls.updateRecords).toHaveLength(0)
    expect([...calls.deleteField].sort()).toEqual(['fldF2', 'fldP2'])
  })

  it('中断续修：遗留 __legacy__ 列归回原组，重跑并集后删除', async () => {
    // 上次修复在改名后、删除前中断
    const st = fieldState.get('人物状态表')!
    st.push({ id: 'fldL', name: '__legacy__章节__fldL', type: 'link' })
    const keepId = st.find((f) => f.name === '章节' && f.id !== 'fldL')!.id
    recordState.get('人物状态表')!['rec1'] = { [keepId]: null, fldL: [{ id: 'chap9' }] }

    const r = await ensureWorkSchema('base')
    expect(r.repairedDuplicates).toContain('人物状态表.章节(2→1)')
    expect(calls.updateField).toHaveLength(0) // 已改过名，不再改
    expect(calls.updateRecords[0]).toEqual({ rec1: { 章节: [{ id: 'chap9' }] } })
    expect(calls.deleteField).toEqual(['fldL'])
  })

  it('无重名的库完全不动', async () => {
    const r = await ensureWorkSchema('base')
    expect(r.repairedDuplicates).toEqual([])
    expect(calls.deleteField).toEqual([])
    expect(calls.updateField).toHaveLength(0)
    expect(calls.updateRecords).toHaveLength(0)
  })
})
