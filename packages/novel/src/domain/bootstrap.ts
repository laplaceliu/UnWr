/**
 * 建库引导。
 *
 * 与 `packages/schema/scripts/init-work.ts` 共用同一份表结构定义
 * （`packages/schema/src/work-schema.ts`），保证 CLI 建库与工具建库
 * 产出的结构完全一致。
 *
 * 实测的时序坑（全部踩过）：
 *   1. base-create 返回后立刻 listTables → 91402 NOTEXIST（Base 级可见性延迟）
 *   2. 13 张表一口气建完后立即建 link 字段 → 目标表未就绪，全部失败
 *      （重试单个字段多久都没用，必须给平台收敛时间后整轮重试）
 *
 * 因此流程为：等 Base 就绪 → 并行建表 → settle → link 字段按轮重试。
 *
 * @module @unwr/novel/domain/bootstrap
 */

import { base } from '@unwr/feishu'
import { LINK_FIELDS, TABLE_SCHEMAS } from '@unwr/schema'

/** 建齐缺失的表与字段。已存在的跳过。 */
export async function initWork(
  baseToken: string,
  signal?: AbortSignal,
): Promise<{
  createdTables: string[]
  createdFields: number
  /** 创建失败的关联字段（sourceTable.field）——调用方必须让用户知道 */
  failedLinks: string[]
}> {
  // 1. 等待新建 Base 可被查询（Base 级可见性延迟）
  const tables = await waitForBase(baseToken, signal)
  const tableIdByName = new Map(tables.map((t) => [t.name, t.id]))
  const createdTables: string[] = []
  let createdFields = 0

  // 2. 建 13 张表。
  // **必须串行**：并行建表实测触发 800004135 "OpenAPIAddTable limited"。
  // 每张 ~600ms，串行约 8s，可接受。
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    const info = await base.createTable(baseToken, name, fields, signal)
    tableIdByName.set(name, info.id)
    createdTables.push(name)
    createdFields += fields.length
  }

  // 3. 等表结构收敛（实测必要：建完立即建 link 会全部失败）
  await new Promise((r) => setTimeout(r, 2000))

  // 4. link 字段：按**轮**重试，而不是单个字段长时间退避。
  //    目标表未就绪是全局性的——某一轮内所有字段要么都好要么都坏，
  //    整轮重试比 25 个字段各退避 7s 快一个数量级。
  const failedLinks: string[] = []
  const MAX_ROUNDS = 4
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pending: {
      sourceTable: string; field: Parameters<typeof base.createFields>[2][number]
      sourceId: string; targetId: string
    }[] = []

    for (const [sourceTable, links] of Object.entries(LINK_FIELDS)) {
      const sourceId = tableIdByName.get(sourceTable)
      if (sourceId === undefined) continue
      const existing = new Set(await listFieldNames(baseToken, sourceId, signal))
      for (const { field, targetTable } of links) {
        if (existing.has(field.name)) continue
        const targetId = tableIdByName.get(targetTable)
        if (targetId === undefined) continue
        pending.push({ sourceTable, field: { ...field, link_table: targetId }, sourceId, targetId })
      }
    }

    if (pending.length === 0) break

    const stillFailed: typeof pending = []
    await pMap(pending, async (item) => {
      try {
        await base.createFields(baseToken, item.sourceId, [item.field], signal)
        createdFields++
      } catch {
        stillFailed.push(item)
      }
    }, 6)

    if (stillFailed.length === 0) break

    if (round === MAX_ROUNDS) {
      // **绝不静默**：link 字段缺失会让后续写入报 800030201 not_found，
      // 且症状隐晦。必须显式暴露给调用方。
      for (const f of stillFailed) {
        failedLinks.push(`${f.sourceTable}.${f.field.name}`)
        console.error(`[unwr] 关联字段创建失败: ${f.sourceTable}.${f.field.name}`)
      }
      break
    }

    // 轮间等待，给平台收敛时间
    await new Promise((r) => setTimeout(r, 3000))
  }

  return { createdTables, createdFields, failedLinks }
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
    `新建的作品库 ${baseToken} 在 ${Date.now() - started}ms 内不可查询（可见性延迟超时），请稍后重试。`,
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
