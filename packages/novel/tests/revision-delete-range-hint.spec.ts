/**
 * 实机 2026-09-03 第 5 章：模型准备删 28-44 段占位段落，先调了
 * `replace + scene + startParagraph=28 + endParagraph=44 + content=''`
 * 撞到「content 不能为空」错误信息。错误文案只点 action=delete，但**没点
 * delete 也能用区间**，于是模型准备逐段 delete 17 次。
 *
 * 修复：把 "改成 action=delete + 同样的 range" 这条提示加进 error 文案。
 * 本 spec 守住：
 *   1. 实机原 payload（replace+range+content=''） → 错误信息明确说
 *      「action=delete + 同样的区间定位、一次调用就够、不要逐段 17 次」
 *   2. action=delete + scene + startParagraph/endParagraph → 一次调用就删，
 *      不走到逐段路径
 *   3. replace+range+content='' 的错误**不**调 CLI（blockDelete 还是 0 次）—
 *      这条守卫必须在解析之前拦住
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { reviseChapter as _rc } from '../src/domain/revision.ts'

const OUTLINE_XML = '<outline>'
  + '<h1 id="doxcnH1">第五章</h1>'
  + '<h2 id="doxcnA">一、绕三个弯</h2>'
  + '</outline>'

const FULL_XML = '<document>'
  + '<h1 id="doxcnH1">第五章</h1>'
  + '<h2 id="doxcnA">一、绕三个弯</h2>'
  // 17 个段落占位（实机 28-44 在那个真实文书里，这里 1-17 等价）
  + Array.from({ length: 17 }, (_, i) => `<p id="doxcnP${i + 1}">占位段 ${i + 1}</p>`).join('')
  + '<p id="doxcnP18">正段保留。</p>'
  + '</document>'

interface FetchOpts {
  scope?: string
  detail?: string
  docFormat?: string
}

const calls = {
  blockReplace: [] as unknown[][],
  blockDelete: [] as unknown[][],
}

vi.mock('@unwr/feishu', () => {
  const fetchDoc = vi.fn(async (_doc: string, opts: FetchOpts = {}) => ({
    content: opts.scope === 'outline' ? OUTLINE_XML : FULL_XML,
    document_id: 'doc1',
  }))
  return {
    FeishuError: class extends Error {
      readonly kind: string
      constructor(kind: string, message: string) { super(message); this.kind = kind }
    },
    hintFor: () => '',
    base: {
      listRecords: vi.fn(async () => ({
        items: [{ __recordId: 'rec1', 章节号: 5, 正文文档: 'https://x.feishu.cn/docx/doc1' }],
      })),
      listAllRecords: vi.fn(async () => ({ items: [] })),
      matrixToObjects: vi.fn((res: { items: unknown[] }) => res.items as Record<string, unknown>[]),
      updateRecords: vi.fn(async () => ({ updated: 1 })),
      createRecords: vi.fn(async () => ['rec1']),
      listTables: vi.fn(async () => ({ tables: [] })),
      getRecords: vi.fn(async () => ({ items: [] })),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
    },
    docs: {
      fetchDoc,
      blockReplace: vi.fn(async (...a: unknown[]) => {
        calls.blockReplace.push(a)
        return { revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success' }
      }),
      blockDelete: vi.fn(async (...a: unknown[]) => {
        calls.blockDelete.push(a)
        return { revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success' }
      }),
      blockInsertAfter: vi.fn(async () => ({
        revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success',
      })),
      strReplace: vi.fn(async () => ({
        revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success',
      })),
      appendDoc: vi.fn(async () => ({
        revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success',
      })),
      listDocHistory: vi.fn(async () => ({ entries: [] })),
    },
    drive: {},
    wiki: {},
  }
})

const { reviseChapter } = await import('../src/domain/revision.ts')

type ReviseCall = Parameters<typeof _rc>[2]
const mk = (overrides: Partial<ReviseCall>): ReviseCall => ({
  action: 'replace',
  ...overrides,
} as ReviseCall)

const BASE = 'delete-range-test-base'

beforeEach(() => {
  calls.blockReplace.length = 0
  calls.blockDelete.length = 0
})

describe('replace+range+空 content → 自纠正文案', () => {
  it('【实机 2026-09-03 第 5 章】报错必须点「action=delete + 同样 range、一次调用、不要逐段 N 次」', async () => {
    let caught: Error | null = null
    try {
      await reviseChapter(BASE, 5, mk({
        action: 'replace',
        content: '',
        target: { scene: '一、绕三个弯', startParagraph: 28, endParagraph: 44 } as never,
      }))
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    // 报错必须指 delete 也能用 range——这是修复的核心改动
    expect(caught!.message).toMatch(/action\s*=\s*delete|改用\s*action\s*=\s*delete/)
    // 必须点"一次调用"——告诉模型不要再走 17 次循环
    expect(caught!.message).toMatch(/一次调用|一次即可/)
  })

  it('replace+单块+空 content（无 range）→ 报错指「delete + blockId」', async () => {
    let caught: Error | null = null
    try {
      await reviseChapter(BASE, 5, mk({
        action: 'replace',
        content: '',
        target: { blockId: 'doxcnP1' } as never,
      }))
    } catch (e) {
      caught = e as Error
    }
    expect(caught!.message).toMatch(/action\s*=\s*delete|改用\s*action\s*=\s*delete/)
    // 没有 range，所以不该提到 startParagraph
    expect(caught!.message).not.toMatch(/startParagraph/)
  })

  it('replace+range+空 content（错误路径）→ 不发 CLI（blockReplace 0 次）', async () => {
    try {
      await reviseChapter(BASE, 5, mk({
        action: 'replace',
        content: '',
        target: { scene: '一、绕三个弯', startParagraph: 1, endParagraph: 3 } as never,
      }))
    } catch { /* expect throw */ }
    // 入参校验必须先 throw，不让任何 CLI 调用发出（不然落库前拦不住）
    expect(calls.blockReplace).toHaveLength(0)
    expect(calls.blockDelete).toHaveLength(0)
  })
})

