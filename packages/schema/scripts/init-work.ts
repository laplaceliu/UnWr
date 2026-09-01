/**
 * 为一部作品建齐全部表。
 *
 * 分两个阶段：
 *   1. 建表 + 普通字段（TABLE_SCHEMAS）
 *   2. 建关联字段（LINK_FIELDS）—— 因为 `link` 字段需要目标表的 **table_id**，
 *      而 table_id 只有在表创建后才拿得到，所以无法在阶段 1 内联创建。
 *
 * **表结构定义在 `packages/schema/src/work-schema.ts`，本文件只引用，不重复定义。**
 * 该定义同时被 `@unwr/novel` 的建库动作使用，是单一真源。
 *
 * 用法：
 *   tsx packages/schema/scripts/init-work.ts <base_token>
 *   tsx packages/schema/scripts/init-work.ts <base_token> --sync-fields
 * @module
 */

import { base } from '../../feishu/src/index.ts'
import { LINK_FIELDS, TABLE_SCHEMAS } from '../src/work-schema.ts'
import type { FieldSchema } from '../src/work-schema.ts'

export { LINK_FIELDS, TABLE_SCHEMAS }

/** 建齐缺失的表与字段。已存在的跳过。 */
export async function initWork(
  baseToken: string,
  options: { syncFields?: boolean } = {},
): Promise<{ createdTables: string[]; createdFields: number }> {
  const tables = (await base.listTables(baseToken)).tables
  const tableIdByName = new Map(tables.map((t) => [t.name, t.id]))
  const createdTables: string[] = []
  let createdFields = 0

  // 阶段 1：建表 + 普通字段
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    const info = await base.createTable(baseToken, name, fields)
    tableIdByName.set(name, info.id)
    createdTables.push(name)
    createdFields += fields.length
  }

  // 阶段 2：建关联字段（需 table_id）
  for (const [sourceTable, links] of Object.entries(LINK_FIELDS)) {
    const sourceId = tableIdByName.get(sourceTable)
    if (sourceId === undefined) continue

    const existing = new Set(await listFieldNames(baseToken, sourceId))
    for (const { field, targetTable } of links) {
      if (existing.has(field.name)) continue
      const targetId = tableIdByName.get(targetTable)
      if (targetId === undefined) continue
      try {
        await createLinkField(baseToken, sourceId, field, targetId)
        createdFields++
      } catch (e) {
        // 关联字段创建失败不应阻断整体流程，但必须显式报告
        console.error(`  ! ${sourceTable}.${field.name} 创建失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 阶段 3（可选）：为已存在的表补齐后续新增的普通字段
  if (options.syncFields === true) {
    for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
      const tableId = tableIdByName.get(name)
      if (tableId === undefined) continue
      const existing = new Set(await listFieldNames(baseToken, tableId))
      const missing = fields.filter((f) => !existing.has(f.name))
      if (missing.length === 0) continue
      await base.createFields(baseToken, tableId, missing)
      createdFields += missing.length
      console.log(`  + ${name}: 补 ${missing.length} 个字段 → ${missing.map((f) => f.name).join(', ')}`)
    }
  }

  return { createdTables, createdFields }
}

/**
 * 创建关联字段，带重试。
 *
 * 实测：link 字段创建偶发瞬时失败（API 限流或表刚建好尚未就绪），
 * 直接重跑一次往往就成功。这里做有限重试，避免每次都要手动补跑。
 */
async function createLinkField(
  baseToken: string,
  sourceId: string,
  field: FieldSchema,
  targetId: string,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await base.createFields(baseToken, sourceId, [{ ...field, link_table: targetId }])
      return
    } catch (e) {
      lastError = e
      if (attempt < maxAttempts) {
        // 退避：1s, 2s
        await new Promise((r) => setTimeout(r, attempt * 1000))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 列出一张表的所有字段名。 */
async function listFieldNames(baseToken: string, tableId: string): Promise<string[]> {
  const { runCli } = await import('../../feishu/src/cli.ts')
  const res = await runCli<{ fields: { name: string }[] }>(
    ['base', '+field-list', '--base-token', baseToken, '--table-id', tableId],
  )
  return (res.fields ?? []).map((f) => f.name)
}

/** CLI 入口。 */
async function main(): Promise<void> {
  const token = process.argv[2]
  if (token === undefined) {
    console.error('用法: tsx init-work.ts <base_token> [--sync-fields]')
    process.exit(1)
  }
  const r = await initWork(token, { syncFields: process.argv.includes('--sync-fields') })
  console.log('新建表:', r.createdTables.join(', ') || '(无)')
  console.log('新建字段数:', r.createdFields)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
