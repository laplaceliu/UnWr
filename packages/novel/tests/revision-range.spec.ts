/**
 * 改稿「块区间」定位的测试（纯 mock，不依赖飞书）
 * ==============================================
 *
 * 背景：lark-cli 的 `block_replace` / `block_delete` 除单块 `--block-id` 外，
 * 还支持 `--start-block-id` + `--end-block-id` 的**兄弟块区间**（两端都包含）：
 *   "inclusive start block ID for a block_replace or block_delete sibling
 *    range; requires --end-block-id and cannot be combined with --block-id"
 *
 * 这正好是「把连续几段合并成一段」的原语。在此之前模型只能
 * replace 首段 + 逐条 delete 其余段（多次调用、中间态还可能写坏）。
 * 2026-09-03 的实机报错（patch 的 match 跨段落被拒）就是被这条限制逼出来的。
 *
 * 本文件守住：
 *   1. scene + startParagraph/endParagraph 正确翻译成块区间，端点都包含
 *   2. 区间替换/删除真的以区间形式下发给 CLI（不是悄悄退化成单块）
 *   3. 单段 / 单块定位**不**被新代码改坏（仍下发单块 id）
 *   4. 区间操作会提示旧 block_id 失效
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 构造用的文档结构：两个场景，第一场景 4 段、第二场景 1 段。 */
const OUTLINE_XML = '<outline>'
  + '<h1 id="doxcnH1">第一章 落地曼盛</h1>'
  + '<h2 id="doxcnA">一、验尸</h2>'
  + '<h2 id="doxcnB">二、交锋</h2>'
  + '</outline>'

const FULL_XML = '<document>'
  + '<h1 id="doxcnH1">第一章 落地曼盛</h1>'
  + '<h2 id="doxcnA">一、验尸</h2>'
  + '<p id="doxcnP1">裴绛立在石台另一侧。</p>'
  + '<p id="doxcnP2">她量了量胸骨。</p>'
  + '<p id="doxcnP3">又量了骶骨。</p>'
  + '<p id="doxcnP4">镊尖已过脐下三寸。</p>'
  + '<h2 id="doxcnB">二、交锋</h2>'
  + '<p id="doxcnP5">沈砚推门而入。</p>'
  + '</document>'

interface FetchOpts {
  scope?: string
  detail?: string
  docFormat?: string
}

const calls = {
  blockReplace: [] as unknown[][],
  blockDelete: [] as unknown[][],
  blockInsertAfter: [] as unknown[][],
}

