/**
 * novel_upsert_book_summary 的 query/upsert 行为测试（纯 mock）
 * ============================================================
 *
 * 起因（实机 2026-09-03）：模型想读已有卷摘要，按 novel_manage_* 惯例调用
 *   {"workToken":…, "action":"query", "level":"卷"}
 * 而本工具当时是纯写入工具、且 title/content 为 schema 级 required →
 *   Error: invalid arguments: missing required property "title";
 *          missing required property "content"
 *
 * 本文件守住修复后的行为：
 *   1. action=query 只带 level 就能读出卷摘要（不再要 title/content）
 *   2. action 缺省 = upsert（老调用不传 action 行为不变）
 *   3. upsert 缺 level/title/content 时给**动作级**明确错误，不是 schema 错误
 *   4. 同标题跨层级（卷 vs 全书）时更新**同层级**那条，不串写
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMORY_F, MEMORY_LEVEL, TABLE } from '@unwr/schema'

const store: Record<string, Record<string, Record<string, unknown>>> = {
  [TABLE.MEMORY]: {},
}

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
    configureLark: vi.fn(),
    base: {
      listRecords: vi.fn(async (_token: string, table: string, opts: { filter?: { conditions?: unknown[] } }) => {
        let items = Object.entries(store[table] ?? {})
          .map(([id, f]) => ({ __recordId: id, ...f }))
        for (const cond of opts.filter?.conditions ?? []) {
          const [field, op, value] = cond as [string, string, unknown]
          if (op !== '==') continue
          items = items.filter((row) => {
            const cell = row[field]
            const flat = Array.isArray(cell)
              ? cell.map((x) => (typeof x === 'object' && x !== null && 'id' in x ? (x as { id: unknown }).id : x))
              : [cell]
            return flat.includes(value as never)
          })
        }
        return { items }
      }),
      listAllRecords: vi.fn(async (_token: string, table: string) => ({
        items: Object.entries(store[table] ?? {}).map(([id, f]) => ({ __recordId: id, ...f })),
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
          const id = `rec_mem_${i}_${Object.keys(store[table] ?? {}).length}`
          store[table] = { ...(store[table] ?? {}), [id]: { ...row } }
          ids.push(id)
        })
        return ids
      }),
      listFields: vi.fn(async () => ({ fields: [] })),
      getField: vi.fn(async () => ({ field: { name: 'x', options: [] } })),
      updateField: vi.fn(async () => ({})),
      // selfheal 的 verifyLinkBackfill 每次 update 都会先 listTables；
      // 缺这个 stub 会让它抛错 → 判定"回填未落库" → 3s/6s/9s 退避重试三轮。
      listTables: vi.fn(async () => ({
        tables: Object.keys(store).map((name) => ({ name, id: name })),
      })),
      getRecords: vi.fn(async (_token: string, table: string, ids: readonly string[]) => ({
        items: ids
          .filter((id) => store[table]?.[id] !== undefined)
          .map((id) => ({ __recordId: id, ...store[table]![id] })),
      })),
    },
    docs: {},
    drive: {},
    wiki: {},
  }
})

const { apply } = await import('../src/index.ts')

interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({ tools: { register: (t: MinimalTool) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } } as never, {})
  return tools
}

const TOOL = 'novel_upsert_book_summary'

function seed(title: string, level: string, extra: Record<string, unknown> = {}): string {
  const id = `rec_${Object.keys(store[TABLE.MEMORY]!).length}`
  store[TABLE.MEMORY]![id] = {
    [MEMORY_F.TITLE]: title,
    [MEMORY_F.LEVEL]: level,
    [MEMORY_F.CONTENT]: `${level}摘要内容`,
    ...extra,
  }
  return id
}

beforeEach(() => {
  store[TABLE.MEMORY] = {}
})

describe('novel_upsert_book_summary — action=query', () => {
  it('只带 level 就能查卷摘要（2026-09-03 报错的现场参数）', async () => {
    seed('示例卷', MEMORY_LEVEL.VOLUME, { [MEMORY_F.FROM_CHAPTER]: 1, [MEMORY_F.TO_CHAPTER]: 14 })
    seed('全书梗概', MEMORY_LEVEL.BOOK)

    const tool = collectTools().get(TOOL)!
    const r = await tool.execute(
      { workToken: 'tokFixture', action: 'query', level: '卷' },
      { signal: AbortSignal.timeout(10_000) },
    ) as { action: string; total: number; items: { level: string; title: string; content: string; fromChapter?: number }[] }

    expect(r.action).toBe('query')
    expect(r.total).toBe(1)
    expect(r.items[0]?.title).toBe('示例卷')
    expect(r.items[0]?.level).toBe('卷')
    expect(r.items[0]?.fromChapter).toBe(1)
  })

  it('不传 level 返回卷+全书，且不带出章节级条目', async () => {
    seed('示例卷', MEMORY_LEVEL.VOLUME)
    seed('全书梗概', MEMORY_LEVEL.BOOK)
    seed('第 3 章摘要', MEMORY_LEVEL.CHAPTER)

    const tool = collectTools().get(TOOL)!
    const r = await tool.execute({ action: 'query' }, { signal: AbortSignal.timeout(10_000) }) as {
      total: number; items: { title: string }[]
    }

    expect(r.total).toBe(2)
    expect(r.items.map((s) => s.title).sort()).toEqual(['全书梗概', '示例卷'].sort())
  })

  it('title 作为子串过滤标题与正文', async () => {
    seed('示例卷·子串', MEMORY_LEVEL.VOLUME)
    seed('示例卷·另一子串', MEMORY_LEVEL.VOLUME)

    const tool = collectTools().get(TOOL)!
    const r = await tool.execute({ action: 'query', title: '另一子串' }, { signal: AbortSignal.timeout(10_000) }) as {
      total: number; items: { title: string }[]
    }

    expect(r.total).toBe(1)
    expect(r.items[0]?.title).toBe('示例卷·另一子串')
  })
})

describe('novel_upsert_book_summary — action=upsert', () => {
  it('缺 action → 报出字段名明确的 ToolArgsError（不是让用户猜的 upsert 报错）', async () => {
    // 注：defineTool 在 execute 外层就做 schema 校验（tools/lib/index.js 的
    // validate(args) → ToolArgsError），所以 required 配置错会在这里炸，
    // 单测也能测到——这正是本文件能守住 2026-09-03 那个故障的原因。
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute(
        { level: '全书', title: '全书梗概', content: 'x' },
        { signal: AbortSignal.timeout(10_000) },
      ),
    ).rejects.toThrow(/action/)
  })

  it('同标题 + 同层级 → 更新而非新建', async () => {
    const id = seed('示例卷', MEMORY_LEVEL.VOLUME)
    const tool = collectTools().get(TOOL)!

    const r = await tool.execute(
      { action: 'upsert', level: '卷', title: '示例卷', content: '更新后的内容' },
      { signal: AbortSignal.timeout(10_000) },
    ) as { recordId: string; updated: boolean }

    expect(r.recordId).toBe(id)
    expect(r.updated).toBe(true)
    expect(Object.keys(store[TABLE.MEMORY]!)).toEqual([id])
    expect(store[TABLE.MEMORY]![id]![MEMORY_F.CONTENT]).toBe('更新后的内容')
  })

  it('同标题跨层级 → 更新同层级那条，不串写', async () => {
    const volId = seed('同名摘要', MEMORY_LEVEL.VOLUME)
    const bookId = seed('同名摘要', MEMORY_LEVEL.BOOK)
    expect(volId).not.toBe(bookId)

    const tool = collectTools().get(TOOL)!
    const r = await tool.execute(
      { action: 'upsert', level: '全书', title: '同名摘要', content: '只改全书这条' },
      { signal: AbortSignal.timeout(10_000) },
    ) as { recordId: string; updated: boolean }

    expect(r.recordId).toBe(bookId)
    expect(store[TABLE.MEMORY]![bookId]![MEMORY_F.CONTENT]).toBe('只改全书这条')
    expect(store[TABLE.MEMORY]![volId]![MEMORY_F.CONTENT]).toBe('卷摘要内容')
  })

  it.each([
    ['level', { title: 'x', content: 'y' }, 'level'],
    ['title', { level: '卷', content: 'y' }, 'title'],
    ['content', { level: '卷', title: 'x' }, 'content'],
  ])('upsert 缺 %s → 动作级明确报错（而非 schema 错误）', async (_label, args, keyword) => {
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute({ action: 'upsert', ...args }, { signal: AbortSignal.timeout(10_000) }),
    ).rejects.toThrow(new RegExp(keyword))
  })
})
