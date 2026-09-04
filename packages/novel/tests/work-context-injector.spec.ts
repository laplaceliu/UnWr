/**
 * work-context-injector 单测。
 *
 * 修复 2026-09-04 实机踩坑：主会话委托 novel_agent_outliner 时漏传
 * workToken，子代理用落盘的 lastWorkToken（主会话上次写的鸦骨账）写入
 * 错作品。修：pre-execute 钩子给所有 novel_agent 与 dsh_agent 开头的委托类
 * 工具的 prompt 头部注入 [工作上下文 workToken=xxx workName=xxx profile=xxx]，
 * 子代理 persona 提示它提取后显式传给每个 novel_ 前缀的调用。
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 独立 state 目录避免与其它 spec 串
const STATE_DIR = mkdtempSync(join(tmpdir(), 'unwr-wci-'))
process.env['UNWR_STATE_FILE'] = join(STATE_DIR, 'work-state.json')

const {
  buildWorkContext, registerWorkContextInjector, WORK_CONTEXT_MARKER,
} = await import('../src/plugins/work-context-injector.ts')
const {
  clearWorkStateForTests, rememberWork, rememberWorkToken,
} = await import('../src/domain/work-store.ts')

beforeEach(() => {
  clearWorkStateForTests()
  delete process.env['UNWR_PROFILE']
  delete process.env['DSH_PROFILE']
})
afterEach(() => clearWorkStateForTests())

describe('buildWorkContext 文本契约', () => {
  it('args 显式传入 workToken 优先 → 用 args 的 + 注 "主会话已显式传入"', () => {
    const ctx = buildWorkContext('tokPersisted', 'tokArgs', 'profileA')
    expect(ctx).toContain('workToken=tokArgs')
    expect(ctx).toContain('主会话已显式传入')
    expect(ctx).not.toContain('tokPersisted')  // 显式优先，persisted 不应出现
  })

  it('args 无 workToken + 落盘有 → 用落盘的 + 注 "继承"', () => {
    const ctx = buildWorkContext('tokPersisted', undefined, 'profileA')
    expect(ctx).toContain('workToken=tokPersisted')
    expect(ctx).toContain('从主会话的 lastWorkToken 继承')
  })

  it('args 与落盘都无 → unknown + 注 "主会话尚未锁定作品"', () => {
    const ctx = buildWorkContext(undefined, undefined, 'profileA')
    expect(ctx).toContain('workToken=unknown')
    expect(ctx).toContain('主会话尚未锁定作品')
  })

  it('profile 名出现在末尾', () => {
    const ctx = buildWorkContext('tok', undefined, 'unwr-web')
    expect(ctx).toContain('profile=unwr-web')
  })

  it('workName 来自 knownWorks；查不到时标 "(未命名/未记录)"', () => {
    rememberWorkToken('tokNamed')
    rememberWork({ baseToken: 'tokNamed', name: '洗骨录' })
    const ctx = buildWorkContext('tokNamed', undefined, 'profileA')
    expect(ctx).toContain('workName=洗骨录')

    const ctx2 = buildWorkContext('tokUnregistered', undefined, 'profileA')
    expect(ctx2).toContain('workName=(未命名/未记录)')
  })

  it('text 以 [工作上下文 开头（子代理 persona 约定认这个 marker）', () => {
    const ctx = buildWorkContext('tok', undefined, 'profileA')
    expect(ctx.startsWith(WORK_CONTEXT_MARKER)).toBe(true)
  })
})

describe('registerWorkContextInjector pre-execute 钩子', () => {
  /**
   * 构造一个最小可用的 fakeContext：
   *   - ctx.on(event, fn) 记录 listener，返回 unsubscribe
   *   - 我们手动取出 listener，模拟 DSH 触发 waterfall
   */
  function makeFakeContext(): {
    ctx: { on: (event: string, fn: (...args: unknown[]) => Promise<unknown>) => () => void }
    trigger: (exec: Record<string, unknown>) => Promise<unknown>
  } {
    const listeners: Array<{ event: string; fn: (...args: unknown[]) => Promise<unknown> }> = []
    const ctx = {
      on(event: string, fn: (...args: unknown[]) => Promise<unknown>) {
        listeners.push({ event, fn })
        return () => {
          const i = listeners.findIndex((l) => l.event === event && l.fn === fn)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    }
    const trigger = async (exec: Record<string, unknown>) => {
      const l = listeners.find((x) => x.event === 'tools/pre-execute')
      if (l === undefined) throw new Error('no listener')
      // waterfall 形如 (exec, next) => next()；listener 通过修改 exec
      // （in-place）来改写 arguments.prompt。trigger 后 exec 对象已变。
      let nextCalled = false
      await l.fn(exec, async () => {
        nextCalled = true
        return undefined
      })
      return { result: exec, nextCalled }
    }
    return { ctx: ctx as never, trigger }
  }

  it('novel_agent_* 委托工具 → prompt 头部注入 [工作上下文]，prompt 包含原内容', async () => {
    process.env['UNWR_PROFILE'] = 'unwr-agent'
    rememberWorkToken('tokInherit')
    rememberWork({ baseToken: 'tokInherit', name: '洗骨录' })
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const original = '规划第 4-10 章大纲，每章 200 字要点。'
    const r = await trigger({
      toolName: 'novel_agent_outliner',
      arguments: { prompt: original },
    })
    expect(r.nextCalled).toBe(true)
    const exec = (r.result as { arguments: { prompt: string } })
    expect(exec.arguments.prompt).toContain('[工作上下文')
    expect(exec.arguments.prompt).toContain('workToken=tokInherit')
    expect(exec.arguments.prompt).toContain('workName=洗骨录')
    expect(exec.arguments.prompt).toContain('profile=unwr-agent')
    expect(exec.arguments.prompt).toContain(original)  // 原 prompt 完整保留
    // 显眼的分隔让子代理知道哪段是 context、哪段是原任务
    expect(exec.arguments.prompt).toContain('===以下是主会话的原始任务===')
    expect(exec.arguments.prompt).toContain('===end===')
  })

  it('args 已带 workToken → 注入时优先用 args 的 token（不取落盘）', async () => {
    process.env['UNWR_PROFILE'] = 'unwr-agent'
    rememberWorkToken('tokPersisted')
    rememberWork({ baseToken: 'tokPersisted', name: '洗骨录' })
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const r = await trigger({
      toolName: 'novel_agent_outliner',
      arguments: { prompt: '...', workToken: 'tokArgsExplicit' },
    })
    const exec = r.result as { arguments: { prompt: string } }
    expect(exec.arguments.prompt).toContain('workToken=tokArgsExplicit')
    expect(exec.arguments.prompt).not.toContain('workToken=tokPersisted')
  })

  it('dsh_agent_*（DSH 自带子代理）也走注入', async () => {
    rememberWorkToken('tokDsh')
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const r = await trigger({
      toolName: 'dsh_agent_helper',
      arguments: { prompt: 'subagent task' },
    })
    const exec = r.result as { arguments: { prompt: string } }
    expect(exec.arguments.prompt).toContain('[工作上下文')
    expect(exec.arguments.prompt).toContain('workToken=tokDsh')
  })

  it('非委托工具（novel_* 直调）→ 不修改 arguments', async () => {
    rememberWorkToken('tok')
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const args = { workToken: 'tok', chapterNo: 25, outline: '...' }
    const r = await trigger({
      toolName: 'novel_manage_outline',
      arguments: { ...args },
    })
    const exec = r.result as { arguments: Record<string, unknown> }
    // 原 args 没被注入（只有 prompt 注入，outline 不会被改）
    expect(exec.arguments.outline).toBe('...')
    expect(exec.arguments.chapterNo).toBe(25)
  })

  it('prompt 为空字符串 → 不注入（避免空头部污染）', async () => {
    rememberWorkToken('tok')
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const r = await trigger({
      toolName: 'novel_agent_outliner',
      arguments: { prompt: '' },
    })
    const exec = r.result as { arguments: { prompt: string } }
    expect(exec.arguments.prompt).toBe('')
  })

  it('prompt 缺失 / arguments 不是 object → 不修改', async () => {
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const r = await trigger({ toolName: 'novel_agent_outliner' })
    // args undefined 不抛错，next() 被调
    expect(r.nextCalled).toBe(true)
  })

  it('ctx.on 不可用时静默降级（不抛错，不影响其它插件）', () => {
    const brokenCtx = {} as { on: (...args: unknown[]) => unknown }
    expect(() => registerWorkContextInjector(brokenCtx)).not.toThrow()
  })

  it('主会话没记忆任何作品 → unknown 占位 + "主会话尚未锁定作品" 提示（反向警告）', async () => {
    process.env['UNWR_PROFILE'] = 'unwr-agent'
    // 不调 rememberWorkToken，模拟冷启动
    const { ctx, trigger } = makeFakeContext()
    registerWorkContextInjector(ctx)
    const r = await trigger({
      toolName: 'novel_agent_outliner',
      arguments: { prompt: '...' },
    })
    const exec = r.result as { arguments: { prompt: string } }
    expect(exec.arguments.prompt).toContain('workToken=unknown')
    expect(exec.arguments.prompt).toContain('主会话尚未锁定作品')
  })
})
