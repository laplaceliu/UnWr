/**
 * novel_manage_outline action=delete_chapter_outline 单元测试。
 *
 * 修复 2026-09-04 实机踩坑：智能体漏传 workToken 把鸦骨账第 25 章大纲写到了
 * 当前作品。清理时无删除工具，只能写「（误写入条目，已清理）」注释占位。
 * 本测试覆盖 deleteChapterOutline 的：
 *   1. 章节不存在 → 幂等返回
 *   2. 章节有正文（docx 关联）→ 拒绝删除并指明 docx
 *   3. 章节有正文 + force=true → 强行删（warnings 明确孤儿风险）
 *   4. 章节有字数但无 docx 关联 → 拒绝删除（保护正文）
 *   5. 章节无正文 → 成功删除
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// 轻量级 store：key=table, value=Record<recordId, fields>
const store: Record<string, Record<string, Record<string, unknown>>> = {
  章节表: {},
}
let counter = 0

vi.mock('@unwr/feishu', () => {
  class FeishuError extends Error {
    readonly kind: string
    readonly code?: number
    constructor(kind: string, message: string, code?: number) {
      super(message)
      this.kind = kind
      this.code = code
    }
  }
  return {
    FeishuError,
    hintFor: () => '',
    base: {
      listRecords: vi.fn(async (_baseToken: string, table: string, opts?: { filter?: { conditions?: unknown[] } }) => {
        const items = Object.entries(store[table] ?? {}).map(([id, fields]) => ({
          __recordId: id, ...fields,
        }))
        if (opts?.filter?.conditions !== undefined) {
          return {
            items: items.filter((row) => {
              return opts.filter!.conditions!.every((cond) => {
                const c = cond as [string, string, unknown]
                const [field, op, value] = c
                if (op !== '==') return true
                return row[field] === value
              })
            }),
          }
        }
        return { items }
      }),
      matrixToObjects: vi.fn((res: { items?: Array<Record<string, unknown>> }) => {
        // 兼容 record-list 的 {items} 与 record-get 的 {data, fields, record_id_list}
        if (res.items !== undefined) return res.items
        const r = res as unknown as { record_id_list: string[]; data: unknown[][]; fields: string[] }
        if (r.record_id_list !== undefined && r.data !== undefined) {
          return r.record_id_list.map((id, i) => {
            const row: Record<string, unknown> = { __recordId: id }
            for (let j = 0; j < r.fields.length; j++) {
              row[r.fields[j]!] = r.data[i]?.[j]
            }
            return row
          })
        }
        return []
      }),
      deleteRecords: vi.fn(async (_baseToken: string, table: string, recordIds: readonly string[]) => {
        for (const id of recordIds) {
          delete store[table]?.[id]
        }
        return undefined
      }),
      listTables: vi.fn(async () => ({ tables: Object.keys(store).map((n) => ({ name: n, id: n })) })),
      getRecords: vi.fn(async (_baseToken: string, table: string, recordIds: readonly string[]) => {
        return {
          items: recordIds
            .filter((id) => store[table]?.[id] !== undefined)
            .map((id) => ({ __recordId: id, ...store[table]![id] })),
        }
      }),
      createRecords: vi.fn(async (_baseToken: string, table: string, rows: Record<string, unknown>[]) => {
        const ids: string[] = []
        for (const row of rows) {
          counter += 1
          const id = `rec${counter}`
          store[table]![id] = { ...row }
          ids.push(id)
        }
        return ids
      }),
    },
  }
})

import { base } from '@unwr/feishu'
import { deleteChapterOutline } from '../src/domain/entity.ts'
import {
  clearChapterIdCacheForTests, rememberChapterRecordId,
} from '../src/domain/organize.ts'

const BASE = 'baseTEST_aaaaaaaaaaaaaa01'

beforeEach(() => {
  store['章节表'] = {}
  counter = 0
  vi.mocked(base.deleteRecords).mockClear()
  clearChapterIdCacheForTests()
})

describe('deleteChapterOutline', () => {
  it('章节不存在 → 幂等返回，deleted=false，warnings 解释', async () => {
    const r = await deleteChapterOutline(BASE, 25)
    expect(r.deleted).toBe(false)
    expect(r.blockedByContent).toBe(false)
    expect(r.recordId).toBeUndefined()
    expect(r.warnings[0]).toContain('第 25 章不存在')
    expect(base.deleteRecords).not.toHaveBeenCalled()
  })

  it('章节无正文（无 docx 关联 + 字数 0）→ 成功删除', async () => {
    // 准备 store：章节号 25 的章壳，无正文
    counter = 1
    store['章节表']!['recCHAPTER25'] = { 章节号: 25, 字数: 0 }
    rememberChapterRecordId(BASE, 25, 'recCHAPTER25')

    const r = await deleteChapterOutline(BASE, 25, { reason: '误写入鸦骨账条目' })
    expect(r.deleted).toBe(true)
    expect(r.blockedByContent).toBe(false)
    expect(r.recordId).toBe('recCHAPTER25')
    expect(r.words).toBe(0)
    expect(r.docUrl).toBeUndefined()
    expect(r.warnings).toEqual([])
    expect(base.deleteRecords).toHaveBeenCalledWith(BASE, expect.any(String), ['recCHAPTER25'], undefined)
    // 删后 store 真的没了
    expect(store['章节表']!['recCHAPTER25']).toBeUndefined()
  })

  it('删除成功 → 清缓存（避免同会话内被旧 recordId 命中）', async () => {
    counter = 1
    store['章节表']!['recCHAPTER25'] = { 章节号: 25, 字数: 0 }
    rememberChapterRecordId(BASE, 25, 'recCHAPTER25')

    // 直接用 spy 验证副作用
    const orgModule = await import('../src/domain/organize.ts')
    const spy = vi.spyOn(orgModule, 'forgetChapterRecordId')
    await deleteChapterOutline(BASE, 25)
    expect(spy).toHaveBeenCalledWith(BASE, 25)
    spy.mockRestore()
  })

  it('章节有 docx 关联 → 拒绝删除，指明 docx', async () => {
    counter = 1
    store['章节表']!['recCHAPTER25'] = {
      章节号: 25, 字数: 0, 正文文档: 'https://my.feishu.cn/docx/DOCHAVE',
    }
    rememberChapterRecordId(BASE, 25, 'recCHAPTER25')

    const r = await deleteChapterOutline(BASE, 25, { reason: '测试拒绝路径' })
    expect(r.deleted).toBe(false)
    expect(r.blockedByContent).toBe(true)
    expect(r.docUrl).toBe('https://my.feishu.cn/docx/DOCHAVE')
    expect(r.warnings[0]).toContain('已有正文')
    expect(r.warnings[0]).toContain('DOCHAVE')
    expect(r.warnings[0]).toContain('force=true')
    expect(base.deleteRecords).not.toHaveBeenCalled()
    // store 还在
    expect(store['章节表']!['recCHAPTER25']).toBeDefined()
  })

  it('章节有字数但无 docx 关联 → 拒绝删除', async () => {
    counter = 1
    store['章节表']!['recCHAPTER25'] = { 章节号: 25, 字数: 3200 }
    rememberChapterRecordId(BASE, 25, 'recCHAPTER25')

    const r = await deleteChapterOutline(BASE, 25)
    expect(r.deleted).toBe(false)
    expect(r.blockedByContent).toBe(true)
    expect(r.words).toBe(3200)
    expect(r.warnings[0]).toContain('字数=3200')
    expect(base.deleteRecords).not.toHaveBeenCalled()
  })

  it('章节有正文 + force=true → 强行删，warnings 明确孤儿风险', async () => {
    counter = 1
    store['章节表']!['recCHAPTER25'] = {
      章节号: 25, 字数: 1200, 正文文档: 'https://my.feishu.cn/docx/DOCHAVE',
    }
    rememberChapterRecordId(BASE, 25, 'recCHAPTER25')

    const r = await deleteChapterOutline(BASE, 25, {
      force: true,
      reason: '用户主动确认删 docx',
    })
    expect(r.deleted).toBe(true)
    expect(r.blockedByContent).toBe(false)
    expect(r.warnings[0]).toContain('force=true')
    expect(r.warnings[0]).toContain('字数=1200')
    expect(r.warnings[0]).toContain('DOCHAVE')
    expect(r.warnings[0]).toContain('孤儿')
    expect(base.deleteRecords).toHaveBeenCalled()
  })
})
