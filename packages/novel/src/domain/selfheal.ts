/**
 * 写入自愈。
 *
 * 背景：新建作品库的平台收敛是分钟级的（表 → 字段 → link 字段逐级就绪）。
 * 期间写入会报 800030201 not_found。在工具里死等不现实，
 * 改为「撞到再补」：报 not_found → initWork 幂等补齐缺失字段 → 重试一次。
 *
 * @module @unwr/novel/domain/selfheal
 */

import { base } from '@unwr/feishu'

/** 带自愈的记录创建。onHeal 用于向调用方暴露自愈动作。 */
export async function createRecordsWithSelfHeal(
  baseToken: string,
  table: string,
  records: readonly Record<string, unknown>[],
  signal: AbortSignal | undefined,
  onHeal: (message: string) => void,
): Promise<string[]> {
  const { FeishuError } = await import('@unwr/feishu')
  try {
    return await base.createRecords(baseToken, table, records as never, signal)
  } catch (e) {
    if (!(e instanceof FeishuError)) throw e
    // 800030005 = select 写入了未预置的选项——补字段无用，给出可操作提示
    if (e.code === 800030005) {
      throw new Error(
        `写入 ${table} 失败：select 字段的选项不存在（如性格标签）。`
        + '请在飞书表中为该字段添加此选项后重试。',
        { cause: e },
      )
    }
    // 800030201 = 字段不属于该表；1254045/not_found = 新库收敛期的资源不可见。
    // 两者都用「补齐 schema + 退避重试」自愈。
    const healable = e.code === 800030201 || e.kind === 'not_found'
    if (!healable) throw e
    onHeal(`写入 ${table} 遇 ${e.code ?? e.kind}（新库收敛中），自动补齐后重试……`)
    await new Promise((r) => setTimeout(r, 2500))
    const { initWork } = await import('./bootstrap.ts')
    await initWork(baseToken, signal)
    return await base.createRecords(baseToken, table, records as never, signal)
  }
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
  const { FeishuError } = await import('@unwr/feishu')
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await base.updateRecords(baseToken, table, updates as never, signal)
      return
    } catch (e) {
      if (!(e instanceof FeishuError)) throw e
      const healable = e.code === 800030201 || e.kind === 'not_found'
      if (!healable || attempt === 4) throw e
      onHeal?.(`${table} 更新遇 ${e.code ?? e.kind}（收敛中），重试 ${attempt}/3……`)
      await new Promise((r) => setTimeout(r, attempt * 3000))
      if (attempt === 2) {
        const { initWork } = await import('./bootstrap.ts')
        await initWork(baseToken, signal).catch(() => undefined)
      }
    }
  }
}
