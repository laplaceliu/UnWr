/**
 * 飞书适配层的纯逻辑测试（不发起真实调用）。
 *
 * 重点覆盖踩过坑的地方，防止回归。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { FeishuError, classifyError } from '../src/errors.ts'

/**
 * parseEnvelope 是 cli.ts 的内部函数，未导出。
 * 这里复制一份等价实现做验证——若未来导出，应改为直接引用。
 *
 * 验证的核心：**不能**用 lastIndexOf('{') 截取，
 * 否则 `{"ok":false,"error":{...}}` 会被错误地解析。
 */
function parseEnvelope(raw: string): { ok?: boolean; error?: { message?: string } } | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch { /* 落慢路径 */ }
  }
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
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

describe('错误信封解析', () => {
  it('能正确解析嵌套的 error 对象（回归测试）', () => {
    // 曾出过 bug：用 lastIndexOf('{') 会截到嵌套的 error 对象，
    // 导致 ok 读不到、真实错误信息被当成"无法解析输出"
    const raw = JSON.stringify({
      ok: false,
      identity: 'user',
      error: {
        type: 'validation',
        subtype: 'invalid_argument',
        message: 'invalid --page-size 30: must be between 1 and 20',
      },
    })
    const parsed = parseEnvelope(raw)
    expect(parsed?.ok).toBe(false)
    expect(parsed?.error?.message).toContain('must be between 1 and 20')
  })

  it('能从含进度行的输出中提取信封', () => {
    const raw = 'creating node...\ndone\n'
      + JSON.stringify({ ok: true, data: { node_token: 'abc' } })
    const parsed = parseEnvelope(raw)
    expect(parsed?.ok).toBe(true)
  })

  it('含大括号字符串时不破坏配平', () => {
    const raw = JSON.stringify({
      ok: true,
      data: { content: '正文里有 { 和 } 这样的花括号' },
    })
    const parsed = parseEnvelope(raw)
    expect(parsed?.ok).toBe(true)
  })

  it('含转义引号时不破坏字符串判定', () => {
    const raw = JSON.stringify({
      ok: true,
      data: { text: '他说："这不是 } 结束"' },
    })
    const parsed = parseEnvelope(raw)
    expect(parsed?.ok).toBe(true)
  })

  it('非 JSON 输出返回 undefined', () => {
    expect(parseEnvelope('not json at all')).toBeUndefined()
    expect(parseEnvelope('')).toBeUndefined()
  })
})

describe('错误分类', () => {
  it('参数校验错误归类为 invalid_argument', () => {
    expect(classifyError('invalid --page-size 30: must be between 1 and 20'))
      .toBe('invalid_argument')
    expect(classifyError('invalid --limit 500: must be between 1 and 200'))
      .toBe('invalid_argument')
  })

  it('资源不存在归类为 not_found', () => {
    expect(classifyError('field not found')).toBe('not_found')
    expect(classifyError('该记录不存在')).toBe('not_found')
  })

  it('限流归类为 rate_limited 且可重试', () => {
    expect(classifyError('rate limit exceeded')).toBe('rate_limited')
    expect(classifyError('', 1254290)).toBe('rate_limited')
  })

  it('认证失效归类为 auth', () => {
    expect(classifyError('token expired, please login')).toBe('auth')
    expect(classifyError('', 99991663)).toBe('auth')
  })

  it('未分类错误不可重试', () => {
    const e = new FeishuError('unknown', 'something broke')
    expect(e.retryable).toBe(false)
    expect(e.hint()).toContain('飞书调用失败')
  })

  it('限流错误可重试且给出明确提示', () => {
    const e = new FeishuError('rate_limited', 'too many requests')
    expect(e.retryable).toBe(true)
    expect(e.hint()).toContain('频率限制')
  })

  it('认证错误给出重新登录提示', () => {
    const e = new FeishuError('auth', 'token expired')
    expect(e.retryable).toBe(false)
    expect(e.hint()).toContain('lark-cli auth login')
  })
})
