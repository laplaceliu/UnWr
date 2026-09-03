/**
 * 改稿「回滚到历史版本」的测试（纯 mock，不依赖飞书）
 * ====================================================
 *
 * 背景：lark-cli 的 docs +history-revert 把文档恢复到指定 history_version_id，
 * 是改稿的安全网（Tier 5）。novel_restore_chapter 提供两种定位入口：
 *   • revisionId —— 来自 novel_get_chapter_history 的友好版本号（自动翻页解析）
 *   • historyVersionId —— 直接传 history_version_id（跳过翻页）
 *
 * 本文件守住：
 *   1. revisionId → 翻页找到 historyVersionId → 真正下发 revert
 *   2. historyVersionId 直传 → 跳过翻页
 *   3. 多匹配（同 revisionId 命中多条） → 抛错并列出候选
 *   4. 找不到 revisionId → 抛错
 *   5. revert 任务 failed → 抛错
 *   6. partial_failed → result 里有 failedBlockTokens + warning
 *   7. waitTimeoutMs=0 → status='running' + taskId，不阻塞
 *   8. happy path 默认会回写章节表 WORDS + STATUS='REVISING'
 *   9. updateWordCount=false 跳过字数/回写跳过
 *  10. 参数校验：都不传抛错
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreChapterVersion } from '../src/domain/revision.ts'

// 用 vi.hoisted 把引用对象提到 import 之前，让 vi.mock 工厂能赋值（否则 beforeEach
// 跑时 refs 还是 undefined）。vi.mock 工厂会被 hoist 到文件顶部，所以必须用 hoisted
// 创建引用容器。
const mockRefs = vi.hoisted(() => ({
  fetchDoc: undefined as unknown as ReturnType<typeof vi.fn>,
  listDocHistory: undefined as unknown as ReturnType<typeof vi.fn>,
  revertDocToVersion: undefined as unknown as ReturnType<typeof vi.fn>,
  updateRecords: undefined as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('@unwr/feishu', () => {
  const fetchDoc = vi.fn(async () => ({
    content: '她把镊尖停在腹腔焦炭之上。\n她量了量胸骨。',
    document_id: 'doc1',
  }))
  const listDocHistory = vi.fn(async (_doc: string, ps?: number) => {
    if (ps === 1) {
      return { entries: [{
        revision_id: 43,
        history_version_id: 'ver43',
        edit_time: '2026-09-03T10:00:00+08:00',
      }] }
    }
    const all = [
      { revision_id: 45, history_version_id: 'ver45', edit_time: '2026-09-03T11:00:00+08:00' },
      { revision_id: 44, history_version_id: 'ver44', edit_time: '2026-09-03T10:30:00+08:00' },
      { revision_id: 43, history_version_id: 'ver43', edit_time: '2026-09-03T10:00:00+08:00' },
      { revision_id: 42, history_version_id: 'ver42', edit_time: '2026-09-02T18:00:00+08:00' },
      { revision_id: 41, history_version_id: 'ver41', edit_time: '2026-09-02T17:00:00+08:00' },
    ]
    return { entries: all.slice(0, ps ?? 20) }
  })
  // 把测试想看的 raw 字段（status/_id/_tokens）转成实现代码期待的 camelCase 形态。
  // 实现侧 revertDocToVersion 的逻辑被简化重现在这里。
  const revertDocToVersion = vi.fn(async (_doc: string, vid: string) => {
    // default mock: 全部成功，指向传入的 historyVersionId
    return {
      status: 'done' as const,
      historyVersionId: vid,
    }
  })
  const updateRecords = vi.fn(async () => ({ updated: 1 }))

  mockRefs.fetchDoc = fetchDoc
  mockRefs.listDocHistory = listDocHistory
  mockRefs.revertDocToVersion = revertDocToVersion
  mockRefs.updateRecords = updateRecords

  return {
    FeishuError: class extends Error {
      readonly kind: string
      constructor(kind: string, message: string) { super(message); this.kind = kind }
    },
    hintFor: () => '',
    base: {
      listRecords: vi.fn(async () => ({
        items: [{ __recordId: 'rec1', 章节号: 4, 正文文档: 'https://x.feishu.cn/docx/doc1' }],
      })),
      listAllRecords: vi.fn(async () => ({ items: [] })),
      matrixToObjects: vi.fn((res: { items: unknown[] }) => res.items as Record<string, unknown>[]),
      updateRecords,
      createRecords: vi.fn(async () => ['rec1']),
      listTables: vi.fn(async () => ({ tables: [] })),
      getRecords: vi.fn(async () => ({ items: [] })),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
    },
    docs: { fetchDoc, listDocHistory, revertDocToVersion },
    drive: {},
    wiki: {},
  }
})

// @unwr/schema 提供静态枚举，本测试不需要在这里 mock；mock 后 revision.ts 静态导入的是真模块。
const BASE = 'restore-test-base'

beforeEach(() => {
  mockRefs.revertDocToVersion.mockClear()
  mockRefs.listDocHistory.mockClear()
  mockRefs.updateRecords.mockClear()
  mockRefs.fetchDoc.mockClear()
  mockRefs.revertDocToVersion.mockResolvedValue({ status: 'done', history_version_id: 'ver42' })
  mockRefs.listDocHistory.mockImplementation(async (_doc: string, ps?: number) => {
    if (ps === 1) {
      return { entries: [{
        revision_id: 43, history_version_id: 'ver43', edit_time: '2026-09-03T10:00:00+08:00',
      }] }
    }
    const all = [
      { revision_id: 45, history_version_id: 'ver45', edit_time: '2026-09-03T11:00:00+08:00' },
      { revision_id: 44, history_version_id: 'ver44', edit_time: '2026-09-03T10:30:00+08:00' },
      { revision_id: 43, history_version_id: 'ver43', edit_time: '2026-09-03T10:00:00+08:00' },
      { revision_id: 42, history_version_id: 'ver42', edit_time: '2026-09-02T18:00:00+08:00' },
      { revision_id: 41, history_version_id: 'ver41', edit_time: '2026-09-02T17:00:00+08:00' },
    ]
    return { entries: all.slice(0, ps ?? 20) }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('happy path: revisionId → 翻页 → revert → fetch → 回写', () => {
  it('默认回写章节表 WORDS + STATUS=REVISING', async () => {
    const r = await restoreChapterVersion(BASE, 4, { revisionId: 42 })

    expect(r.status).toBe('done')
    expect(r.revertedTo).toEqual({
      revisionId: 42,
      historyVersionId: 'ver42',
      editTime: '2026-09-02T18:00:00+08:00',
    })
    expect(mockRefs.revertDocToVersion.mock.calls).toHaveLength(1)
    expect(mockRefs.revertDocToVersion.mock.calls[0]?.[0]).toBe('doc1')
    expect(mockRefs.revertDocToVersion.mock.calls[0]?.[1]).toBe('ver42')
    expect(mockRefs.revertDocToVersion.mock.calls[0]?.[2]).toBe(30000)

    expect(mockRefs.fetchDoc.mock.calls).toHaveLength(1)
    expect(typeof r.newWords).toBe('number')
    expect(r.newWords).toBeGreaterThan(0)

    expect(mockRefs.updateRecords.mock.calls).toHaveLength(1)
    const updateArg = mockRefs.updateRecords.mock.calls[0]?.[2] as Record<string, Record<string, unknown>>
    expect(updateArg).toHaveProperty('rec1')
    expect(updateArg!.rec1).toMatchObject({ 字数: r.newWords })
    expect((updateArg!.rec1!.状态 as unknown[])[0]).toBe('修订')

    expect(r.newRevisionId).toBe(43)
    expect(r.newHistoryVersionId).toBe('ver43')
  })

  it('updateWordCount=false 跳过 fetch + 不回写', async () => {
    const r = await restoreChapterVersion(BASE, 4, {
      revisionId: 42,
      updateWordCount: false,
    })
    expect(r.status).toBe('done')
    expect(r.newWords).toBeUndefined()
    expect(mockRefs.fetchDoc.mock.calls).toHaveLength(0)
    expect(mockRefs.updateRecords.mock.calls).toHaveLength(0)
  })
})

describe('historyVersionId 直传 → 跳过翻页', () => {
  it('不再调 listDocHistory 翻页', async () => {
    const r = await restoreChapterVersion(BASE, 4, { historyVersionId: 'ver-direct' })

    expect(r.status).toBe('done')
    expect(r.revertedTo.historyVersionId).toBe('ver-direct')
    expect(r.revertedTo.revisionId).toBeNaN()
    expect(r.revertedTo.editTime).toBe('')
    expect(mockRefs.revertDocToVersion.mock.calls[0]?.[1]).toBe('ver-direct')
  })
})

describe('同 revisionId 命中多条历史（ambiguous）', () => {
  it('listDocHistory 翻页返回两条 revisionId=42 → 抛错并列出候选', async () => {
    mockRefs.listDocHistory.mockImplementation(async (_doc: string, ps?: number) => ({
      entries: [
        { revision_id: 42, history_version_id: 'ver42-a', edit_time: '2026-09-02T18:00:00+08:00' },
        { revision_id: 42, history_version_id: 'ver42-b', edit_time: '2026-09-02T18:00:01+08:00' },
        { revision_id: 41, history_version_id: 'ver41', edit_time: '2026-09-02T17:00:00+08:00' },
      ].slice(0, ps ?? 20),
    }))

    await expect(
      restoreChapterVersion(BASE, 4, { revisionId: 42 }),
    ).rejects.toThrow(/命中 2 条历史.*改传 historyVersionId.*ver42-a.*ver42-b/s)
    expect(mockRefs.revertDocToVersion.mock.calls).toHaveLength(0)
  })
})

describe('revisionId 在历史中不存在', () => {
  it('listDocHistory 翻页穷尽都找不到 → 抛错', async () => {
    mockRefs.listDocHistory.mockImplementation(async (_doc: string, ps?: number) => ({
      entries: [
        { revision_id: 99, history_version_id: 'ver99', edit_time: '2026-09-02T19:00:00+08:00' },
        { revision_id: 98, history_version_id: 'ver98', edit_time: '2026-09-02T18:30:00+08:00' },
      ].slice(0, ps ?? 20),
    }))

    await expect(
      restoreChapterVersion(BASE, 4, { revisionId: 42 }),
    ).rejects.toThrow(/找不到 revisionId=42/)
    expect(mockRefs.revertDocToVersion.mock.calls).toHaveLength(0)
  })
})

describe('revert 任务最终状态分支', () => {
  it('status=failed → 抛错（不静默）', async () => {
    mockRefs.revertDocToVersion.mockResolvedValueOnce({ status: 'failed' })

    await expect(
      restoreChapterVersion(BASE, 4, { historyVersionId: 'ver-x' }),
    ).rejects.toThrow(/docs \+history-revert 任务失败/)
  })

  it('status=partial_failed → result 含 failedBlockTokens + warning', async () => {
    mockRefs.revertDocToVersion.mockResolvedValueOnce({
      status: 'partial_failed',
      historyVersionId: 'ver-x',
      failedBlockTokens: ['blkBad1', 'blkBad2'],
    })

    const r = await restoreChapterVersion(BASE, 4, { historyVersionId: 'ver-x' })
    expect(r.status).toBe('partial_failed')
    expect(r.failedBlockTokens).toEqual(['blkBad1', 'blkBad2'])
    expect(r.warnings.some((w) => w.includes('revert 部分块失败'))).toBe(true)
  })

  it('status=running（waitTimeoutMs=0） → 不阻塞，返回 taskId + warning', async () => {
    mockRefs.revertDocToVersion.mockResolvedValueOnce({
      status: 'running',
      taskId: 'task-restore-1',
    })

    const r = await restoreChapterVersion(BASE, 4, {
      historyVersionId: 'ver-x',
      waitTimeoutMs: 0,
    })
    expect(r.status).toBe('running')
    expect(r.taskId).toBe('task-restore-1')
    expect(r.warnings.some((w) => w.includes('未等待完成'))).toBe(true)
    expect(mockRefs.fetchDoc.mock.calls).toHaveLength(0)
    expect(mockRefs.updateRecords.mock.calls).toHaveLength(0)
    expect(mockRefs.revertDocToVersion.mock.calls[0]?.[2]).toBe(0)
  })
})

describe('参数校验', () => {
  it('revisionId / historyVersionId 都不传 → 抛错', async () => {
    await expect(
      restoreChapterVersion(BASE, 4, {}),
    ).rejects.toThrow(/必须提供 revisionId 或 historyVersionId/)
  })
})
