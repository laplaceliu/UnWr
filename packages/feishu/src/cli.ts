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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliErrorPayload } from './errors.ts'
import { FeishuError, classifyError, hintFor } from './errors.ts'

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

/**
 * 默认的 lark-cli 可执行文件路径。
 * 每调用读一次 env，方便测试用 UNWR_LARK_BIN 注入 stub（顶层常量在
 * import 时固化，会跑过早配置的 setupStub）。
 */
/**
 * 插件配置注入的 lark-cli 路径（configureLark 设置）。
 * 优先级高于 env：profile patch 是部署级显式声明，比机器级 env 更具体。
 */
let configuredBin: string | undefined

/**
 * 注入 lark-cli 路径（插件配置 `larkBin` 的落点）。
 *
 * 为什么不只用 UNWR_LARK_BIN 环境变量：DSH 以沙箱方式拉起插件进程时
 * （尤其 Windows 服务化/托运行），用户级环境变量**不一定传播**——
 * 实机 2026-09-03。写进 profile patch 的 config 是随部署走、可 dump-config
 * 检查的显式声明，与进程环境完全解耦。传空串/空白 = 清除配置。
 */
export function configureLark(options: { bin?: string }): void {
  const bin = options.bin
  configuredBin = typeof bin === 'string' && bin.trim() !== '' ? bin.trim() : undefined
}

/**
 * Windows 常见安装位置探测（win32 only），末位追加进程 PATH 扫描。
 *
 * 覆盖顺序（先专用后通用）：
 *   - npm -g    → %APPDATA%\npm
 *   - pnpm -g   → %LOCALAPPDATA%\pnpm
 *   - yarn -g   → %LOCALAPPDATA%\Yarn\bin
 *   - winget    → %LOCALAPPDATA%\Microsoft\WindowsApps
 *   - scoop     → %SCOOP%\shims / %USERPROFILE%\scoop\shims / %ProgramFiles%\scoop\shims
 *   - chocolatey→ %ChocolateyInstall%\bin（缺省 C:\ProgramData\chocolatey\bin）
 *   - 进程 PATH 逐目录扫描（msys2 / git-bash / 任何自定义目录——但只在它
 *     已进入 DSH 进程 PATH 时有效；shell rc 级 PATH 不在此列，那种情况
 *     只能用 larkBin 绝对路径）
 *
 * 已知边界：PATH 各段可能带引号（含空格目录），扫描前剥引号。
 * 探测纯 existsSync（微秒级，相对单次调用 640ms 网络开销可忽略），
 * **不缓存**：用户装完 lark-cli 无需重启进程即可生效。
 */
export function discoverWindowsLarkCli(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const dirs: string[] = []
  if (appData !== undefined && appData !== '') dirs.push(join(appData, 'npm'))
  if (localAppData !== undefined && localAppData !== '') {
    dirs.push(
      join(localAppData, 'pnpm'),
      join(localAppData, 'Yarn', 'bin'),
      join(localAppData, 'Microsoft', 'WindowsApps'),
    )
  }
  if (process.env.SCOOP !== undefined && process.env.SCOOP !== '') dirs.push(join(process.env.SCOOP, 'shims'))
  const userProfile = process.env.USERPROFILE
  if (userProfile !== undefined && userProfile !== '') dirs.push(join(userProfile, 'scoop', 'shims'))
  if (process.env.ProgramFiles !== undefined && process.env.ProgramFiles !== '') {
    dirs.push(join(process.env.ProgramFiles, 'scoop', 'shims'))
  }
  dirs.push(
    process.env.ChocolateyInstall !== undefined && process.env.ChocolateyInstall !== ''
      ? join(process.env.ChocolateyInstall, 'bin')
      : 'C:\\ProgramData\\chocolatey\\bin',
  )
  for (const dir of dirs) {
    const found = findLarkCliIn(dir)
    if (found !== undefined) return found
  }
  // 末位：进程 PATH 扫描（Windows PATH 用 ; 分隔，段可能带引号）
  for (const raw of pathEnvValue().split(';')) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (dir === '') continue
    const found = findLarkCliIn(dir)
    if (found !== undefined) return found
  }
  return undefined
}

