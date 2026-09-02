/**
 * 建库引导与旧库 schema 修复。
 *
 * 与 `packages/schema/scripts/init-work.ts` 共用同一份表结构定义
 * （`packages/schema/src/work-schema.ts`），保证 CLI 建库与工具建库
 * 产出的结构完全一致。
 *
 * 实测的时序坑（全部踩过）：
 *   1. base-create 返回后立刻 listTables → 91402 NOTEXIST（Base 级可见性延迟）
 *   2. 13 张表一口气建完后立即建 link 字段 → 目标表未就绪，全部失败
 *      （重试单个字段多久都没用，必须给平台收敛时间后整轮重试）
 *   3. **旧库漂移**：早期版本插件建的库可能缺 link 字段甚至缺普通字段
 *      （如「文档目录」）。2026-09-01 实测：旧库写人物状态表/事件表
 *      全部报 not_found，根因就是旧 init 没建 link 字段。
 *      因此 `ensureWorkSchema` 做成幂等修复：可对**任意已存在的库**反复执行。
 *
 * 因此流程为：等 Base 就绪 → 串行建缺表 → 并行补缺字段 → settle → link 字段按轮重试。
 *
 * @module @unwr/novel/domain/bootstrap
 */

import { base } from '@unwr/feishu'
import { LINK_FIELDS, TABLE_SCHEMAS } from '@unwr/schema'

/** ensureWorkSchema 的结果。 */
export interface EnsureSchemaResult {
  createdTables: string[]
  createdFields: number
  /** 创建失败的关联字段（sourceTable.field）——调用方必须让用户知道 */
  failedLinks: string[]
}

/**
 * 建齐缺失的表、普通字段与 link 字段。已存在的跳过。
 *
 * 幂等，对「新建库」与「旧版本建的库」都适用；修复旧库时
 * 跳过建表收敛等待，全程约 1-2s（13 次 listFields 并行）。
 */
