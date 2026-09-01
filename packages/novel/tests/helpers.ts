/**
 * 端到端测试的共享工具。
 * @module
 */

import { base } from '@unwr/feishu'

/**
 * 解析可用的测试库 token。
 *
 * `UNWR_TEST_BASE` 指向的库**可能已被删除**（实测发生过：用户清理云盘
 * 后所有查询报 1002 note has been deleted，端到端用例一片红）。
 * 这里先探活：可查则返回 token，否则返回 ''（调用方 skipIf 跳过）。
 *
 * 结果按进程缓存——探活一次即可，不必每个用例都查。
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

const aliveCache = new Map<string, string>()

/**
 * 等待测试库完全收敛（可查询、可写入）。
 *
 * 新建 Base 的收敛是**分钟级**的（Base 可查 → 表 → link 字段 → 记录读写
 * 逐级就绪）。端到端用例在 beforeAll 调用本函数，避免在收敛窗口内
 * 间歇性 not_found。
 *
 * @throws 超时仍不可用——此时应让用例失败而非静默跳过
 */
export async function waitForBaseReady(
  baseToken: string,
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      // 用人物表做探针：能列出字段即认为收敛完成
      await base.listFields(baseToken, '人物表', signal)
      return
    } catch (e) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `测试库 ${baseToken} 在 ${timeoutMs}ms 内未收敛：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
