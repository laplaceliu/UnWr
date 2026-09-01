/**
 * 飞书错误类型。
 *
 * 目标：把 lark-cli 五花八门的失败模式统一为可判别的 typed error，
 * 让上层能用 `instanceof` 做精确处理（尤其是认证过期需要提示重新登录）。
 * @module @unwr/feishu/errors
 */

/** 飞书错误的语义分类。 */
export type FeishuErrorKind =
  /** 认证失效或缺失，需要 `lark-cli auth login` */
  | 'auth'
  /** 找不到资源（table / record / doc / node） */
  | 'not_found'
  /** 参数不合法（字段名错、JSON 形状错、路径不安全） */
  | 'invalid_argument'
  /** 触发 API 频率限制，可重试 */
  | 'rate_limited'
  /** 网络或进程超时，可重试 */
  | 'timeout'
  /** 权限不足 */
  | 'permission'
  /** 其他未分类错误 */
  | 'unknown'

/** CLI 成功返回但 ok=false 时的原始载荷。 */
export interface CliErrorPayload {
  type?: string
  subtype?: string
  code?: number
  message?: string
  hint?: string
  log_id?: string
}

const AUTH_PATTERNS = [
  /unauthor/i,
  /not authenticated/i,
  /token.*(expire|invalid)/i,
  /please.*login/i,
  /auth/i,
]

const NOT_FOUND_PATTERNS = [
  /not found/i,
  /不存在/,
  /no such/i,
  /cannot find/i,
]

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many request/i,
  /频率/,
  /1254290/,
]

const PERMISSION_PATTERNS = [
  /permission/i,
  /forbidden/i,
  /denied/i,
  /权限/,
]

/** 根据错误消息与 code 推断语义分类。 */
export function classifyError(message: string, code?: number): FeishuErrorKind {
  if (code !== undefined) {
    if (code === 99991663 || code === 99991661) return 'auth'
    if (code === 1254290 || code === 1254306) return 'rate_limited'
    if (code === 1254045 || code === 230002) return 'not_found'
    if (code === 99991668 || code === 91402) return 'permission'
  }
  for (const p of AUTH_PATTERNS) if (p.test(message)) return 'auth'
  for (const p of RATE_LIMIT_PATTERNS) if (p.test(message)) return 'rate_limited'
  for (const p of NOT_FOUND_PATTERNS) if (p.test(message)) return 'not_found'
  for (const p of PERMISSION_PATTERNS) if (p.test(message)) return 'permission'
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout'
  return 'unknown'
}

/**
 * 飞书调用失败的统一错误类型。
 *
 * 携带 `kind` 供上层做语义分支，`cliCommand` 保留现场便于排查。
 */
export class FeishuError extends Error {
  readonly kind: FeishuErrorKind
  readonly code?: number
  readonly cliCommand?: string
  readonly logId?: string

  constructor(
    kind: FeishuErrorKind,
    message: string,
    options: { code?: number; cliCommand?: string; logId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'FeishuError'
    this.kind = kind
    this.code = options.code
    this.cliCommand = options.cliCommand
    this.logId = options.logId
  }

  /** 是否值得重试（限流与超时值得，参数错误不值得）。 */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout'
  }

  /** 面向模型/用户的可操作提示。 */
  hint(): string {
    switch (this.kind) {
      case 'auth':
        return '飞书认证已失效，请运行 `lark-cli auth login` 重新登录后重试。'
      case 'not_found':
        return '目标资源不存在，请检查 token 或名称是否正确。'
      case 'invalid_argument':
        return '参数不合法，请检查字段名与 JSON 结构。'
      case 'rate_limited':
        return '触发飞书 API 频率限制，稍后自动重试。'
      case 'timeout':
        return '调用超时，稍后自动重试。'
      case 'permission':
        return '权限不足，请检查该资源的访问权限。'
      default:
        return '飞书调用失败，请查看原始错误信息。'
    }
  }
}

/** 判断 unknown 是否为可重试的飞书错误。 */
export function isRetryable(e: unknown): boolean {
  return e instanceof FeishuError && e.retryable
}
