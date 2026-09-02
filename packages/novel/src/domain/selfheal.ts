/**
 * 写入自愈。
 *
 * 背景：新建作品库的平台收敛是分钟级的（表 → 字段 → link 字段逐级就绪）。
 * 期间写入会报 800030201 not_found。在工具里死等不现实，
 * 改为「撞到再补」：报 not_found → initWork 幂等补齐缺失字段 → 退避重试。
 *
 * 与 updateRecordsWithSelfHeal 对齐：4 次退避（3s/6s/9s），第 2 次前补一次
 * initWork。最后一次失败时把 e.message 与 hintFor(kind) 一起装饰抛出去，
 * 让 agent 不再误归因为「权限/数据问题」。
 *
 * 800030005（select 写入未预置选项）：字段定义没收敛问题，而是模型会为新
 * 作品发明新选项（性格标签「怂」、分类「黑帮」）。靠 UI 手动加选项对 agent
 * 不可行——自动读取字段定义 → 合并缺失选项 → updateField 提交 → 立即重试。
 * 实机踩坑 2026-09-02：人物官建模 6 人物全部被 800030005 拒绝。
 *
 * @module @unwr/novel/domain/selfheal
 */

import { base } from '@unwr/feishu'

/**
 * 为本次写入涉及的 select 字段补齐缺失选项（幂等：已存在的选项跳过）。
 * 返回「字段: 补充的选项」描述列表；无可补选项时返回空数组。
 *
 * 只动 select 字段：text/link/number 等类型的数组值（别名/出场章节等）
 * 不存在"选项"概念，绝不能误改字段定义。
 */
async function ensureSelectOptions(
  baseToken: string,
  table: string,
  rows: readonly Record<string, unknown>[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  // 1. 候选值：字段名 → 本次写入出现过的字符串值（数组值才可能是 select）
  const candidates = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (!Array.isArray(value)) continue
      let set = candidates.get(field)
      if (set === undefined) {
        set = new Set<string>()
        candidates.set(field, set)
      }
      for (const v of value) {
        if (typeof v === 'string' && v !== '') set.add(v)
      }
    }
  }
  if (candidates.size === 0) return []

  // 2. 找出本表中的 select 字段（按字段名对上候选）
  const { fields } = await base.listFields(baseToken, table, signal)
  const healed: string[] = []
  for (const f of fields) {
    if (f.type !== 'select') continue
    const wanted = candidates.get(f.name)
    if (wanted === undefined || wanted.size === 0) continue

    const { field } = await base.getField(baseToken, table, f.id, signal)
    const existing = new Set((field.options ?? []).map((o) => o.name))
    const missing = [...wanted].filter((v) => !existing.has(v))

    // 无条件 full PUT（现有 ∪ 写入值）：两种情形都要覆盖——
    //   a) 选项真缺失（missing 非空）；
    //   b) **传播竞态**：预检刚合并完、field-get 已能看到选项，
    //      但写入端尚未生效（实机 2026-09-02：人物官 6 人物全部
    //      800030005，预检明明跑过）。此时 missing 为空，但重放一次
    //      幂等 PUT 仍是必要的——它触发选项定义的重新提交/生效。
    const union = [...new Set([...(field.options ?? []).map((o) => o.name), ...wanted])]
      .map((name) => ({ name }))
    await base.updateField(baseToken, table, f.id, {
      name: field.name,
      type: 'select',
      ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
      options: union,
    }, signal)
    healed.push(missing.length > 0 ? `${f.name}+${missing.join('/')}` : `${f.name}(重放)`)
  }
  return healed
}

/** 带自愈的记录创建。onHeal 用于向调用方暴露自愈动作。 */
export async function createRecordsWithSelfHeal(
  baseToken: string,
  table: string,
  records: readonly Record<string, unknown>[],
  signal: AbortSignal | undefined,
  onHeal: (message: string) => void,
): Promise<string[]> {
  const { FeishuError, hintFor } = await import('@unwr/feishu')
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await base.createRecords(baseToken, table, records as never, signal)
    } catch (e) {
      if (!(e instanceof FeishuError)) throw e
      // 800030005 = select 写入了未预置/未生效的选项 → 强制并集 PUT 后立即重试
      //（覆盖真缺失与传播竞态两种情形，重试上限交给外层 attempt=4）
      if (e.code === 800030005 && attempt < 4) {
        const healed = await ensureSelectOptions(baseToken, table, records, signal)
          .catch(() => [] as string[])
        onHeal(`写入 ${table} 遇 800030005：已为 select 字段强制合并选项（${healed.join('、') || '无候选'}），重试 ${attempt}/3`)
        continue // 立即重试，不退避——选项刚提交，没有收敛等待
      }
      // 800030201 = 字段不属于该表；1254045/not_found = 新库收敛期的资源不可见。
      // 两者都用「补齐 schema + 退避重试」自愈。
      const healable = e.code === 800030201 || e.kind === 'not_found'
      if (!healable || attempt === 4) {
        // 退避耗尽后，把代码与可操作 hint 一并抛出去。
        const hint = hintFor(e.kind)
        throw new Error(
          `写入 ${table} 失败：${e.code ?? e.kind} — ${e.message}`
          + (hint ? `；${hint}` : '')
          + '（已在 4 次重试内触发 initWork；如仍未恢复，多为表名/字段名拼写错或权限被回收）',
          { cause: e },
        )
      }
      onHeal(`写入 ${table} 遇 ${e.code ?? e.kind}（新库收敛中），退避重试 ${attempt}/3……`)
      await new Promise((r) => setTimeout(r, attempt * 3000))
      if (attempt === 2) {
        const { initWork } = await import('./bootstrap.ts')
        await initWork(baseToken, signal).catch(() => undefined)
      }
    }
  }
  throw new Error(`写入 ${table} 失败：重试循环异常退出`) // 不可达，类型守卫用
}