describe('action=delete + scene + 段落区间 → 区间版清理', () => {
  it('一次 delete 调 blockDelete 删完 17 段占位', async () => {
    const r = await reviseChapter(BASE, 5, mk({
      action: 'delete',
      target: { scene: '一、绕三个弯', startParagraph: 1, endParagraph: 17 } as never,
    }))
    // 正是修复想让模型走对的那条路：一次调用 17 段连删
    expect(calls.blockDelete).toHaveLength(1)
    expect(r.locatedBy).toBe('range')
    // 块端点 = 第一段头/最后段尾
    const args = calls.blockDelete[0]!
    expect(args[1]).toEqual({
      startBlockId: 'doxcnP1',
      endBlockId: 'doxcnP17',
    })
  })

  it('delete 单块 → 仍按单块下发（不被新代码误伤）', async () => {
    const r = await reviseChapter(BASE, 5, mk({
      action: 'delete',
      target: { blockId: 'doxcnP1' } as never,
    }))
    expect(calls.blockDelete).toHaveLength(1)
    expect(r.locatedBy).toBe('blockId')
    expect(calls.blockDelete[0]?.[1]).toBe('doxcnP1')
  })

  it('delete + startBlockId/endBlockId 区间 → 等价于段落区间路径', async () => {
    const r = await reviseChapter(BASE, 5, mk({
      action: 'delete',
      target: { startBlockId: 'doxcnP5', endBlockId: 'doxcnP10' } as never,
    }))
    expect(calls.blockDelete).toHaveLength(1)
    expect(r.locatedBy).toBe('range')
    expect(calls.blockDelete[0]?.[1]).toEqual({
      startBlockId: 'doxcnP5',
      endBlockId: 'doxcnP10',
    })
  })
})
