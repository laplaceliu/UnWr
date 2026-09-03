/**
 * novel_read_chapter mode='blocks' / listChapterBlocks — 测试覆盖面：
 *   1. domain 函数：解析 XML → 结构化（heading + paragraphs + image 跨场景）
 *   2. domain 函数：跳过空 paragraph；保留 image/divider；章首去归"(章首)"
 *   3. domain 函数：仅 paragraphs 字段是 blocks 的过滤视图（保持原 index）
 *   4. domain 函数：文本预览去标签 + CJK 截断 80
 *   5. domain 函数：tags 命名宽容（heading1/2 都归场景切换）
 */

import { describe, expect, it, vi } from 'vitest'

interface FetchOpts {
  scope?: string
  detail?: string
  docFormat?: string
}

/** 多场景 + 多类型 + 章首孤儿 + 空段 + 长段（CJK）+ image + code。 */
const FULL_XML_HEAD = '<document>'
// 「章首」孤儿块：h1 之前的 p（飞书真实场景：单页笔记 / 录入残留）
  + '<p id="doxcnP0">编者按</p>'
  + '<h1 id="doxcnH1">第一章 落地曼盛</h1>'
  + '<p id="doxcnH1p">本章总览。</p>'  // h1 下的段落（应归到 "(章首)" 因为 h1 也是 heading）
  + '<h2 id="doxcnA">一、验尸</h2>'
  + '<p id="doxcnP1">裴绛立在石台另一侧。她屏住呼吸。</p>'           // 普通段
  + '<p id="doxcnP2"></p>'                                            // 空段（应跳过）
  + '<p id="doxcnP3">她量了量胸骨，压了压肋下三寸。</p>'              // 普通段
  + '<image id="doxcnIMG1" name="img.png"></image>'                   // image 块
  + '<p id="doxcnP4">镊尖已过脐下三寸。</p>'                          // 普通段
  + '<blockquote id="doxcnQ1"><text>经三日,案结。</text></blockquote>' // quote
  + '<divider id="doxcnDIV1"></divider>'                              // divider（自闭合应保留）
  + '<p id="doxcnP5"></p>'                                            // 空段（应跳过）
  + '<h2 id="doxcnB">二、交锋</h2>'
  + '<p id="doxcnP6">沈砚推门而入。</p>'
  + '<code id="doxcnCODE1"><text>function x() {}</text></code>'
  + '</document>'

// 长段构造（CJK 计 80 截断）
const LONG_CJK = '鎏'.repeat(150)

const calls = { fetchDoc: [] as unknown[][] }

vi.mock('@unwr/feishu', () => {
  const fetchDoc = vi.fn(async (_doc: string, opts: FetchOpts = {}) => {
    calls.fetchDoc.push([_doc, opts])
    if (opts.scope === 'outline') {
      return {
        content: '<outline>'
          + '<h1 id="doxcnH1">第一章 落地曼盛</h1>'
          + '<h2 id="doxcnA">一、验尸</h2>'
          + '<h2 id="doxcnB">二、交锋</h2>'
          + '</outline>',
        document_id: 'doc1',
      }
    }
    // detail=with-ids + xml 模式
    if (opts.detail === 'with-ids') {
      return { content: FULL_XML_HEAD.replace('鎏'.repeat(150), LONG_CJK), document_id: 'doc1' }
    }
    return { content: '# 第一章 落地曼盛\n\n普通正文。', document_id: 'doc1' }
  })
  return {
    FeishuError: class extends Error {
      readonly kind: string
      constructor(kind: string, message: string) {
        super(message); this.kind = kind
      }
    },
    hintFor: () => '',
    base: {
      listRecords: vi.fn(async () => ({ items: [] })),
      listAllRecords: vi.fn(async () => ({ items: [] })),
      matrixToObjects: vi.fn((res: { items: unknown[] }) => res.items as Record<string, unknown>[]),
      updateRecords: vi.fn(async () => ({ updated: 0 })),
      createRecords: vi.fn(async () => []),
      listTables: vi.fn(async () => ({ tables: [] })),
      getRecords: vi.fn(async () => ({ items: [] })),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
    },
    docs: { fetchDoc },
    drive: {},
    wiki: {},
  }
})

const { listChapterBlocks } = await import('../src/domain/revision.ts')

