/**
 * 作品库一致性审计脚本。
 *
 * 用法：npx tsx scripts/audit-work.ts <baseToken>
 *
 * 背景（实机事故 2026-09-03）：历史遗留的**重名字段**让 link 写入看似失败
 * （读取按名合并时后列覆盖前列，校验读到空列误报"回填未生效"）。
 * 用户追问「是不是所有表都有类似问题」——重名只是其一，同类隐患还有：
 *
 *   1. 重名字段（同一逻辑字段两列，写读不一致）
 *   2. __legacy__ 遗留列（修复中断的残留，说明还有半成品）
 *   3. schema 缺字段（旧库没跟上 schema 演进，写入会报字段不存在）
 *   4. link 字段指向错误的目标表（数据写进去，关联全错）
 *   5. 悬空链接（link 单元格指向已不存在的记录——删除记录/清表后残留）
 *   6. schema 外的多余字段 / 多余表（报告，不自动处理）
 *
 * 只读不写：本脚本绝不修改任何数据，修复走 ensureWorkSchema /
 * repair-dup-fields.ts，悬空链接需要人工判断该补该删。
 *
 * @module
 */

import { base } from '../packages/feishu/src/index.ts'
import { LINK_FIELDS, TABLE_SCHEMAS } from '../packages/schema/src/index.ts'

const baseToken = process.argv[2]
if (baseToken === undefined || baseToken === '') {
  console.error('用法: npx tsx scripts/audit-work.ts <baseToken>')
  process.exit(1)
}

interface Issue {
  severity: 'error' | 'warn' | 'info'
  table: string
  message: string
}

const issues: Issue[] = []
const report = (severity: Issue['severity'], table: string, message: string): void => {
  issues.push({ severity, table, message })
  const tag = severity === 'error' ? '✗' : severity === 'warn' ? '⚠' : '·'
  console.error(`  ${tag} [${table}] ${message}`)
}

const { tables } = await base.listTables(baseToken)
const tableIdByName = new Map<string, string>(tables.map((t) => [t.name, t.id] as const))
console.log(`库内共 ${tables.length} 张表（schema 期望 ${Object.keys(TABLE_SCHEMAS).length} 张）\n`)

// ---------- 1. 表级：缺失 / 多余 ----------
for (const name of Object.keys(TABLE_SCHEMAS)) {
  if (!tableIdByName.has(name)) report('error', name, '表缺失')
}
for (const t of tables) {
  if (!TABLE_SCHEMAS[t.name]) report('info', t.name, 'schema 外的表（如平台默认表，确认无用可手动删）')
}

// ---------- 2/3. 字段级：重名 / 遗留 / 缺失 / 多余 ----------
// 同时收集 link 字段的 (字段 → 期望目标表 / 实际字段 id)，供第 4/5 步用
const linkChecks: {
  table: string
  tableId: string
  fieldName: string
  fieldId: string
  expectTarget: string
}[] = []
const fieldIdsByName = new Map<string, Map<string, string>>() // table -> name -> id
const actualNames = new Map<string, Set<string>>()

for (const [tname, tfields] of Object.entries(TABLE_SCHEMAS)) {
  const tid = tableIdByName.get(tname)
  if (tid === undefined) continue
  const fields = (await base.listFields(baseToken, tid)).fields

  // 重名
  const byName = new Map<string, number>()
  for (const f of fields) byName.set(f.name, (byName.get(f.name) ?? 0) + 1)
  for (const [n, c] of byName) {
    if (c > 1) report('error', tname, `重名字段「${n}」×${c}（写入/读取按名都会串列）`)
  }
  // 遗留列
  for (const f of fields) {
    if (f.name.startsWith('__legacy__')) {
      report('warn', tname, `遗留列 ${f.name}（上轮修复中断，重跑 repair-dup-fields.ts 可收敛）`)
    }
  }
  // 缺失 / link 指向核对
  // 注意：TABLE_SCHEMAS 只含非 link 字段，link 字段定义在 LINK_FIELDS，
  // 完整字段集 = 两者合并（否则 link 字段会被误报成 schema 外字段）
  const links = LINK_FIELDS[tname] ?? []
  const schemaNames = new Set([...tfields.map((f) => f.name), ...links.map((l) => l.field.name)])
  const linkNames = new Set(links.map((l) => l.field.name))
  for (const f of tfields) {
    if (!byName.has(f.name)) {
      report('error', tname, `schema 字段「${f.name}」缺失（写入会报字段不存在；ensureWorkSchema 可自动补）`)
    }
  }
  for (const f of fields) {
    if (!schemaNames.has(f.name) && !f.name.startsWith('__legacy__')) {
      report('info', tname, `schema 外字段「${f.name}」（确认无用可删）`)
    }
    if (linkNames.has(f.name)) {
      const expect = links.find((l) => l.field.name === f.name)!.targetTable
      linkChecks.push({ table: tname, tableId: tid, fieldName: f.name, fieldId: f.id, expectTarget: expect })
    }
  }
  fieldIdsByName.set(tname, new Map(fields.map((f) => [f.name, f.id] as const)))
  actualNames.set(tname, new Set(fields.map((f) => f.name)))
}

