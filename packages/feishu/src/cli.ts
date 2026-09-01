/**
 * lark-cli 进程封装。
 *
 * 实测数据（技术选型阶段）：
 *   - 单次调用 640ms，其中纯进程启动仅 ~67ms（10%），网络占 90%
 *   - 并行 4 次 605ms vs 串行 2290ms，加速比 3.8× 近线性
 * 结论：性能瓶颈在网络，优化靠并行而非换 SDK。因此本模块内置并发控制。
 *
 * 注意：lark-cli 是 47MB 的 Go 静态二进制，package.json 无 main 字段，
 * 无法作为库 require，只能 spawn。
 *
 * @module @unwr/feishu/cli
 */

import { spawn } from 'node:child_process'
import type { CliErrorPayload } from './errors.ts'
import { FeishuError, classifyError } from './errors.ts'

/** 执行身份。`user` 用于读写用户自己的资源，`bot` 用于机器人资源。 */
export type Identity = 'user' | 'bot'

/** spawn 选项。 */
export interface RunOptions {
  /** 工作目录。`@file` 参数是相对路径，必须配合临时目录使用 */
  cwd?: string
  /** 身份，默认 user */
  as?: Identity
  /** 超时（毫秒），默认 60s */
  timeoutMs?: number
  /** 中止信号 */
  signal?: AbortSignal
}

/** 默认的 lark-cli 可执行文件路径。 */
const DEFAULT_BIN = process.env.UNWR_LARK_BIN ?? 'lark-cli'

/** CLI 成功返回的信封。 */
interface CliEnvelope<T> {
  ok: boolean
  identity?: string
  data?: T
  error?: CliErrorPayload
}

/** 解析重试配置。 */
export interface RetryPolicy {
  /** 最大重试次数，默认 2 */
  maxRetries?: number
  /** 基础退避毫秒，默认 500，指数退避 */
  baseDelayMs?: number
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new FeishuError('timeout', 'aborted while sleeping'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new FeishuError('timeout', 'aborted while sleeping'))
    }, { once: true })
  })

/**
 * 执行一条 lark-cli 命令并返回解析后的 data。
 *
 * 自动追加 `--as`；失败时抛出 {@link FeishuError}。
 */
export async function runCli<T>(
  args: readonly string[],
  options: RunOptions = {},
  retry: RetryPolicy = {},
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 500 } = retry
  const command = `${DEFAULT_BIN} ${args.join(' ')}`

  let lastError: FeishuError | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && lastError !== undefined) {
      await sleep(baseDelayMs * 2 ** (attempt - 1), options.signal)
    }
    try {
      return await runOnce<T>(args, options, command)
    } catch (e) {
      const fe = e instanceof FeishuError
        ? e
        : new FeishuError('unknown', e instanceof Error ? e.message : String(e), { cliCommand: command })
      lastError = fe
      if (!fe.retryable) throw fe
    }
  }

  throw lastError ?? new FeishuError('unknown', `cli failed: ${command}`, { cliCommand: command })
}

async function runOnce<T>(
  args: readonly string[],
  options: RunOptions,
  command: string,
): Promise<T> {
  const { cwd, as = 'user', timeoutMs = 60_000, signal } = options
  const argv = [...args, '--as', as]

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string
    stderr: string
    exitCode: number | null
  }>((resolve, reject) => {
    const child = spawn(DEFAULT_BIN, argv, {
      cwd,
      // 不经过 shell：规避 shell 转义问题（章节正文含引号、反引号等）
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new FeishuError('timeout', `cli timed out after ${timeoutMs}ms`, { cliCommand: command }))
    }, timeoutMs)

    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      reject(new FeishuError('timeout', 'cli aborted', { cliCommand: command }))
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { out += c })
    child.stderr.on('data', (c: string) => { err += c })

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new FeishuError(
        /ENOENT/.test(e.message) ? 'unknown' : 'unknown',
        `failed to spawn lark-cli: ${e.message}（请确认已安装，或用 UNWR_LARK_BIN 指定路径）`,
        { cliCommand: command, cause: e },
      ))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout: out, stderr: err, exitCode: code })
    })
  })

  // 解析响应信封。stdout 与 stderr 都要试：实测 lark-cli 对部分错误
  // （如 Base 被删除后的 API 错误）会把 pretty JSON 打到 stderr 而非 stdout，
  // 只解析 stdout 会把这些错误误报为「无法解析输出」，掩盖真实原因。
  const parsed = parseEnvelope<T>(stdout) ?? parseEnvelope<T>(stderr)
  if (parsed === undefined) {
    const detail = stderr.trim() !== '' ? stderr.trim() : stdout.trim()
    throw new FeishuError(
      classifyError(detail),
      `无法解析 lark-cli 输出：${detail.slice(0, 400)}`,
      { cliCommand: command },
    )
  }

  if (parsed.ok !== true || parsed.error !== undefined) {
    const message = parsed.error?.message ?? `cli failed with exit code ${String(exitCode)}`
    throw new FeishuError(
      classifyError(message, parsed.error?.code),
      message,
      {
        code: parsed.error?.code,
        cliCommand: command,
        logId: parsed.error?.log_id,
      },
    )
  }

  return parsed.data as T
}

/**
 * 从可能混有进度行的 stdout 中提取 JSON 信封。
 *
 * 注意：**不能**用 `lastIndexOf('{')` —— 错误响应的结构是
 * `{"ok":false, "error":{...}}`，最后一个 `{` 指向嵌套的 `error` 对象，
 * 会被误当成信封本身，于是 `ok` 读不到、错误信息被当成"无法解析输出"。
 *
 * 正确做法：从**第一个** `{` 开始，用括号配平找到完整 JSON 边界。
 */
function parseEnvelope<T>(raw: string): CliEnvelope<T> | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  // 快速路径：整体就是 JSON
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as CliEnvelope<T>
    } catch {
      // 落到慢路径
    }
  }

  // 慢路径：命令行前面可能有进度行，从第一个 '{' 开始配平扫描
  const start = trimmed.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      // 配平完成：这一段就是完整 JSON
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1)
        try {
          return JSON.parse(candidate) as CliEnvelope<T>
        } catch {
          return undefined
        }
      }
    }
  }

  return undefined
}

/** 简单并发闸门：限制同时进行中的调用数，避免触发飞书限流。 */
export class ConcurrencyGate {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

/**
 * 全局并发闸门。
 * 实测并行加速比 3.8×，但飞书 API 有 QPS 限制，默认限 8。
 */
export const gate = new ConcurrencyGate(Number(process.env.UNWR_MAX_CONCURRENCY ?? 8))

/** 并发执行多个任务，全部完成后返回（顺序与输入一致）。 */
export function runParallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(tasks.map((t) => gate.run(t)))
}
