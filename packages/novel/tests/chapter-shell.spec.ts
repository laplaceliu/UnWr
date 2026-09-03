/**
 * 章节「大纲壳」写入的回归测试（纯 mock，不依赖飞书）
 * ==================================================
 *
 * 起因（实机 2026-09-02 第 1 章死锁）：
 *   `set_chapter_outline` 对不存在的章节会自动建**壳**（有章节号/大纲，
 *   但**没有正文文档链接**）。随后：
 *     novel_write_chapter   → "章节已存在" 拒绝
 *     novel_append_chapter  → "没有正文文档" 拒绝
 *     novel_read_chapter    → "没有正文文档" 拒绝
 *     novel_revise_chapter  → "没有正文文档" 拒绝
 *   四条路全堵死，起草官把整章正文以文本形式交回主会话，主会话重试同样失败。
 *
 * 修复 = writeChapter 增加「填壳」分支（fillChapterShell）+ findChapterRecord
 * 接入写后缓存。本文件守住这两条不变量：
 *   1. 壳场景复用同一条记录建正文，**绝不新建第二条同号记录**
 *   2. 列表索引延迟（模拟：listRecords 查不到刚建的壳）时，靠缓存仍能填壳，
 *      不会退化成"新建第二条同号记录"的静默数据污染
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAPTER_F, CHAPTER_STATUS, TABLE } from '@unwr/schema'

/** 内存里的「飞书 Base」：表 → recordId → 字段。 */
const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.CHAPTER]: {},
  [TABLE.VOLUME]: {},
  作品表: {},
}

/**
 * 模拟飞书列表索引延迟：为 true 时 listRecords 一律返回空
 * （刚写入的记录在平台侧收敛完成前就是查不到的）。
 */
const flags = { indexDelayed: false }
const created = { docs: 0 }

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
      listRecords: vi.fn(async (_token: string, table: string) => {
        if (flags.indexDelayed) return { items: [] }
        return {
          items: Object.entries(store[table] ?? {})
            .map(([id, f]) => ({ __recordId: id, ...f })),
        }
      }),
      listAllRecords: vi.fn(async (_token: string, table: string) => ({
        items: Object.entries(store[table] ?? {})
          .map(([id, f]) => ({ __recordId: id, ...f })),
      })),
      matrixToObjects: vi.fn((res: { items: Array<Record<string, unknown>> }) => res.items),
      updateRecords: vi.fn(async (_token: string, table: string, byId: Record<string, Record<string, unknown>>) => {
        for (const [id, patch] of Object.entries(byId)) {
          if (store[table]?.[id] !== undefined) store[table]![id] = { ...store[table]![id], ...patch }
        }
        return { updated: Object.keys(byId).length }
      }),
      createRecords: vi.fn(async (_token: string, table: string, rows: Record<string, unknown>[]) => {
        const ids: string[] = []
        rows.forEach((row, i) => {
          const id = `rec_new_${table}_${i}_${Object.keys(store[table] ?? {}).length}`
          store[table] = { ...(store[table] ?? {}), [id]: { ...row } }
          ids.push(id)
        })
        return ids
      }),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
      // selfheal 的 verifyLinkBackfill 每次 update 都会先 listTables。
      // 缺这个 stub 会让它抛错 → 误判"link 回填未落库" → 走 3s/6s/9s
      // 三轮退避（每个用例平白慢 18s），掩盖真实断言。
      listTables: vi.fn(async () => ({
        tables: Object.keys(store).map((name) => ({ name, id: name })),
      })),
      getRecords: vi.fn(async (_token: string, table: string, ids: readonly string[]) => ({
        items: ids
          .filter((id) => store[table]?.[id] !== undefined)
          .map((id) => ({ __recordId: id, ...store[table]![id] })),
      })),
    },
    docs: {
      createDoc: vi.fn(async (title: string) => {
        created.docs += 1
        return { document_id: `doc${created.docs}`, url: `https://x.feishu.cn/docx/doc${created.docs}`, title }
      }),
      fetchDoc: vi.fn(async () => ({ document_id: 'doc1', content: '' })),
      appendDoc: vi.fn(async () => ({ revision_id: 1 })),
    },
    drive: {
      extractFolderToken: vi.fn(() => undefined),
      createFolder: vi.fn(async () => ({ folder_token: 'fld1', url: 'https://x.feishu.cn/folder/fld1' })),
    },
    wiki: { listNodes: vi.fn(async () => ({ nodes: [] })) },
  }
})