// ---------- 4. link 指向核对 ----------
for (const c of linkChecks) {
  const detail = (await base.getField(baseToken, c.tableId, c.fieldId)).field
  const actual = detail.link_table
  if (actual === undefined) {
    report('error', c.table, `link 字段「${c.fieldName}」读不到目标表（可能损坏）`)
    continue
  }
  const actualName = tables.find((t) => t.id === actual)?.name ?? actual
  if (actualName !== c.expectTarget) {
    report('error', c.table, `link 字段「${c.fieldName}」指向 ${actualName}，schema 期望 ${c.expectTarget}`)
  }
}

// ---------- 5. 悬空链接 ----------
// 先取所有目标表的记录 id 集合，再扫每个 link 字段的单元格
const targetRecordIds = new Map<string, Set<string>>()
const ensureRecIds = async (tname: string): Promise<Set<string>> => {
  let s = targetRecordIds.get(tname)
  if (s !== undefined) return s
  const tid = tableIdByName.get(tname)
  s = new Set()
  if (tid !== undefined) {
    const res = await base.listAllRecords(baseToken, tid, { limit: 500 })
    for (const rid of res.record_id_list ?? []) s.add(rid)
  }
  targetRecordIds.set(tname, s)
  return s
}

for (const c of linkChecks) {
  const valid = await ensureRecIds(c.expectTarget)
  const res = await base.listAllRecords(baseToken, c.tableId, { fieldIds: [c.fieldId], limit: 500 })
  const colIndex = res.field_id_list.indexOf(c.fieldId)
  if (colIndex < 0) continue
  const dangling = new Set<string>()
  let filled = 0
  res.data.forEach((row) => {
    const cell = row[colIndex]
    if (!Array.isArray(cell) || cell.length === 0) return
    filled++
    for (const item of cell) {
      const id = typeof item === 'object' && item !== null && 'id' in item
        ? String((item as { id: unknown }).id)
        : String(item)
      if (!valid.has(id)) dangling.add(id)
    }
  })
  if (dangling.size > 0) {
    report('error', c.table,
      `「${c.fieldName}」悬空链接 ${dangling.size} 个（有值记录 ${filled} 条）：`
        + `${[...dangling].slice(0, 5).join(', ')}${dangling.size > 5 ? '…' : ''}——指向已删除/不存在的记录`)
  } else if (filled > 0) {
    console.error(`  ✓ [${c.table}] 「${c.fieldName}」${filled} 条有值记录全部指向有效记录`)
  } else {
    report('info', c.table, `「${c.fieldName}」暂无数据（无法验证指向）`)
  }
}

// ---------- 汇总 ----------
const errors = issues.filter((i) => i.severity === 'error')
const warns = issues.filter((i) => i.severity === 'warn')
console.error(`\n===== 审计结论：${errors.length} 错误 / ${warns.length} 警告 / ${issues.length - errors.length - warns.length} 提示 =====`)
if (errors.length === 0 && warns.length === 0) {
  console.error('库结构健康：无重名、无遗留列、无缺字段、link 指向正确、无悬空链接。')
  process.exit(0)
}
process.exit(1)
