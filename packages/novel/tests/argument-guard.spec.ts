/**
 * argument-guard 测试
 * ====================
 *
 * 实机 2026-09-04：模型生成 tool_call 时 JSON 撞 token 上限被截断，DSH 的
 * `parseArguments` 在 catch 里返回原始字符串而非抛错，下游 `validateArgs`
 * 只报 `arguments must be an object`，模型完全看不到 JSON 解析失败的真因，
 * 反复重试同一份巨大 payload 5+ 次仍堵在同一条错误。
 *
 * 本测试验证 `registerArgumentGuard`：
 *   1. plain object arguments → 放行
 *   2. string arguments（JSON 解析失败退回的）→ 抛带长度+片段+建议的友好错误
 *   3. null / undefined → 抛明确诊断
 *   4. 数组 → 抛明确诊断（UnWr 工具要 {...}，不要 [...]）
 *   5. 错误信息包含「JSON 解析失败」「拆小批次」等关键提示
 *   6. 长字符串使用 head/tail 片段而非全量 dump
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { ARG_GUARD_ERROR_NAME, registerArgumentGuard } from '../src/plugins/argument-guard.ts'

/** 构造最小 fake ctx，捕获 tools/pre-execute 监听器。 */
function makeFakeCtx(): {
  ctx: unknown
  invoke: (exec: { arguments: unknown }) => Promise<unknown>
  listenerCount: () => number
} {
  const listeners: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
  const ctx = {
    on(event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
      if (event === 'tools/pre-execute') listeners.push(listener)
    },
  }
  const invoke = async (exec: { arguments: unknown }) => {
    if (listeners.length === 0) throw new Error('no pre-execute listener registered')
    const fn = listeners[0]!
    return fn(exec, async () => 'NEXT_RAN')
  }
  return { ctx, invoke, listenerCount: () => listeners.length }
}

describe('argument-guard', () => {
  it('registerArgumentGuard 注册一个 tools/pre-execute 监听器', () => {
    const { ctx, listenerCount } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    expect(listenerCount()).toBe(1)
  })

  it('plain object arguments 放行：调用 next()', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    const result = await invoke({ arguments: { chapterNo: 1, scene: 'foo' } })
    expect(result).toBe('NEXT_RAN')
  })

  it('空对象 arguments 放行', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    const result = await invoke({ arguments: {} })
    expect(result).toBe('NEXT_RAN')
  })

  it('string arguments 抛 UnWrArgumentGuardError：含长度+片段+建议', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    // 模拟 DSH parseArguments 返回的原始 JSON 字符串（截断到一半）
    const raw = '{"chapterNo": 24, "scene": "开元四十一年 三月二十 夜,万年县小院。", "events": ["裴三错去万年县小院找万俟休对质——万俟休左手执黑右手执白自己跟自己下残局,棋落一'
    await expect(invoke({ arguments: raw })).rejects.toMatchObject({
      name: ARG_GUARD_ERROR_NAME,
      message: expect.stringContaining('JSON 解析失败'),
    })
    await expect(invoke({ arguments: raw })).rejects.toThrow(/长度 1\d+ 字符/)
    // 错误信息必须包含修复建议（让模型看到「拆小批次」字样才可能自我纠正）
    await expect(invoke({ arguments: raw })).rejects.toThrow(/拆成多次/)
    await expect(invoke({ arguments: raw })).rejects.toThrow(/events/)
  })

  it('string arguments 超过 480 字符用 head/tail 片段而非全量 dump', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    // 构造 1200 字符的 raw arguments（前 120 / 后 120 + 中间省略计数）
    const long = '{"a":"' + 'x'.repeat(1100) + '","b":'
    let err: unknown
    try {
      await invoke({ arguments: long })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    // 必须出现「省略 N 字符」提示
    expect(msg).toMatch(/省略 \d+ 字符/)
    // 不应包含完整 1100 个 x（避免 prompt 撑爆）
    expect(msg).not.toContain('x'.repeat(500))
  })

  it('null arguments 抛带诊断的错误', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    await expect(invoke({ arguments: null })).rejects.toMatchObject({
      name: ARG_GUARD_ERROR_NAME,
      message: expect.stringContaining('null'),
    })
    await expect(invoke({ arguments: null })).rejects.toThrow(/补齐必填字段/)
  })

  it('undefined arguments 抛带诊断的错误', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    await expect(invoke({ arguments: undefined })).rejects.toMatchObject({
      name: ARG_GUARD_ERROR_NAME,
      message: expect.stringContaining('undefined'),
    })
  })

  it('数组 arguments 抛「不接受数组」诊断', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    await expect(invoke({ arguments: ['a', 'b'] })).rejects.toMatchObject({
      name: ARG_GUARD_ERROR_NAME,
      message: expect.stringContaining('数组'),
    })
    await expect(invoke({ arguments: ['a', 'b'] })).rejects.toThrow(/JSON 对象/)
  })

  it('数字 arguments 抛「非法类型」诊断', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    await expect(invoke({ arguments: 42 })).rejects.toMatchObject({
      name: ARG_GUARD_ERROR_NAME,
      message: expect.stringContaining('number'),
    })
  })

  it('错误文案指明可能原因 1-3 条，便于模型自我诊断', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    const raw = '{"chapterNo": 1, "scene": "x", "events": ['
    await expect(invoke({ arguments: raw })).rejects.toThrow(/token 上限/)
    await expect(invoke({ arguments: raw })).rejects.toThrow(/未转义/)
    await expect(invoke({ arguments: raw })).rejects.toThrow(/拆小批次|拆成多次/)
  })

  it('连续调用 5 次模拟模型死循环：每次都拿到清晰错误（不重复/不丢失）', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    const raw = '{"chapterNo": 1, "events": ["foo"'
    const errors: string[] = []
    for (let i = 0; i < 5; i++) {
      try {
        await invoke({ arguments: raw })
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
    expect(errors).toHaveLength(5)
    // 5 次错误信息完全一致（不变量）
    expect(new Set(errors).size).toBe(1)
    expect(errors[0]).toContain('JSON 解析失败')
  })

  it('plain object 包含数组字段也放行（数组作为字段值合法）', async () => {
    const { ctx, invoke } = makeFakeCtx()
    registerArgumentGuard(ctx as never)
    const args = { chapterNo: 24, events: ['a', 'b', 'c'] }
    await expect(invoke({ arguments: args })).resolves.toBe('NEXT_RAN')
  })

  it('监听器不会替换 cordis 自身的 on（只增不冲）', () => {
    const onSpy = vi.fn()
    const ctx = {
      on: onSpy,
    }
    registerArgumentGuard(ctx as never)
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0]?.[0]).toBe('tools/pre-execute')
  })
})