/**
 * 端到端测试的共享工具。
 * @module
 */

import { base } from '@unwr/feishu'

const aliveCache = new Map<string, boolean>()

/**
 * 解析可用的测试库 token。
 *
 * `UNWR_TEST_BASE` 指向的库可能已被删除（实测：清理云盘后所有查询报
 * 1002 note has been deleted）。先探活：可查则返回 token，否则返回 ''
 * （调用方 skipIf 跳过）。结果按进程缓存。
 */
export async function resolveTestBase(): Promise<string> {
  const token = process.env.UNWR_TEST_BASE ?? ''
  if (token === '') return ''
  if (aliveCache.has(token)) return aliveCache.get(token) as string

  let usable = ''
  try {
    await base.listTables(token)
    usable = token
  } catch {
    usable = ''
  }
  aliveCache.set(token, usable)
  return usable
}

/**
 * 等待测试库**写路径**收敛。
 *
 * 实测：新建 Base 的收敛是分钟级且**多级**的——Base 可查 → 表 → 字段 →
 * link 字段 → 记录可写，逐级就绪，listFields 通过不代表记录可写。
 * 唯一可靠的判据是**实际写入一条探针记录**。
 *
 * 探针写入人物表（名字带 __ 前缀便于识别，留在库里无害）。
 *
 * @throws 超时仍不可写——此时应让用例失败而非静默跳过
 */
export async function waitForBaseReady(
  baseToken: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await base.createRecords(
        baseToken,
        '人物表',
        [{ 姓名: '__收敛探针__', 身份: '探针（可忽略）' }],
        signal,
      )
      return
    } catch (e) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `测试库 ${baseToken} 在 ${Math.round(timeoutMs / 1000)}s 内写路径未收敛：`
          + `${e instanceof Error ? e.message : String(e)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

/**
 * 新库收敛窗口内执行飞书调用：遇 not_found 自动退避重试。
 *
 * 产品层已有 createRecordsWithSelfHeal 覆盖写路径；这里覆盖测试里
 * 直连 base 的读/写调用（字段收敛期的 1254045/800030201）。
 */
export async function withConvergenceRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      if (!/not.?found|1254045|800030201/i.test(msg)) throw e
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
