/**
 * 多维表格 API。
 *
 * 封装需求阶段已实机验证的能力：建表、字段、记录、双向关联、公式、视图、条件查询。
 * 全部参数陷阱（`--json` 不支持 stdin、长 JSON 禁内联、`@file` 仅相对路径）
 * 由本模块屏蔽，上层传普通 JS 对象即可。
 *
 * @module @unwr/feishu/apis/base
 */

import type { FieldSchema, FilterJson, RecordFields, SortJson } from '../types.ts'
import { runCli } from '../cli.ts'
import { withTempDir } from '../file-bridge.ts'

export interface TableInfo {
  id: string
  name: string
  records_count?: number
}

export interface RecordHandle {
  record_id: string
}

/** 建表。复杂 schema 必须走文件传参（内联长 JSON 会失败）。 */
export async function createTable(
  baseToken: string,
  name: string,
  fields: readonly FieldSchema[],
  signal?: AbortSignal,
): Promise<TableInfo> {
  return withTempDir(async (dir) => {
    const f = await dir.write('fields.json', JSON.stringify(fields))
    return runCli<TableInfo>(
      ['base', '+table-create',
        '--base-token', baseToken,
        '--name', name,
        '--fields', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
  })
}

/** 列出 Base 内所有表。 */
export function listTables(baseToken: string, signal?: AbortSignal): Promise<{ tables: TableInfo[] }> {
  return runCli(['base', '+table-list', '--base-token', baseToken], { signal })
}

/** 字段信息。 */
export interface FieldInfo {
  id: string
  name: string
  type: string
}

/**
 * 列出一张表的所有字段。
 *
 * 注意：`field-list` 返回的字段在 `data.fields`（不是 `data.items`）。
 */
export function listFields(
  baseToken: string,
  tableId: string,
  signal?: AbortSignal,
): Promise<{ fields: FieldInfo[] }> {
  return runCli<{ fields: FieldInfo[] }>(
    ['base', '+field-list', '--base-token', baseToken, '--table-id', tableId],
    { signal },
  )
}

/** 批量创建字段。数组按顺序创建，遇到首个失败即停止且不回滚。 */
export async function createFields(
  baseToken: string,
  tableId: string,
  fields: readonly FieldSchema[],
  signal?: AbortSignal,
): Promise<void> {
  await withTempDir(async (dir) => {
    const f = await dir.write('fields.json', JSON.stringify(fields))
    await runCli(
      ['base', '+field-create',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
  })
}

/**
 * 创建公式字段。
 * 必须带 `--i-have-read-guide`（官方强制要求）。
 * 注意：官方明确 Formula 是 Lookup 的严格超集，跨表引用一律用 Formula。
 */
export async function createFormulaField(
  baseToken: string,
  tableId: string,
  name: string,
  expression: string,
  signal?: AbortSignal,
): Promise<void> {
  await withTempDir(async (dir) => {
    const payload = JSON.stringify([{ name, type: 'formula', expression }])
    const f = await dir.write('formula.json', payload)
    await runCli(
      ['base', '+field-create',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', `@${f.relative}`,
        '--i-have-read-guide'],
      { cwd: dir.cwd, signal },
    )
  })
}

/** 批量创建记录。单批上限 200 条。 */
export async function createRecords(
  baseToken: string,
  tableId: string,
  records: readonly RecordFields[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (records.length > 200) {
    throw new Error(`batch create supports max 200 records, got ${records.length}`)
  }
  return withTempDir(async (dir) => {
    const f = await dir.write('records.json', JSON.stringify({ create_records: records }))
    const res = await runCli<{ record_id_list: string[] }>(
      ['base', '+record-batch-create',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return res.record_id_list
  })
}

/**
 * 批量更新记录。
 * 注意：这里的 `update_records` 是 **map**（recordId → fields），
 * 与 create 的 **array** 不对称——这是最常见的踩坑点，本函数已屏蔽。
 */
export async function updateRecords(
  baseToken: string,
  tableId: string,
  updates: Readonly<Record<string, RecordFields>>,
  signal?: AbortSignal,
): Promise<string[]> {
  return withTempDir(async (dir) => {
    const f = await dir.write('updates.json', JSON.stringify({ update_records: updates }))
    const res = await runCli<{ record_id_list: string[] }>(
      ['base', '+record-batch-update',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return res.record_id_list
  })
}

/**
 * 查询记录的结果。
 *
 * 矩阵形式（省带宽但难用）：`data` 是行的数组，每行列序与 `fields` 一致。
 * `record_id_list` 与 `data` **一一对应**——这是更新记录的关键，务必保留。
 */
export interface RecordMatrix {
  data: unknown[][]
  fields: string[]
  field_id_list: string[]
  field_type_list: string[]
  /** 与 data 逐行对应的记录 ID；更新/删除时需要 */
  record_id_list?: string[]
  has_more?: boolean
}

export interface ListRecordsOptions {
  /** 投影字段，省略则返回全部 */
  fieldIds?: readonly string[]
  /** 视图 ID 或名称 */
  viewId?: string
  /** 覆盖视图筛选 */
  filter?: FilterJson
  /** 排序，最多 10 个键 */
  sort?: readonly SortJson[]
  limit?: number
  /** ndjson 上限 2000，其余上限 200 */
  offset?: number
}

export function listRecords(
  baseToken: string,
  tableId: string,
  options: ListRecordsOptions = {},
  signal?: AbortSignal,
): Promise<RecordMatrix> {
  const args = ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--format', 'json']
  for (const f of options.fieldIds ?? []) args.push('--field-id', f)
  if (options.viewId !== undefined) args.push('--view-id', options.viewId)
  if (options.filter !== undefined) args.push('--filter-json', JSON.stringify(options.filter))
  if (options.sort !== undefined && options.sort.length > 0) {
    args.push('--sort-json', JSON.stringify(options.sort))
  }
  if (options.limit !== undefined) args.push('--limit', String(options.limit))
  if (options.offset !== undefined) args.push('--offset', String(options.offset))
  return runCli<RecordMatrix>(args, { signal })
}

/** 按记录 ID 取一条或多条。 */
export function getRecords(
  baseToken: string,
  tableId: string,
  recordIds: readonly string[],
  signal?: AbortSignal,
): Promise<RecordMatrix> {
  const args = ['base', '+record-get', '--base-token', baseToken, '--table-id', tableId, '--format', 'json']
  for (const id of recordIds) args.push('--record-id', id)
  return runCli<RecordMatrix>(args, { signal })
}

/**
 * `record-list` 的 --limit 上限。
 * 实测：非 ndjson 格式为 1–200，传入 500 会报
 * "invalid --limit 500: must be between 1 and 200"。
 */
export const MAX_PAGE_SIZE = 200

/**
 * 分页拉取全部记录，自动翻页直到取完。
 *
 * 长篇连载可达数百章，单页 200 条不够，必须分页。
 * 返回合并后的矩阵（字段顺序以首页为准）。
 */
export async function listAllRecords(
  baseToken: string,
  tableId: string,
  options: Omit<ListRecordsOptions, 'limit' | 'offset'> = {},
  signal?: AbortSignal,
): Promise<RecordMatrix> {
  const all: unknown[][] = []
  const pages: RecordMatrix[] = []
  let offset = 0

  for (;;) {
    const page = await listRecords(
      baseToken,
      tableId,
      { ...options, limit: MAX_PAGE_SIZE, offset },
      signal,
    )
    pages.push(page)
    all.push(...page.data)
    if (page.has_more !== true || page.data.length === 0) break
    offset += page.data.length
  }

  const first = pages[0]

  const recordIds: string[] = []
  for (const p of pages) recordIds.push(...(p.record_id_list ?? []))

  return {
    data: all,
    fields: first?.fields ?? [],
    field_id_list: first?.field_id_list ?? [],
    field_type_list: first?.field_type_list ?? [],
    record_id_list: recordIds,
    ...pages[pages.length - 1]?.has_more === true ? { has_more: true } : {},
  }
}

/** 创建视图。type 支持 grid / kanban / gallery / calendar / gantt。 */
export async function createViews(
  baseToken: string,
  tableId: string,
  views: readonly { name: string; type?: 'grid' | 'kanban' | 'gallery' | 'calendar' | 'gantt' }[],
  signal?: AbortSignal,
): Promise<{ id: string; name: string; type: string }[]> {
  return withTempDir(async (dir) => {
    const f = await dir.write('views.json', JSON.stringify(views))
    const res = await runCli<{ views: { id: string; name: string; type: string }[] }>(
      ['base', '+view-create',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--json', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return res.views
  })
}

/** 设置视图筛选。 */
export async function setViewFilter(
  baseToken: string,
  tableId: string,
  viewId: string,
  filter: FilterJson,
  signal?: AbortSignal,
): Promise<void> {
  await withTempDir(async (dir) => {
    const f = await dir.write('filter.json', JSON.stringify(filter))
    await runCli(
      ['base', '+view-set-filter',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--view-id', viewId,
        '--json', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
  })
}

/** 创建 Base。 */
export function createBase(
  name: string,
  options: { folderToken?: string; timeZone?: string } = {},
  signal?: AbortSignal,
): Promise<{ base_token: string; name: string; url: string }> {
  const args = ['base', '+base-create', '--name', name]
  if (options.folderToken !== undefined) args.push('--folder-token', options.folderToken)
  args.push('--time-zone', options.timeZone ?? 'Asia/Shanghai')
  return runCli<CreatedBaseEnvelope>(args, { signal }).then(unpackCreatedBase)
}

/**
 * `base-create` 的响应比其他命令多一层 `data.base` 包裹（实测）：
 * `{"data": {"base": {"base_token": "...", "url": "..."}, "created": true}}`
 */
interface CreatedBaseEnvelope {
  base: { base_token: string; name?: string; url?: string }
  created?: boolean
}

function unpackCreatedBase(e: CreatedBaseEnvelope): { base_token: string; name: string; url: string } {
  if (e.base?.base_token === undefined) {
    throw new Error('base-create 未返回 base_token')
  }
  return {
    base_token: e.base.base_token,
    name: e.base.name ?? '',
    url: e.base.url ?? '',
  }
}

/**
 * 把 record-list 的矩阵结果转成对象数组，便于上层使用。
 * 矩阵形式节省带宽但难用，此处做一次转换。
 *
 * 每行会附带 `__recordId`（若 CLI 返回了 record_id_list），
 * 更新该记录时需要它——务必保留，不要在做对象映射时丢弃。
 */
export function matrixToObjects(matrix: RecordMatrix): Record<string, unknown>[] {
  return matrix.data.map((row, rowIndex) => {
    const obj: Record<string, unknown> = {}
    matrix.fields.forEach((field, i) => {
      obj[field] = row[i]
    })
    const rid = matrix.record_id_list?.[rowIndex]
    if (rid !== undefined) obj['__recordId'] = rid
    return obj
  })
}
