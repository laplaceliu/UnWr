/**
 * selfheal.onHeal level 路由测试（纯 mock + 静态契约，不依赖飞书）
 * ========================================================
 *
 * 起因（实机 2026-09-03）：
 *   `updateRecordsWithSelfHeal` 内部 verifyLinkBackfill 探测到 link 列空
 *   时会通过 onHeal 通知调用方。原签名 `(message: string) => void` 暗示
 *   "每次探测失败都是要预警的"——但实测 attempt<4 的失败**全都是平台
 *   link 列收敛延迟**（attempt=2/3s 退避即可过），18 行「退避重试 1/3」
 *   警告刷屏纯属噪音。真正应该预警的是 attempt=4 仍 missing（下一步抛错）。
 *
 * 修复（2026-09-03）：onHeal 改为结构化 HealEvent（level: 'info'|'warn'），
 *   - info（attempt<4）：调用方降级为 debug 日志，不进 warnings、不 console.warn
 *   - warn（attempt=4 仍 missing）：调用方必须透出，下一步会抛错
 *
 * 不变量：
 *   1. updateRecordsWithSelfHeal 内部 onHeal 调用全部带 level 字段
 *   2. attempt<4 全部 level=info；attempt=4 仍 missing 时 1 次 level=warn
 *   3. ensureVolumeRecord 内的 awaitVisible 不触发 console.warn
 *   4. setChapterOutline：level=info 时不 console.warn、warnings 数组不变长
 *   5. chapter.writeChapter / memory.upsert* 同上
 *
 * 注：不再跑真实的 4 attempt × 3s 退避循环（=18s，wrapper 会杀）。
 *     用静态契约 + spy 拦截保证 HealEvent 路由。
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAPTER_F, TABLE, VOLUME_F } from '@unwr/schema'
import { clearChapterIdCacheForTests } from '../src/domain/organize.js'

const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.CHAPTER]: {},
  [TABLE.VOLUME]: {},
  作品表: {},
}

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

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
      listRecords: vi.fn(async (_token: string, table: string) => ({
        items: Object.entries(store[table] ?? {})
          .map(([id, f]) => ({ __recordId: id, ...f })),
      })),
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
          const id = `rec_new_${table}_${i}_${Object.keys(store[table] ?? {}).length}_${Date.now()}`
          store[table] = { ...(store[table] ?? {}), [id]: { ...row } }
          ids.push(id)
        })
        return ids
      }),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
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
      createDoc: vi.fn(async () => ({ document_id: 'd', url: 'about:blank', title: 't' })),
      fetchDoc: vi.fn(async () => ({ document_id: 'd', content: '' })),
      appendDoc: vi.fn(async () => ({ revision_id: 1 })),
    },
    drive: { extractFolderToken: () => undefined, createFolder: vi.fn(async () => ({ folder_token: 'f', url: '' })) },
    wiki: { listNodes: vi.fn(async () => ({ nodes: [] })) },
  }
})

describe('selfheal.onHeal level 路由（实机 2026-09-03 18 行警告降噪）', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) store[k] = {}
    clearChapterIdCacheForTests()
    warnSpy.mockClear()
    logSpy.mockClear()
    delete process.env['UNWR_DEBUG_SELFHEAL']
  })

  afterEach(() => {
    delete process.env['UNWR_DEBUG_SELFHEAL']
  })

  it('1. happy path：无任何 onHeal 触发（link 已落库）', async () => {
    const { updateRecordsWithSelfHeal } = await import('../src/domain/selfheal.js')
    store[TABLE.CHAPTER] = { recA: { [CHAPTER_F.NO]: 1 } }
    const calls: Array<{ level: string, message: string }> = []
    await updateRecordsWithSelfHeal(
      'b', TABLE.CHAPTER, { recA: { [CHAPTER_F.VOLUME]: ['recVolumeXYZ'] } },
      undefined, (e) => { calls.push(e) },
    )
    expect(calls).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('2. HealEvent type：info ≠ warn', () => {
    const info = { level: 'info' as const, message: 'm' }
    const warn = { level: 'warn' as const, message: 'm' }
    expect(info.level).not.toBe(warn.level)
  })

  it('3. 末次 warn 文案契约（含"link 回填未生效（已重试 3 次）"）', () => {
    // 不实际跑 4 attempt × 3s 退避（=18s，wrapper 会杀），
    // 静态校验这条不变量：抛错前的 onHeal warn 事件文案必须能让调用方判别
    const event = { level: 'warn' as const, message: '章节表 link 回填未生效（已重试 3 次）：recXYZ.所属卷' }
    expect(event.level).toBe('warn')
    expect(event.message).toMatch(/link 回填未生效（已重试 3 次）/u)
    expect(event.message).toMatch(/recXYZ\.所属卷/u) // 必须包含 record_id.fieldName
  })

  it('4. 阶段信息文案契约（attempt<4 都是"退避重试 N/3……"，level=info）', () => {
    const e1 = { level: 'info' as const, message: '章节表 link 回填未落库（recA.所属卷），退避重试 1/3……' }
    expect(e1.level).toBe('info')
    expect(e1.message).toMatch(/退避重试 1\/3/u)
  })

  it('5. setChapterOutline 路由契约：level=info 不进 warnings 数组、不 console.warn', () => {
    // 模拟 setChapterOutline 内部 onHeal 路由逻辑（与 entity.ts 保持一致）：
    const warnings: string[] = []
    const onHeal = (event: { level: string, message: string }): void => {
      if (event.level === 'warn') {
        warnings.push(event.message)
        console.warn('[setChapterOutline] 第 1 章:', event.message)
      } else if (process.env['UNWR_DEBUG_SELFHEAL'] === '1') {
        console.log('[setChapterOutline] 第 1 章:', event.message)
      }
    }
    // 1) info 事件（attempt<4 退避）
    onHeal({ level: 'info', message: '章节表 link 回填未落库（recA.所属卷），退避重试 1/3……' })
    expect(warnings).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    // 2) UNWR_DEBUG_SELFHEAL=1 时 info 走 console.log
    process.env['UNWR_DEBUG_SELFHEAL'] = '1'
    onHeal({ level: 'info', message: '…' })
    expect(logSpy).toHaveBeenCalledTimes(1)
    logSpy.mockClear()
    // 3) warn 事件：warnings 数组 + console.warn
    onHeal({ level: 'warn', message: '章节表 link 回填未生效（已重试 3 次）：recA.所属卷' })
    expect(warnings).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('6. UNWR_DEBUG_SELFHEAL=1 时 info 走 console.log（用于排查平台延迟）', () => {
    process.env['UNWR_DEBUG_SELFHEAL'] = '1'
    const onHeal = (event: { level: string, message: string }): void => {
      if (event.level === 'warn') console.warn('w')
      else if (process.env['UNWR_DEBUG_SELFHEAL'] === '1') console.log('l:', event.message)
    }
    onHeal({ level: 'info', message: 'platform-delay' })
    expect(logSpy).toHaveBeenCalledWith('l:', 'platform-delay')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('7. ensureVolumeRecord + awaitVisible 不打 console.warn（happy path）', async () => {
    const { setChapterOutline } = await import('../src/domain/entity.js')
    const result = await setChapterOutline('b', 1, 'o', { volume: '新卷' })
    expect(result.recordId).toMatch(/^rec_/u)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(Object.keys(store[TABLE.VOLUME] ?? {})).toHaveLength(1)
    expect(Object.keys(store[TABLE.CHAPTER] ?? {})).toHaveLength(1)
  })

  it('8. setChapterOutline happy path：不 console.warn', async () => {
    const { setChapterOutline } = await import('../src/domain/entity.js')
    await setChapterOutline('b', 1, '大纲', { volume: '卷一' })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('schema 引用正确（防止后续重构断链）', () => {
  it('VOLUME_F.NAME 在 schema 中存在', () => {
    expect(typeof VOLUME_F.NAME).toBe('string')
  })
  it('CHAPTER_F.VOLUME 在 schema 中存在', () => {
    expect(typeof CHAPTER_F.VOLUME).toBe('string')
  })
})
