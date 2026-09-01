/**
 * 把已存在的作品库的字段结构同步到代码 schema。
 *
 * 为什么需要：需求阶段手工建的表与 init-work.ts 的 schema 可能有出入
 * （例如字段名不同、缺字段），导致写入时报 800030201 not_found。
 * 本脚本以 `packages/schema/src/tables.ts` + init-work.ts 的 schema 为准，
 * 补齐缺失字段；已存在同名字段则跳过（**不改名、不删字段**，改名需人工确认）。
 *
 * 用法：tsx sync-fields.ts <base_token> [--dry-run]
 * @module
 */

import { base } from '../../feishu/src/index.ts'
import type { FieldSchema } from '../../feishu/src/types.ts'
import { TABLE_SCHEMAS } from './init-work.ts'

const baseToken = process.argv[2]
const dryRun = process.argv.includes('--dry-run')

if (baseToken === undefined) {
  console.error('用法: tsx sync-fields.ts <base_token> [--dry-run]')
  process.exit(1)
}

interface FieldInfo {
  id: string
  name: string
  type: string
}

const tables = (await base.listTables(baseToken)).tables
const byName = new Map(tables.map((t) => [t.name, t.id]))

let totalAdded = 0
let totalSkipped = 0

for (const [tableName, fields] of Object.entries(TABLE_SCHEMAS)) {
  const tableId = byName.get(tableName)
  if (tableId === undefined) {
    console.log(`- ${tableName}: 表不存在，跳过（用 init-work.ts 创建）`)
    continue
  }

  const raw = await base.listFields ? base.listFields(baseToken, tableId) : null
  // 适配层若未提供 listFields，退回直接调用
  const existing: FieldInfo[] = raw?.fields ?? await listFieldsFallback(baseToken, tableId)
  const existingNames = new Set(existing.map((f) => f.name))

  const missing: FieldSchema[] = fields.filter((f) => !existingNames.has(f.name))
  if (missing.length === 0) {
    console.log(`- ${tableName}: 字段已完整 (${existing.length})`)
    totalSkipped += existing.length
    continue
  }

  console.log(`- ${tableName}: 缺 ${missing.length} 个字段 → ${missing.map((f) => f.name).join(', ')}`)
  if (dryRun) {
    totalAdded += missing.length
    continue
  }

  await base.createFields(baseToken, tableId, missing)
  totalAdded += missing.length
}

console.log(`\n完成：新增 ${totalAdded} 个字段，已存在 ${totalSkipped} 个`)
if (dryRun) console.log('（dry-run，未实际修改）')

/** 适配层未提供 listFields 时的兜底。 */
async function listFieldsFallback(bt: string, tid: string): Promise<FieldInfo[]> {
  const { runCli } = await import('../../feishu/src/cli.ts')
  const res = await runCli<{ fields: FieldInfo[] }>(
    ['base', '+field-list', '--base-token', bt, '--table-id', tid],
  )
  return res.fields ?? []
}