export async function ensureWorkSchema(
  baseToken: string,
  signal?: AbortSignal,
): Promise<EnsureSchemaResult> {
  const { tables } = await base.listTables(baseToken, signal)
  const tableIdByName = new Map<string, string>(tables.map((t) => [t.name, t.id] as const))
  const createdTables: string[] = []
  let createdFields = 0

  // 1. 缺失的表。
  // **必须串行**：并行建表实测触发 800004135 "OpenAPIAddTable limited"。
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    const info = await base.createTable(baseToken, name, fields, signal)
    tableIdByName.set(name, info.id)
    createdTables.push(name)
    createdFields += fields.length
  }

  // 2. 字段名快照：每张表取一次（并行），供普通字段与 link 字段两阶段共用。
  //    新建的表字段必然完整，跳过探测。
  const existingByTable = new Map<string, Set<string>>()
  await pMap(Object.entries(TABLE_SCHEMAS), async ([name, fields]) => {
    const id = tableIdByName.get(name)
    if (id === undefined) return
    if (createdTables.includes(name)) {
      existingByTable.set(name, new Set(fields.map((f) => f.name)))
      return
    }
    existingByTable.set(name, new Set(await listFieldNames(baseToken, id, signal)))
  }, 6)

  // 3. 已有表补齐缺失的普通字段（旧库升级场景）。
  //    只按名补缺——**不改名、不删字段**，与 sync-fields 脚本同一原则。
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (createdTables.includes(name)) continue
    const existing = existingByTable.get(name)
    const sourceId = tableIdByName.get(name)
    if (existing === undefined || sourceId === undefined) continue
    const missing = fields.filter((f) => !existing.has(f.name))
    if (missing.length === 0) continue
    await base.createFields(baseToken, sourceId, missing, signal)
    createdFields += missing.length
  }

  // 4. 新建表后给平台收敛窗口（实测必要：建完立即建 link 会全部失败）。
  //    修复旧库（无新建表）时跳过，不白等。
  if (createdTables.length > 0) await new Promise((r) => setTimeout(r, 2000))

  // 5. link 字段：按**轮**重试，而不是单个字段长时间退避。
  //    目标表未就绪是全局性的——某一轮内所有字段要么都好要么都坏。
  //    待建清单只算一次（快照语义），每轮重试上一轮失败者。
  const pending: {
    sourceTable: string
    field: Parameters<typeof base.createFields>[2][number]
    sourceId: string
  }[] = []
  for (const [sourceTable, links] of Object.entries(LINK_FIELDS)) {
    const sourceId = tableIdByName.get(sourceTable)
    if (sourceId === undefined) continue
    const existing = existingByTable.get(sourceTable) ?? new Set<string>()
    for (const { field, targetTable } of links) {
      if (existing.has(field.name)) continue
      const targetId = tableIdByName.get(targetTable)
      if (targetId === undefined) continue
      pending.push({ sourceTable, field: { ...field, link_table: targetId }, sourceId })
    }
  }

  const failedLinks: string[] = []
  const MAX_ROUNDS = 4
  let remaining = pending
  for (let round = 1; remaining.length > 0 && round <= MAX_ROUNDS; round++) {
    const stillFailed: typeof remaining = []
    await pMap(remaining, async (item) => {
      try {
        await base.createFields(baseToken, item.sourceId, [item.field], signal)
        createdFields++
      } catch {
        stillFailed.push(item)
      }
    }, 6)

    remaining = stillFailed
    // 轮间等待，给平台收敛时间（最后一轮不再等）
    if (remaining.length > 0 && round < MAX_ROUNDS) {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  // **绝不静默**：link 字段缺失会让后续写入报 800030201 not_found，
  // 且症状隐晦。必须显式暴露给调用方。
  for (const f of remaining) {
    failedLinks.push(`${f.sourceTable}.${f.field.name}`)
    console.error(`[unwr] 关联字段创建失败: ${f.sourceTable}.${f.field.name}`)
  }

  return { createdTables, createdFields, failedLinks }
}

/** 建库引导：等待新建 Base 可查后执行 schema 补齐。 */
export async function initWork(
  baseToken: string,
  signal?: AbortSignal,
): Promise<EnsureSchemaResult> {
  await waitForBase(baseToken, signal)
  return ensureWorkSchema(baseToken, signal)
}

/**
 * schema 校验结果缓存：每个库 10 分钟内不重复校验
 * （一次校验 ≈ 13 次 listFields，约 1-2s，没必要每次 get_config 都付）。
 */
const schemaCheckedAt = new Map<string, number>()
const SCHEMA_CHECK_TTL_MS = 10 * 60_000

/**
 * 挂在 get_config 入口的旧库自愈：缺表缺字段时自动补齐，结果按库缓存。
 *
 * 为什么挂在 get_config：它是编排官每个会话必调的第一个工具——在这里
 * 把「旧版本建的库缺 link 字段」这类漂移在写入发生前修掉，比让每个
 * 写入撞 not_found 再自愈（2.5s 退避 + initWork + 重试）快且可解释。
 *
 * 失败**不抛出**：返回 ok=false 交调用方决策（get_config 用它拦截
 * token 抄错；不阻断只读路径）。
 */
export async function ensureWorkSchemaCached(
  baseToken: string,
  signal?: AbortSignal,
): Promise<EnsureSchemaResult & { ok: boolean }> {
  const last = schemaCheckedAt.get(baseToken)
  if (last !== undefined && Date.now() - last < SCHEMA_CHECK_TTL_MS) {
    return { ok: true, createdTables: [], createdFields: 0, failedLinks: [] }
  }
  try {
    const r = await ensureWorkSchema(baseToken, signal)
    schemaCheckedAt.set(baseToken, Date.now())
    return { ok: true, ...r }
  } catch (e) {
    // 失败不缓存：下次调用重试。典型原因 = base_token 抄错（NOTEXIST）。
    console.error(
      `[unwr] schema 校验失败（不缓存，下次重试）: ${e instanceof Error ? e.message : String(e)}`,
    )
    return { ok: false, createdTables: [], createdFields: 0, failedLinks: [] }
  }
}

/** 简版并发映射（保序返回不要求，结果由副作用收集）。 */
async function pMap<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * 等待新建 Base 可被查询（实测有秒级可见性延迟）。
 *
 * @throws 超时仍不可见时抛出——Base 不可查意味着后续建表全部无意义
 */
async function waitForBase(
  baseToken: string,
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<{ id: string; name: string }[]> {
  const started = Date.now()
  const delays = [0, 500, 1000, 1500, 2000, 3000]

  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    if (Date.now() - started > timeoutMs) break
    try {
      const res = await base.listTables(baseToken, signal)
      return res.tables
    } catch {
      // NOTEXIST：还没就绪，继续等
    }
  }

  throw new Error(
    `作品库 ${baseToken} 在 ${Date.now() - started}ms 内不可查询。`
    + '新建库可能是可见性延迟（稍等重试即可）；否则 base_token 可能抄错了，'
    + '可用 novel_manage_work(action=list) 核对。',
  )
}

/** 列出一张表的所有字段名。 */
async function listFieldNames(
  baseToken: string,
  tableId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await base.listFields(baseToken, tableId, signal)
  return res.fields.map((f) => f.name)
}