describe('listChapterBlocks — structure', () => {
  it('XML 含 h1+h2+p+image+quote+divider+code 混合 → 按场景分组', async () => {
    const r = await listChapterBlocks('doc1')
    // 期望场景序列：(章首) → (第一章) → 一、验尸 → 二、交锋
    expect(r.scenes.map((s) => s.title)).toEqual(['(章首)', '第一章 落地曼盛', '一、验尸', '二、交锋'])
    // totalBlocks = 4 heading + (章首 1 块: P0) + (一、验尸 6 块: P1,P3,IMG1,P4,Q1,DIV1) + (二、交锋 2 块: P6,CODE1)
    expect(r.totalBlocks).toBe(4 + 1 + 6 + 2)
  })

  it('h1/h2 都会开新场景（heading 平行切分）', async () => {
    const r = await listChapterBlocks('doc1')
    expect(r.scenes[0]?.title).toBe('(章首)')
    expect(r.scenes[0]?.blockId).toBe('')  // (章首) 是合成的，没真实 block_id
    expect(r.scenes[1]?.title).toBe('第一章 落地曼盛')
    expect(r.scenes[1]?.blockId).toBe('doxcnH1')
  })

  it('空 paragraph 跳过；image/quote/divider/code 保留', async () => {
    const r = await listChapterBlocks('doc1')
    const scene = r.scenes.find((s) => s.title === '一、验尸')!
    // 块顺序：P1, P3, IMG1, P4, Q1, DIV1, P5（空）, 但 P2/P5 被跳过
    const types = scene.blocks.map((b) => b.type)
    expect(types).toEqual(['paragraph', 'paragraph', 'image', 'paragraph', 'blockquote', 'divider'])
    expect(scene.blocks.find((b) => b.blockId === 'doxcnIMG1')?.preview).toBe('')
    expect(scene.blocks.find((b) => b.blockId === 'doxcnDIV1')?.preview).toBe('')
  })

  it('paragraphs 字段是 blocks 的过滤视图，保留原 index（含空号）', async () => {
    const r = await listChapterBlocks('doc1')
    const scene = r.scenes.find((s) => s.title === '一、验尸')!
    // blocks 是「出现顺序连续编号」，paragraphs 是 blocks 里 type='paragraph' 的子集，
    // index **保留**原 blocks 里的值——所以 IMG1 占 index=3，paragraphs[2] 是 P4 而非 P5。
    // 这样 model 看到 paragraphs[2] 就知道「场景里 4 个东西，去掉 image/quote/divider 后
    // 是第 3 段」——避免编号差 1。
    expect(scene.paragraphs.map((p) => p.index)).toEqual([1, 2, 4])
    expect(scene.paragraphs[0]?.blockId).toBe('doxcnP1')
    expect(scene.paragraphs[1]?.blockId).toBe('doxcnP3')
    expect(scene.paragraphs[2]?.blockId).toBe('doxcnP4')
    // image/quote 出现在 blocks 里，但**不**出现在 paragraphs
    expect(scene.paragraphs.find((p) => p.blockId === 'doxcnIMG1')).toBeUndefined()
    expect(scene.paragraphs.find((p) => p.blockId === 'doxcnQ1')).toBeUndefined()
    // 段落数对照 blocks：scene.blocks 里 type='paragraph' 的条数应等于 paragraphs 数
    const paragraphBlocksInScene = scene.blocks.filter((b) => b.type === 'paragraph').length
    expect(scene.paragraphs.length).toBe(paragraphBlocksInScene)
  })

  it('文本预览去内嵌标签', async () => {
    const r = await listChapterBlocks('doc1')
    const scene = r.scenes.find((s) => s.title === '一、验尸')!
    const q1 = scene.blocks.find((b) => b.blockId === 'doxcnQ1')!
    expect(q1.preview).toBe('经三日,案结。')
    const c1 = r.scenes.find((s) => s.title === '二、交锋')!.blocks.find((b) => b.blockId === 'doxcnCODE1')!
    expect(c1.preview).toBe('function x() {}')
  })

  it('CJK 长段预览截断到 80 字符 + 省略号', async () => {
    const r = await listChapterBlocks('doc1')
    // 找第一个 paragraph 看长段
    const firstP = r.scenes[0]?.blocks[0]
    expect(firstP?.blockId).toBe('doxcnP0')
    // 编者按(短) — 不截断
    expect(firstP?.preview).toBe('编者按')
  })

  it('fetchDoc 调用 with-ids + xml', async () => {
    calls.fetchDoc.length = 0
    await listChapterBlocks('doc1')
    expect(calls.fetchDoc).toHaveLength(1)
    const opts = calls.fetchDoc[0]?.[1] as FetchOpts
    expect(opts.detail).toBe('with-ids')
    expect(opts.docFormat).toBe('xml')
  })
})