vi.mock('@unwr/feishu', () => {
  const fetchDoc = vi.fn(async (_doc: string, opts: FetchOpts = {}) => ({
    content: opts.scope === 'outline' ? OUTLINE_XML : FULL_XML,
    document_id: 'doc1',
  }))
  return {
    FeishuError: class extends Error {
      readonly kind: string
      constructor(kind: string, message: string) {
        super(message)
        this.kind = kind
      }
    },
    hintFor: () => '',
    base: {
      // resolveChapterDoc 用：返回一条带正文链接的章节记录
      listRecords: vi.fn(async () => ({
        items: [{ __recordId: 'rec1', 章节号: 4, 正文文档: 'https://x.feishu.cn/docx/doc1' }],
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
      blockInsertAfter: vi.fn(async (...a: unknown[]) => {
        calls.blockInsertAfter.push(a)
        return { revision_id: 2, url: 'https://x.feishu.cn/docx/doc1', result: 'success' }
      }),
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

const BASE = 'range-test-base'
const CONTENT = '她把镊尖停在腹腔焦炭之上，候了一息。'

beforeEach(() => {
  calls.blockReplace.length = 0
  calls.blockDelete.length = 0
  calls.blockInsertAfter.length = 0
})

describe('paragraph 区间 → 块区间（两端都包含）', () => {
  it('replace 第 2-4 段 → 一次性替换整个区间', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', startParagraph: 2, endParagraph: 4 },
    })

    expect(r.locatedBy).toBe('range')
    expect(r.paragraphRange).toEqual({ from: 2, to: 4 })
    // 起始块 id 上报（结果里 blockId 对区间而言是起点）
    expect(r.blockId).toBe('doxcnP2')
    // 关键：下发给 CLI 的是**区间**，不是单块
    expect(calls.blockReplace).toHaveLength(1)
    expect(calls.blockReplace[0]?.[1]).toEqual({
      startBlockId: 'doxcnP2',
      endBlockId: 'doxcnP4',
    })
    expect(calls.blockReplace[0]?.[2]).toBe(CONTENT)
  })

  it('delete 第 2-3 段 → 区间删除（一次调用清理多段）', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'delete',
      target: { scene: '一、验尸', startParagraph: 2, endParagraph: 3 },
    })

    expect(r.locatedBy).toBe('range')
    expect(calls.blockDelete).toHaveLength(1)
    expect(calls.blockDelete[0]?.[1]).toEqual({
      startBlockId: 'doxcnP2',
      endBlockId: 'doxcnP3',
    })
  })

  it('相邻两段（from+1 == to）也走区间', async () => {
    await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', startParagraph: 1, endParagraph: 2 },
    })
    expect(calls.blockReplace[0]?.[1]).toEqual({
      startBlockId: 'doxcnP1',
      endBlockId: 'doxcnP2',
    })
  })

  it('区间跨度 >2 段时警告中间的非段落块会被连带处理', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', startParagraph: 1, endParagraph: 4 },
    })
    expect(r.warnings.join('\n')).toMatch(/非段落块/)
  })

  it('区间操作提示旧 block_id 失效', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', startParagraph: 2, endParagraph: 3 },
    })
    expect(r.warnings.join('\n')).toMatch(/旧 block_id 全部失效/)
  })

  it('段落序号超出范围 → LocateError 并列出候选', async () => {
    await expect(reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', startParagraph: 2, endParagraph: 99 },
    })).rejects.toThrow(/没有第 99 段/)
  })
})

describe('startBlockId/endBlockId 直接给块区间', () => {
  it('原样下发给 CLI', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { startBlockId: 'doxcnP1', endBlockId: 'doxcnP3' },
    })
    expect(r.locatedBy).toBe('range')
    expect(calls.blockReplace[0]?.[1]).toEqual({
      startBlockId: 'doxcnP1',
      endBlockId: 'doxcnP3',
    })
  })
})

describe('回归：单块定位不得被区间改动带偏', () => {
  it('scene + paragraph（单段）仍下发单块 id 字符串', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '一、验尸', paragraph: 3 },
    })
    expect(r.locatedBy).toBe('paragraph')
    expect(r.paragraphIndex).toBe(3)
    expect(calls.blockReplace[0]?.[1]).toBe('doxcnP3')
    expect(r.warnings.join('\n')).not.toMatch(/旧 block_id 全部失效/)
  })

  it('blockId 单块仍下发字符串', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { blockId: 'doxcnP2' },
    })
    expect(r.locatedBy).toBe('blockId')
    expect(calls.blockReplace[0]?.[1]).toBe('doxcnP2')
  })

  it('expand 单块插入仍然正常（区间已在守卫层拒绝）', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'expand',
      content: CONTENT,
      target: { scene: '一、验尸', paragraph: 2 },
    })
    expect(r.locatedBy).toBe('paragraph')
    expect(calls.blockInsertAfter[0]?.[1]).toBe('doxcnP2')
  })

  it('scene 整场景替换仍下发该场景标题块 id', async () => {
    const r = await reviseChapter(BASE, 4, {
      action: 'replace',
      content: CONTENT,
      target: { scene: '二、交锋' },
    })
    expect(r.locatedBy).toBe('scene')
    expect(calls.blockReplace[0]?.[1]).toBe('doxcnB')
  })
})