/**
 * 带自愈的记录更新（link 字段回填等场景）。
 *
 * 实测：新库里 link 字段刚建好就 update 也会报 not_found——
 * 字段本身也需要收敛时间。退避重试 4 次（3s/6s/9s），期间
 * 触发一次 initWork 幂等补齐。
 */
export async function updateRecordsWithSelfHeal(
  baseToken: string,
  table: string,
  updates: Readonly<Record<string, Record<string, unknown>>>,
  signal: AbortSignal | undefined,
  onHeal?: (message: string) => void,
): Promise<void> {
  const { FeishuError, hintFor } = await import('@unwr/feishu')
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await base.updateRecords(baseToken, table, updates as never, signal)
      return
    } catch (e) {
      if (!(e instanceof FeishuError)) throw e
      // 与 create 对齐：select 选项缺失/未生效 → 强制并集 PUT 后立即重试
      if (e.code === 800030005 && attempt < 4) {
        const rows = Object.values(updates)
        const healed = await ensureSelectOptions(baseToken, table, rows, signal)
          .catch(() => [] as string[])
        onHeal?.(`更新 ${table} 遇 800030005：已强制合并 select 选项（${healed.join('、') || '无候选'}），重试 ${attempt}/3`)
        continue
      }
      const healable = e.code === 800030201 || e.kind === 'not_found'
      if (!healable || attempt === 4) {
        const hint = hintFor(e.kind)
        throw new Error(
          `${table} 更新失败：${e.code ?? e.kind} — ${e.message}`
          + (hint ? `；${hint}` : ''),
          { cause: e },
        )
      }
      onHeal?.(`${table} 更新遇 ${e.code ?? e.kind}（收敛中），重试 ${attempt}/3……`)
      await new Promise((r) => setTimeout(r, attempt * 3000))
      if (attempt === 2) {
        const { initWork } = await import('./bootstrap.ts')
        await initWork(baseToken, signal).catch(() => undefined)
      }
    }
  }
}

/**
 * 两段式创建带 link 字段的记录：create 标量 + update 回填 link。
 *
 * 为什么必须两段（真机实证 2026-09-02）：lark-cli 的
 * `+record-batch-create` **不支持写 link 字段**——值用 ["recordId"]、
 * [{id:"recordId"}]、等待新库收敛 12s，一律 not_found；
 * 而 `+record-batch-update` 回填 link 完全正常（[{id}] 与 ["id"] 均可）。
 * 由此前 upsertRelation 连续 12 次 not_found 全部对上。
 *
 * @param scalarFields 不含任何 link 字段的普通字段
 * @param linkFields 字段名 → 目标 record id 数组（调用方解析好）
 * @returns 新记录 recordId
 */
export async function createRecordWithLinks(
  baseToken: string,
  table: string,
  scalarFields: Record<string, unknown>,
  linkFields: Record<string, string[]>,
  signal: AbortSignal | undefined,
  onHeal: (message: string) => void,
): Promise<string> {
  const ids = await createRecordsWithSelfHeal(baseToken, table, [scalarFields], signal, onHeal)
  const recordId = ids[0]
  if (recordId === undefined) {
    throw new Error(`${table} 记录创建失败：未返回 record_id`)
  }
  const links = Object.entries(linkFields).filter(([, targetIds]) => targetIds.length > 0)
  if (links.length > 0) {
    const patch: Record<string, unknown> = {}
    for (const [field, targetIds] of links) {
      patch[field] = targetIds.map((id) => ({ id }))
    }
    await updateRecordsWithSelfHeal(baseToken, table, { [recordId]: patch }, signal, onHeal)
  }
  return recordId
}
