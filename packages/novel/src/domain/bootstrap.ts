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

import { base, FeishuError, type CellValue, type FieldInfo, type FieldSchema } from '@unwr/feishu'
import { LINK_FIELDS, TABLE_SCHEMAS } from '@unwr/schema'

/** ensureWorkSchema 的结果。 */
export interface EnsureSchemaResult {
  createdTables: string[]
  createdFields: number
  /** 创建失败的关联字段（sourceTable.field）——调用方必须让用户知道 */
  failedLinks: string[]
  /** 修复的历史遗留重名字段（table.field(3→1)）——数据已并集合并到首列 */
  repairedDuplicates: string[]
}

/** 平台错误码：表已存在（并发建表竞争，败者应复用胜者的表）。 */
const CODE_TABLE_EXISTS = 800010102
/** 平台错误码：字段名重复（并发建字段竞争，败者应视为成功）。 */
const CODE_FIELD_DUPLICATE = 800010205

/**
 * 回填验证的退避间隔（ms）。实测大库上 link 写入后 record-get 会短暂读旧值，
 * 单次立即验证会误报失败（2026-09-03 实机）。测试里可改短以提速。
 */
export const verifyRetryDelays: number[] = [0, 3000, 6000]

function errCode(e: unknown): number | undefined {
  return e instanceof FeishuError ? e.code : undefined
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
  //   并发竞争（主会话与子代理同时初始化）：败者收到"表已存在"，
  //   复用胜者的表继续——这不算失败。
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    try {
      const info = await base.createTable(baseToken, name, fields, signal)
      tableIdByName.set(name, info.id)
      createdTables.push(name)
      createdFields += fields.length
    } catch (e) {
      if (errCode(e) !== CODE_TABLE_EXISTS) throw e
      const { tables: now } = await base.listTables(baseToken, signal)
      const winner = now.find((t) => t.name === name)
      if (winner === undefined) throw e
      tableIdByName.set(name, winner.id)
    }
  }

  // 2. 字段快照（含 id，供重名修复用）：每张表取一次（并行），
  //    供普通字段、link 字段两阶段与重名检测共用。
  //    新建的表字段必然完整，跳过探测。
  const fieldsByTable = new Map<string, FieldInfo[]>()
  await pMap(Object.entries(TABLE_SCHEMAS), async ([name]) => {
    const id = tableIdByName.get(name)
    if (id === undefined) return
    if (createdTables.includes(name)) {
      fieldsByTable.set(name, [])
      return
    }
    fieldsByTable.set(name, (await base.listFields(baseToken, id, signal)).fields)
  }, 6)
  const existingByTable = new Map<string, Set<string>>(
    [...fieldsByTable].map(([n, fs]) => [n, new Set(fs.map((f) => f.name))] as const),
  )

  // 3. 已有表补齐缺失的普通字段（旧库升级场景）。
  //    只按名补缺——**不改名、不删字段**，与 sync-fields 脚本同一原则。
  //    并发竞争败者收到"字段名重复"→ 字段其实已经在了，视为成功。
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (createdTables.includes(name)) continue
    const existing = existingByTable.get(name)
    const sourceId = tableIdByName.get(name)
    if (existing === undefined || sourceId === undefined) continue
    const missing = fields.filter((f) => !existing.has(f.name))
    if (missing.length === 0) continue
    try {
      await base.createFields(baseToken, sourceId, missing, signal)
      createdFields += missing.length
    } catch (e) {
      if (errCode(e) !== CODE_FIELD_DUPLICATE) throw e
    }
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
      } catch (e) {
        // 并发竞争败者：字段已存在 = 目的达成，不算失败
        if (errCode(e) === CODE_FIELD_DUPLICATE) {
          createdFields++
          return
        }
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

  // 6. 修复历史遗留的重名字段（见 repairDuplicateFields 顶部说明）。
  const repairedDuplicates = await repairDuplicateFields(
    baseToken, tableIdByName, fieldsByTable, signal,
  )

  return { createdTables, createdFields, failedLinks, repairedDuplicates }
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
 * 中断过的修复遗留：`__legacy__<原名>__<字段id>`。
 * 拆解出逻辑字段名，归回重名组重修（合并是幂等的并集，重复执行无害）。
 */
const LEGACY_PREFIX = '__legacy__'

/** 修复状态机的三个阶段没有持久化标记——靠命名约定认领自己改过的字段。 */
function legacyOf(name: string): { origin: string; fieldId: string } | undefined {
  if (!name.startsWith(LEGACY_PREFIX)) return undefined
  const rest = name.slice(LEGACY_PREFIX.length)
  const cut = rest.lastIndexOf('__')
  if (cut <= 0) return undefined
  return { origin: rest.slice(0, cut), fieldId: rest.slice(cut + 2) }
}

/**
 * 修复历史遗留的**重名字段**（实机事故 2026-09-03，事件表 `章节`×2 等 4 处）。
 *
 * 成因：早期 `+field-create` 允许同名（check-then-act 竞争 + 旧版 CLI 不拦），
 * 两列各攒了一部分 link 数据（实测事件表 91 条：A 独占 12、B 独占 43、都有 36）。
 * 读取按名合并（matrixToObjects 并集）能救读，但**按名写入落到哪列不可控**，
 * 且同类校验（verifyLinkBackfill）历史上因此误报"回填未生效"。
 * 根治 = 把数据并到一列、删掉多余的列。
 *
 * 安全顺序（每一步失败都停在原地，绝不丢数据）：
 *   1. 多余列改名 `__legacy__原名__字段id` → 原名唯一，按名写入不再有歧义
 *   2. 读全列（按 field_id_list 对位，**不能**用按名的 matrixToObjects——
 *      那会把两列提前并掉，丢失"哪条记录缺哪个值"的信息）
 *   3. 算并集，写回保留列；写完按 **record-get** 验证（实测立即一致）
 *   4. 验证通过才删除多余列
 *
 * 失败处理：任何一步失败 → 跳过该组并记日志，**不抛出**（修复是尽力而为，
 * 不应让 get_config 挂掉；且读取侧的并集合并已保证正确性）。
 */
async function repairDuplicateFields(
  baseToken: string,
  tableIdByName: ReadonlyMap<string, string>,
  fieldsByTable: ReadonlyMap<string, FieldInfo[]>,
  signal?: AbortSignal,
): Promise<string[]> {
  const repaired: string[] = []

  for (const [tableName, fields] of fieldsByTable) {
    if (fields.length === 0) continue
    const tableId = tableIdByName.get(tableName)
    if (tableId === undefined) continue

    // 分组：按逻辑字段名（遗留名归回原名）。key = 逻辑名
    const groups = new Map<string, FieldInfo[]>()
    for (const f of fields) {
      const key = legacyOf(f.name)?.origin ?? f.name
      const g = groups.get(key) ?? []
      g.push(f)
      groups.set(key, g)
    }

    for (const [fieldName, group] of groups) {
      if (group.length < 2) continue
      // 保留列 = 名字与逻辑名完全一致的那个（无遗留改名痕迹的原始列）；
      // 全是遗留列（异常态）时不动数据，只报告。
      const keep = group.find((f) => f.name === fieldName)
      const extras = group.filter((f) => f !== keep)
      if (keep === undefined) {
        console.error(
          `[unwr] 重名字段 ${tableName}.${fieldName} 无原始列可保留，跳过修复（仅合并读取）`,
        )
        continue
      }
      try {
        // 1) 未改名的多余列先改名（已是 __legacy__ 名的跳过——中断续修）
        for (const extra of extras) {
          if (legacyOf(extra.name) !== undefined) continue
          const detail = (await base.getField(baseToken, tableId, extra.id, signal)).field
          const legacyName = `${LEGACY_PREFIX}${fieldName}__${extra.id}`
          await base.updateField(baseToken, tableId, extra.id, {
            name: legacyName,
            type: detail.type as FieldSchema['type'],
            ...(detail.link_table === undefined ? {} : { link_table: detail.link_table }),
          }, signal)
        }
        // 2+3) 合并数据到保留列并验证；有值缺失时才写
        const pendingWrites = await mergeDupColumnData(
          baseToken, tableId, fieldName, keep, extras, signal,
        )
        // 4) 验证通过（或本就无缺失）才删除多余列
        for (const extra of extras) {
          await base.deleteField(baseToken, tableId, extra.id, signal)
        }
        repaired.push(`${tableName}.${fieldName}(${group.length}→1)`)
        console.error(
          `[unwr] 已修复重名字段 ${tableName}.${fieldName}：`
            + `${group.length} 列合一，回填 ${pendingWrites} 条记录`,
        )
      } catch (e) {
        // 状态停在中间（可能有 __legacy__ 列残留）——下次修复会按遗留名
        // 重新归组、重跑并集合并（幂等），最终收敛。
        console.error(
          `[unwr] 重名字段修复失败（跳过，不影响使用）: ${tableName}.${fieldName}: `
            + `${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  return repaired
}

/**
 * 把多余列的数据并集写入保留列。
 *
 * @returns 实际回填的记录数
 * @throws 验证不通过时抛出——调用方据此**不删除**多余列
 */
async function mergeDupColumnData(
  baseToken: string,
  tableId: string,
  fieldName: string,
  keep: FieldInfo,
  extras: readonly FieldInfo[],
  signal?: AbortSignal,
): Promise<number> {
  const colIds = [keep.id, ...extras.map((e) => e.id)]
  // 按列 id 对位读原始矩阵，保留"哪列哪条"的信息
  const matrix = await base.listAllRecords(baseToken, tableId, { fieldIds: colIds }, signal)
  const colIndex = new Map<string, number>(
    matrix.field_id_list.map((id, i) => [id, i] as const),
  )
  const ki = colIndex.get(keep.id)
  if (ki === undefined) throw new Error(`保留列 ${keep.id} 不在读取结果里`)

  // 每条记录：保留列 ∪ 各多余列 → 与保留列现值比较，缺则补
  const updates: Record<string, Record<string, CellValue>> = {}
  matrix.data.forEach((row, r) => {
    const rid = matrix.record_id_list?.[r]
    if (rid === undefined) return
    const keepCell = row[ki]
    let merged: unknown[] = Array.isArray(keepCell) ? keepCell : []
    for (const extra of extras) {
      const ei = colIndex.get(extra.id)
      if (ei === undefined) continue
      const cell = row[ei]
      if (Array.isArray(cell)) merged = unionLinkCells(merged, cell)
    }
    if (sameLinkCells(keepCell, merged)) return
    // link 单元格的运行时形状是 {id:string}[]，属于 CellValue 的一个分支
    updates[rid] = { [fieldName]: merged as unknown as CellValue }
  })
  if (Object.keys(updates).length === 0) return 0

  // 分批写（batch-update 上限 200，留余量）
  const entries = Object.entries(updates)
  for (let i = 0; i < entries.length; i += 100) {
    await base.updateRecords(
      baseToken, tableId, Object.fromEntries(entries.slice(i, i + 100)), signal,
    )
  }

  // 验证：按 record-get 读回，确认保留列已含全部并值。
  // **实测（2026-09-03 实机库）**：link 回填后 record-get 也可能短暂读旧值
  // （测试库上立即一致，大库上观察到数秒延迟）——所以验证带退避重试，
  // 全部轮次都不过才算失败；验证不过绝不删除多余列。
  const ids = entries.map(([rid]) => rid)
  const delays = verifyRetryDelays
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const delay = delays[attempt] ?? 0
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    let verified = true
    const failures: string[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100)
      const vm = await base.getRecords(baseToken, tableId, slice, signal)
      const vi = vm.field_id_list.indexOf(keep.id)
      if (vi < 0) throw new Error(`验证读取中找不到保留列 ${keep.id}`)
      const want = new Map(slice.map((rid) => [rid, updates[rid]![fieldName] as unknown[]]))
      vm.data.forEach((row, r) => {
        const rid = vm.record_id_list?.[r]
        const expect = rid === undefined ? undefined : want.get(rid)
        if (expect === undefined) return
        const got = row[vi]
        if (!containsAll(got, expect)) {
          verified = false
          failures.push(
            `记录 ${rid} 的 ${fieldName} 期望含 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got)}`,
          )
        }
      })
    }
    if (verified) return entries.length
    if (attempt === delays.length - 1) {
      throw new Error(`回填验证失败（已重试 ${delays.length} 次）：${failures.slice(0, 3).join('；')}`)
    }
    console.error(`[unwr] 回填验证未通过（${failures.length} 条），${(delays[attempt + 1] ?? 0) / 1000}s 后重试……`)
  }
  return entries.length
}

/** link 单元格并集（按元素 JSON 去重，保序）。 */
function unionLinkCells(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const v of [...a, ...b]) {
    const k = JSON.stringify(v)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(v)
    }
  }
  return out
}

/** 两个 link 单元格是否等价（集合意义）。 */
function sameLinkCells(a: unknown, b: readonly unknown[]): boolean {
  return containsAll(a, b) && containsAll(b, a)
}

/** a 是否包含 b 的全部元素（按 JSON 结构；两端都可能是 null/undefined）。 */
function containsAll(a: unknown, b: unknown): boolean {
  const set = new Set((Array.isArray(a) ? a : []).map((v) => JSON.stringify(v)))
  return (Array.isArray(b) ? b : []).every((v) => set.has(JSON.stringify(v)))
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
    return { ok: true, createdTables: [], createdFields: 0, failedLinks: [], repairedDuplicates: [] }
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
    return { ok: false, createdTables: [], createdFields: 0, failedLinks: [], repairedDuplicates: [] }
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