const { writeChapter } = await import('../src/domain/chapter.ts')
const { rememberChapterRecordId, clearChapterIdCacheForTests } = await import('../src/domain/organize.ts')

beforeEach(() => {
  store[TABLE.CHAPTER] = {}
  store[TABLE.VOLUME] = {}
  store['作品表'] = {}
  flags.indexDelayed = false
  created.docs = 0
  clearChapterIdCacheForTests()
})

/** 造一个「大纲壳」：有章节号与大纲，没有正文文档链接。 */
function seedShell(chapterNo: number, recordId = `rec_ch${chapterNo}`): string {
  store[TABLE.CHAPTER]![recordId] = {
    [CHAPTER_F.NO]: chapterNo,
    [CHAPTER_F.TITLE]: `第 ${chapterNo} 章`,
    [CHAPTER_F.STATUS]: [CHAPTER_STATUS.OUTLINE],
    [CHAPTER_F.OUTLINE]: '场景一：机场错接',
  }
  return recordId
}

describe('writeChapter 填充大纲壳（2026-09-02 死锁回归）', () => {
  it('章节号已存在但无正文文档 → 复用同一条记录建文档并回填，不新建记录', async () => {
    const shellId = seedShell(1)

    const r = await writeChapter('base', {
      chapterNo: 1,
      title: '第一章 落地曼盛',
      content: '## 机场错接\n\n正文。',
    })

    expect(r.recordId).toBe(shellId)
    expect(r.documentUrl).toContain('/docx/')
    expect(created.docs).toBe(1)
    // 关键不变量：章节表只有一条第 1 章记录
    expect(Object.keys(store[TABLE.CHAPTER]!)).toEqual([shellId])

    const row = store[TABLE.CHAPTER]![shellId]!
    expect(row[CHAPTER_F.DOC_URL]).toBe(r.documentUrl)
    expect(row[CHAPTER_F.TITLE]).toBe('第一章 落地曼盛')
    expect(row[CHAPTER_F.STATUS]).toEqual([CHAPTER_STATUS.DRAFT])
    expect(row[CHAPTER_F.WORDS]).toBeGreaterThan(0)
    // 大纲官预填的大纲不能被抹掉（起草官没传 outline）
    expect(row[CHAPTER_F.OUTLINE]).toBe('场景一：机场错接')
  })

  it('列表索引延迟时靠写后缓存命中壳 → 仍不新建第二条同号记录', async () => {
    const shellId = seedShell(1)
    // 模拟 set_chapter_outline 建壳后种下的缓存
    rememberChapterRecordId('base', 1, shellId)
    // 平台侧列表索引尚未收敛：任何 listRecords 都查不到这条记录
    flags.indexDelayed = true

    const r = await writeChapter('base', {
      chapterNo: 1,
      title: '第一章 落地曼盛',
      content: '## 机场错接\n\n正文。',
    })

    expect(r.recordId).toBe(shellId)
    expect(Object.keys(store[TABLE.CHAPTER]!)).toEqual([shellId])
    // 回填仍生效：store 里那条记录拿到了正文链接
    expect(store[TABLE.CHAPTER]![shellId]![CHAPTER_F.DOC_URL]).toBe(r.documentUrl)
  })

  it('章节号未占用 → 走新建路径（回归保护：填壳不得吞掉新建）', async () => {
    const r = await writeChapter('base', {
      chapterNo: 1,
      title: '第一章 落地曼盛',
      content: '## 机场错接\n\n正文。',
    })

    expect(Object.keys(store[TABLE.CHAPTER]!)).toEqual([r.recordId])
    expect(store[TABLE.CHAPTER]![r.recordId]![CHAPTER_F.DOC_URL]).toBe(r.documentUrl)
  })

  it('已有正文文档的章节 → 拒绝并指路 append/revise（不重复建文档）', async () => {
    const shellId = seedShell(1)
    store[TABLE.CHAPTER]![shellId]![CHAPTER_F.DOC_URL] = 'https://x.feishu.cn/docx/existing'

    await expect(writeChapter('base', {
      chapterNo: 1,
      title: '第一章 重写',
      content: '## 新正文',
    })).rejects.toThrow(/novel_append_chapter/)

    expect(created.docs).toBe(0)
    expect(Object.keys(store[TABLE.CHAPTER]!)).toEqual([shellId])
  })
})