/** 跨平台读 PATH 值（Windows 上变量名可能是 Path 或 PATH，两种都查）。 */
function pathEnvValue(): string {
  return process.env.PATH ?? process.env.Path ?? ''
}

/** 在单个目录里找 lark-cli 的可执行形态。 */
function findLarkCliIn(dir: string): string | undefined {
  for (const name of ['lark-cli.cmd', 'lark-cli.exe', 'lark-cli.bat']) {
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * Windows 下把**裸名**命令解析为绝对路径（larkBin / UNWR_LARK_BIN 共用）。
 *
 * - 绝对/相对路径（含分隔符）→ 原样（用户显式指定，尊重之）
 * - 已带扩展名 → 原样（.cmd/.exe 的分流是 buildSpawn 的职责）
 * - 裸名 → 在探测白名单目录 + 进程 PATH 里找 `<name>.cmd/.exe/.bat`；
 *   找不到返回原名，由 cmd 包装层报可读错误
 */
export function resolveWindowsBareBin(bin: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return bin
  if (/[\\/]/.test(bin)) return bin
  if (/\.[A-Za-z]+$/.test(bin)) return bin

  const candidates: string[] = []
  if (process.env.APPDATA !== undefined && process.env.APPDATA !== '') candidates.push(join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA !== undefined && process.env.LOCALAPPDATA !== '') {
    candidates.push(join(process.env.LOCALAPPDATA, 'pnpm'), join(process.env.LOCALAPPDATA, 'Yarn', 'bin'))
  }
  if (process.env.SCOOP !== undefined && process.env.SCOOP !== '') candidates.push(join(process.env.SCOOP, 'shims'))
  const userProfile = process.env.USERPROFILE
  if (userProfile !== undefined && userProfile !== '') candidates.push(join(userProfile, 'scoop', 'shims'))
  candidates.push(...pathEnvValue().split(';').map((s) => s.trim().replace(/^"|"$/g, '')).filter((s) => s !== ''))

  for (const dir of candidates) {
    for (const ext of ['.cmd', '.exe', '.bat']) {
      const full = join(dir, bin + ext)
      if (existsSync(full)) return full
    }
  }
  return bin
}

/** lark-cli 解析来源（verbose 日志与排障用）。 */
export type LarkBinSource = 'config' | 'env' | 'discovered' | 'path'

export interface LarkBinResolution {
  bin: string
  source: LarkBinSource
}

/**
 * 解析 lark-cli 可执行文件，四级优先：
 *   1. 插件配置 `larkBin`（configureLark，profile patch 显式声明）
 *   2. 环境变量 UNWR_LARK_BIN（兼容既有用法）
 *   3. Windows 常见安装位置自动探测（npm/pnpm/yarn/scoop/choco/winget + PATH）
 *   4. 裸名 `lark-cli`（Windows 经 cmd /c 走 PATH；POSIX 直接 PATH）
 * 1/2 的裸名在 Windows 上会先经 resolveWindowsBareBin 解析为绝对路径。
 * 每次调用现算（env/文件系统都可能变），不做模块级缓存。
 */
export function resolveLarkBinDetailed(platform: NodeJS.Platform = process.platform): LarkBinResolution {
  if (configuredBin !== undefined) {
    return { bin: resolveWindowsBareBin(configuredBin, platform), source: 'config' }
  }
  const env = process.env.UNWR_LARK_BIN
  if (env !== undefined && env !== '') {
    return { bin: resolveWindowsBareBin(env, platform), source: 'env' }
  }
  const found = discoverWindowsLarkCli(platform)
  if (found !== undefined) return { bin: found, source: 'discovered' }
  return { bin: 'lark-cli', source: 'path' }
}

export function resolveLarkBin(platform: NodeJS.Platform = process.platform): string {
  return resolveLarkBinDetailed(platform).bin
}

function defaultBin(): string {
  return resolveLarkBin()
}

/**
 * Windows 命令行参数引号规则（MS C runtime / CommandLineToArgvW 语义）。
 *
 * 为什么不用 shell:true 让 Node 自己拼：Node 对 shell:true 的参数**不做**
 * quoting（只外层包一层），含空格的值（章节标题、关键词）会碎成多个参数。
 * cross-spawn 同款算法，逐字符处理三种边角：
 *   - 内嵌 `"` → 按其前面的连续 `\` 数决定（`\` 翻倍再加 `\"`）
 *   - 结尾连续 `\` → 翻倍（否则会吞掉闭合引号）
 *   - 无空格无引号的参数 → 原样（避免无谓引号改变 argv 语义）
 */
export function windowsQuote(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      out += ch
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes + 1) + '"'
      backslashes = 0
    } else {
      backslashes = 0
      out += ch
    }
  }
  if (backslashes > 0) out += '\\'.repeat(backslashes)
  return out + '"'
}

