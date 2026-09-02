/**
 * 错误分类与提示的单测（纯函数，不触网）。
 *
 * 背景（2026-09-01 会话实测）：token 抄错时 bitable 返回大写 "NOTEXIST"，
 * 当时既不匹配 not_found 模式、91402 又被误归 permission，导致
 * 「Error: NOTEXIST」完全不可诊断。本文件锁定修复后的语义。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { FeishuError, classifyError, hintFor } from '../src/errors.ts'

describe('classifyError', () => {
  it('NOTEXIST 措辞 → not_found', () => {
    expect(classifyError('NOTEXIST')).toBe('not_found')
    expect(classifyError('app not exist')).toBe('not_found')
  })

  it('91402（Base 不存在）归 not_found 而非 permission', () => {
    expect(classifyError('x', 91402)).toBe('not_found')
  })

  it('1254045 / 230002 → not_found（回归保护）', () => {
    expect(classifyError('x', 1254045)).toBe('not_found')
    expect(classifyError('x', 230002)).toBe('not_found')
  })

  it('99991668 仍是 permission', () => {
    expect(classifyError('x', 99991668)).toBe('permission')
  })

  it('参数校验优先于 not_found（含 between 的报错不是资源缺失）', () => {
    expect(classifyError('invalid --limit 500: must be between 1 and 200')).toBe('invalid_argument')
  })

  it('限流 / 认证 / 权限的中文与英文措辞（回归保护）', () => {
    expect(classifyError('rate limit exceeded')).toBe('rate_limited')
    expect(classifyError('请求过快，触发频率限制')).toBe('rate_limited')
    expect(classifyError('please login first')).toBe('auth')
    expect(classifyError('没有访问权限')).toBe('permission')
  })
})

describe('hintFor', () => {
  it('not_found 提示给出可操作指引（list 核对 token）', () => {
    const hint = hintFor('not_found')
    expect(hint).toContain('novel_manage_work')
    expect(hint).toContain('base_token')
  })

  it('FeishuError 构造后 message 前缀保持原文（供子串断言）', () => {
    const e = new FeishuError('not_found', 'NOTEXIST', { code: 91402 })
    expect(e.message).toBe('NOTEXIST')
    expect(e.kind).toBe('not_found')
    expect(e.retryable).toBe(false)
  })

  it('限流与超时可重试，参数错误不可重试', () => {
    expect(new FeishuError('rate_limited', 'x').retryable).toBe(true)
    expect(new FeishuError('timeout', 'x').retryable).toBe(true)
    expect(new FeishuError('invalid_argument', 'x').retryable).toBe(false)
  })
})
