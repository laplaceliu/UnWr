/**
 * 建库引导。
 *
 * 与 `packages/schema/scripts/init-work.ts` 共用同一份表结构定义
 * （`packages/schema/src/work-schema.ts`），保证 CLI 建库与工具建库
 * 产出的结构完全一致。
 *
 * @module @unwr/novel/domain/bootstrap
 */

import { base } from '@unwr/feishu'
import { LINK_FIELDS, TABLE_SCHEMAS } from '@unwr/schema'
import type { FieldSchema } from '@unwr/schema'

/** 建齐缺失的表与字段。已存在的跳过。 */
export async function initWork(
  baseToken: string,
  signal?: AbortSignal,
): Promise<{ createdTables: string[]; createdFields: number }> {
  const tables = (await base.listTables(baseToken, signal)).tables
  const tableIdByName = new Map(tables.map((t) => [t.name, t.id]))
  const createdTables: string[] = []
  let createdFields = 0

  // 阶段 1：建表 + 普通字段
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    const info = await base.createTable(baseToken, name, fields, signal)
    tableIdByName.set(name, info.id)
    createdTables.push(name)
    createdFields += fields.length
  }

  // 阶段 2：建关联字段（需 table_id，所以必须在建表之后）
  for (const [sourceTable, links] of Object.entries(LINK_FIELDS)) {
    const sourceId = tableIdByName.get(sourceTable)
    if (sourceId === undefined) continue

    const existing = new Set(await listFieldNames(baseToken, sourceId, signal))
    for (const { field, targetTable } of links) {
      if (existing.has(field.name)) continue
      const targetId = tableIdByName.get(targetTable)
      if (targetId === undefined) continue
      try {
        // link 字段创建偶发瞬时失败，重试 3 次
        await withRetry(() =>
          base.createFields(
            baseToken, sourceId,
            [{ ...field, link_table: targetId }],
            signal,
          ))
        createdFields++
      } catch {
        // 关联字段失败不阻断整体建库
      }
    }
  }

  return { createdTables, createdFields }
}

/** 带退避的重试。 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
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
