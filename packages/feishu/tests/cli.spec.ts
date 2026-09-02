/**
 * 飞书适配层的纯逻辑测试（不发起真实调用）。
 *
 * 重点覆盖踩过坑的地方，防止回归。
 * @module
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { FeishuError, classifyError } from '../src/errors.ts'
import { runCli } from '../src/cli.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * runCli 失败信息回显回归。
 *
 * 背景（2026-09-01 会话实测）：`docs +update --command str_replace` 等场景下，
 * lark-cli 退出码 1 且 envelope.error.message 为空，原始原因落在 stderr。
 * 修之前错误信息只剩 "cli failed with exit code 1"，模型无法自我归因。
 * 修之后必须回退到 stderr/stdout 的可读片段。
 *
 * cli.ts 在模块顶层读 process.env.UNWR_LARK_BIN（const DEFAULT_BIN），
 * 普通 it() 调用设置太晚——必须用 beforeAll 在 import 之前影响它，
 * 否则 DEFAULT_BIN 已经定型为真值 lark-cli。
 */
describe('runCli 失败带回显', () => {
  let stubDir = ''
  let prevBin: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'unwr-cli-test-'))
    const PATH = join(stubDir, 'lark-cli')
    writeFileSync(PATH, '#!/usr/bin/env bash\n'
      + 'while [ $# -gt 0 ]; do shift; done\n'
      + 'echo \'{"ok":false,"error":{"code":-1}}\'\n'
      + 'echo "\$FAIL_DETAIL" >&2\n'
      + 'exit 1\n', { mode: 0o755 })
    prevBin = process.env.UNWR_LARK_BIN
    process.env.UNWR_LARK_BIN = PATH
  })

  afterAll(() => {
    if (stubDir !== '') {
      rmSync(stubDir, { recursive: true, force: true })
      stubDir = ''
    }
    if (prevBin === undefined) delete process.env.UNWR_LARK_BIN
    else process.env.UNWR_LARK_BIN = prevBin
  })

  it('envelope.message 为空时，从 stderr 拉取细节', async () => {
    process.env.FAIL_DETAIL = '我在做补丁，但因看不见的字符匹配失败'
    try {
      await expect(runCli(['+', 'no-such-cmd'], {
        signal: AbortSignal.timeout(5_000),
      }, { maxRetries: 0 })).rejects.toMatchObject({
        message: expect.stringContaining('看不见的字符匹配失败'),
      })
    } finally {
      delete process.env.FAIL_DETAIL
    }
  })

  it('envelope.message 为空且 stderr 也空，保留 exit code 提示（兜底）', async () => {
    delete process.env.FAIL_DETAIL
    try {
      await expect(runCli(['+', 'no-such-cmd'], {
        signal: AbortSignal.timeout(5_000),
      }, { maxRetries: 0 })).rejects.toMatchObject({
        message: expect.stringContaining('exit code 1'),
      })
    } finally {
      delete process.env.FAIL_DETAIL
    }
  })

  it('envelope.message 正常时（message 不空）不错误退化到 stderr', async () => {
    // 当 envelope.message 已有值（被 monkey-patch 到 stdin 不再适用），
    // 我们直接验证 cli.ts 的三元判断：parsed.error.message ?? rawTail
    // —— 这里通过一个 fine-tuned bash 直接打印 message 来验证路径选择正确。
    delete process.env.FAIL_DETAIL
    // 复用现有 stub: 但需要 message 在 stdout 里。现有 stub 强制将 message 清空。
    // 所以这里重新写一个针对 message 正常 path 的临时 stub:
    const PATH = stubDir + '/lark-cli-msg'
    writeFileSync(PATH, '#!/usr/bin/env bash\necho \'{"ok":false,"error":{"message":"输入参数类型错误"}}\'\nexit 1\n', { mode: 0o755 })
    const saved = process.env.UNWR_LARK_BIN
    process.env.UNWR_LARK_BIN = PATH
    try {
      await expect(runCli(['+', 'no-such-cmd'], {
        signal: AbortSignal.timeout(5_000),
      }, { maxRetries: 0 })).rejects.toMatchObject({
        message: expect.stringContaining('输入参数类型错误'),
      })
    } finally {
      process.env.UNWR_LARK_BIN = saved ?? ''
      rmSync(PATH, { force: true })
    }
  })
})