/** spawn 执行计划。 */
export interface SpawnPlan {
  file: string
  args: string[]
  /** true = file 是 cmd.exe 包装（kill 需 taskkill /T 杀整棵进程树） */
  viaCmd: boolean
}

/**
 * 依据平台与命令形态决定 spawn 方式。
 *
 * 背景（Windows 实测故障）：npm 全局安装的 lark-cli 在 PATH 里是 `.cmd`
 * shim（@larksuite/cli bin → scripts/run.js 的 npm 包装）。Node 出于
 * CVE-2024-27980 安全修复，`shell:false` spawn `.cmd/.bat` 直接抛 EINVAL
 * （旧版本则是 ENOENT）——非 Windows 平台不受影响，Linux 行为零变化。
 *
 * 三种形态：
 *   1. 非 Windows                     → 直跑（Node 内建 quoting，不经 shell，
 *                                       正文引号/反引号安全，与历史行为一致）
 *   2. Windows + 显式 `.exe`/`.com`   → 直跑（CreateProcess 原生支持）
 *   3. Windows + 裸名 / `.cmd`/`.bat` → `cmd /d /s /c "<line>"` 包装 +
 *                                       `windowsVerbatimArguments`（外层引号
 *                                       由自己控制，参数按 windowsQuote 规则）
 *
 * platform 参数仅测试注入用。
 */
export function buildSpawn(
  bin: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  if (platform !== 'win32') {
    return { file: bin, args: [...argv], viaCmd: false }
  }
  if (/\.(exe|com)$/i.test(bin)) {
    return { file: bin, args: [...argv], viaCmd: false }
  }
  const line = [bin, ...argv].map(windowsQuote).join(' ')
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    viaCmd: true,
  }
}

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
  const command = `${defaultBin()} ${args.join(' ')}`

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
  const plan = buildSpawn(defaultBin(), argv)

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string
    stderr: string
    exitCode: number | null
  }>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      cwd,
      // 非 Windows：不经 shell（规避转义问题，见 buildSpawn 注释）；
      // Windows cmd 包装：外层引号已由 buildSpawn 自行控制，禁止 Node 再加工
      // （verbatim=true 是 cross-spawn 同款语义——设 false 会被 Node 二次转义）
      ...(plan.viaCmd ? { windowsVerbatimArguments: true, windowsHide: true } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    /** cmd /c 包装下 kill 只杀 cmd 不杀孙进程（无进程组语义），必须 taskkill 连树杀 */
    const killChild = (): void => {
      if (plan.viaCmd && child.pid !== undefined && process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    }

    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killChild()
      reject(new FeishuError('timeout', `cli timed out after ${timeoutMs}ms`, { cliCommand: command }))
    }, timeoutMs)

    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killChild()
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
    // envelope 里若 message 为空（实测出现在 lark-cli 文档补丁、字段冲突等场景，
    // 会把原始 stderr 写到 stderr 而不是 error.message），则回退到 raw stderr。
    // 跳过纯 envelope JSON 自身——那不是给人类看的可读信息。
    const envelopeJson = /^\s*\{[\s\S]*\}\s*$/.test(stdout) ? '' : stdout.trim()
    const rawTail = stderr.trim() !== '' ? stderr.trim() : envelopeJson
    const message = parsed.error?.message
      ?? (rawTail !== '' ? rawTail : `cli failed with exit code ${String(exitCode)}`)
    const kind = classifyError(message, parsed.error?.code)
    throw new FeishuError(
      kind,
      // 模型/用户只能看到 message（hint 若不拼进来就永远不可见）。
      // 原文仍是前缀，上层按子串断言的测试不受影响。
      `${message}（${hintFor(kind)}）`,
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
