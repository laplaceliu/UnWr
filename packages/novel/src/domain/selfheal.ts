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
    // 800030201 = 字段不属于该表（新库字段收敛中）→ 补齐后重试
    if (e.code !== 800030201) throw e
    onHeal(`检测到 ${table} 字段缺失（新库字段收敛中），自动补齐后重试……`)
    const { initWork } = await import('./bootstrap.ts')
    await initWork(baseToken, signal)
    return await base.createRecords(baseToken, table, records as never, signal)
  }
}
