/**
 * resolveWorkToken / consumeLastResolveInfo / resolveInfoToWarning 测试。
 *
 * 2026-09-04 实机踩坑：智能体漏传 workToken 把鸦骨账的大纲写到了当前作品。
 * 修：resolveWorkToken 在回退路径上记录 ResolveInfo，工具层在 execute 末尾
 * 取出 → warnings 注入「用了默认作品 X」提示，让模型能在「写错作品」之前
 * 看到警示主动核对。
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = mkdtempSync(join(tmpdir(), 'unwr-defaults-'))
process.env['UNWR_STATE_FILE'] = join(STATE_DIR, 'work-state.json')

const {
  clearWorkStateForTests, getLastWorkToken, rememberWork, rememberWorkToken,
} = await import('../src/domain/work-store.ts')
const {
  consumeLastResolveInfo, isWorkNotFound, noWorkTokenHint, resolveInfoToWarning,
  resolveWorkToken, withWorkToken, workNotFoundRecoveryMessage,
} = await import('../src/tools/defaults.ts')

beforeEach(() => {
  clearWorkStateForTests()
  // 清空所有可能的环境变量
  delete process.env['UNWR_PROFILE']
  delete process.env['DSH_PROFILE']
})

afterEach(() => {
  clearWorkStateForTests()
})

describe('resolveWorkToken 解析路径记录', () => {
  it('显式传入 → source=explicit，warning 永不注入（resolveInfoToWarning 返回空串）', () => {
    const result = resolveWorkToken({ workToken: 'tokExplicit' })
    expect(result).toBe('tokExplicit')
    const info = consumeLastResolveInfo()
    expect(info?.source).toBe('explicit')
    expect(resolveInfoToWarning(info!)).toBe('')
  })

  it('会话内重复调用无 workToken → source=in-memory，warning 提示沿用会话默认', () => {
    resolveWorkToken({ workToken: 'tokA' })  // 显式
    consumeLastResolveInfo()  // 清掉第一次的 explicit

    const r2 = resolveWorkToken({})  // 无参，应走 in-memory
    expect(r2).toBe('tokA')
    const info = consumeLastResolveInfo()
    expect(info?.source).toBe('in-memory')
    const w = resolveInfoToWarning(info!)
    expect(w).toContain('未传 workToken')
    expect(w).toContain('沿用了本会话的默认作品')
    expect(w).toContain('tokA')
  })

  it('冷启动（无内存默认 + 落盘有 token）→ source=persisted，warning 带 profile', async () => {
    // 关键：defaults.ts 的 lastWorkToken 是模块级变量，单进程内不会清。
    // 模拟"冷启动"必须 vi.resetModules() 重新 import 模块。
    process.env['UNWR_PROFILE'] = 'unwr-agent'
    rememberWorkToken('tokPersisted')

    // 重置 modules 让 defaults.ts 的 lastWorkToken 重新初始化为空
    vi.resetModules()
    const { resolveWorkToken: resolveFresh, consumeLastResolveInfo: consumeFresh,
      resolveInfoToWarning: warningFresh } = await import('../src/tools/defaults.ts')
    const info = consumeFresh()
    expect(info).toBeUndefined()
    const r = resolveFresh({})
    expect(r).toBe('tokPersisted')
    const freshInfo = consumeFresh()
    expect(freshInfo?.source).toBe('persisted')
    expect(freshInfo?.profile).toBe('unwr-agent')
    const w = warningFresh(freshInfo!)
    expect(w).toContain('落盘')
    expect(w).toContain('unwr-agent')
    expect(w).toContain('tokPersi')  // slice(0, 8)
  })

  it('consumeLastResolveInfo 是「取后即清」——下次 resolve 看到的是上一次的陈旧信息', () => {
    resolveWorkToken({ workToken: 'tokA' })
    const first = consumeLastResolveInfo()
    expect(first?.token).toBe('tokA')
    // 再次消费应返回 undefined
    const second = consumeLastResolveInfo()
    expect(second).toBeUndefined()
  })
})

describe('resolveInfoToWarning 文案契约', () => {
  it('explicit → 空串（不噪音）', () => {
    expect(resolveInfoToWarning({ token: 'x', source: 'explicit' })).toBe('')
  })

  it('in-memory → 含「会话」+ 截断 token（不完整暴露）', () => {
    const w = resolveInfoToWarning({ token: 'tokLong1234567890', source: 'in-memory' })
    expect(w).toContain('会话')
    expect(w).toContain('tokLong1')  // slice(0, 8) → 8 字符
    expect(w).not.toContain('tokLong1234567890')  // 不能完整暴露 30 位 token
  })

  it('persisted → 含「profile=xxx」+ 截断 token', () => {
    const w = resolveInfoToWarning({
      token: 'tokPersistABCDEFGHIJ', source: 'persisted', profile: 'unwr-web',
    })
    expect(w).toContain('profile=unwr-web')
    expect(w).toContain('tokPersi')  // slice(0, 8)
  })
})

describe('noWorkTokenHint 自纠正', () => {
  it('本机有已知作品 → 列出 token+name 一次调用恢复', () => {
    rememberWorkToken('tokHint1')
    rememberWork({ baseToken: 'tokHint1', name: '示例作品甲' })
    const hint = noWorkTokenHint()
    expect(hint).toContain('未指定 workToken')
    expect(hint).toContain('示例作品甲')
    expect(hint).toContain('tokHint1')
  })

  it('本机无记录 → 提示 list', () => {
    const hint = noWorkTokenHint()
    expect(hint).toContain('list')
    expect(hint).toContain('novel_manage_work')
  })
})

describe('isWorkNotFound 判定', () => {
  it('FeishuError.kind === not_found → true', () => {
    expect(isWorkNotFound({ kind: 'not_found', message: 'x' })).toBe(true)
  })
  it('message 含 NOTEXIST / not exist / not found → true', () => {
    expect(isWorkNotFound(new Error('NOTEXIST（目标资源不存在）'))).toBe(true)
    expect(isWorkNotFound(new Error('base not exist'))).toBe(true)
    expect(isWorkNotFound(new Error('record not found'))).toBe(true)
  })
  it('中文业务错误（第 N 章不存在）不误判', () => {
    expect(isWorkNotFound(new Error('第 3 章不存在，请先用 novel_write_chapter 创建。'))).toBe(false)
    expect(isWorkNotFound(new Error('普通失败'))).toBe(false)
    expect(isWorkNotFound(null)).toBe(false)
    expect(isWorkNotFound(undefined)).toBe(false)
  })
})

describe('workNotFoundRecoveryMessage 自纠正文案', () => {
  it('本机有其他作品 → 列出「名字 → token」', () => {
    rememberWork({ baseToken: 'tokKnown', name: '洗骨录' })
    const msg = workNotFoundRecoveryMessage('tokBAD', new Error('NOTEXIST'))
    expect(msg).toContain('tokBAD')
    expect(msg).toContain('洗骨录')
    expect(msg).toContain('tokKnown')
    // 坏 token 不在候选列表里
    expect(msg).not.toContain('tokBAD\n')
    expect(msg).toContain('没有被记住为默认作品')
  })

  it('本机无其他作品 → 提示 list（带索引延迟说明）', () => {
    const msg = workNotFoundRecoveryMessage('tokBAD', new Error('NOTEXIST'))
    expect(msg).toContain('novel_manage_work(action=list)')
    expect(msg).toContain('分钟级延迟')
  })
})

describe('withWorkToken 三语义（2026-09-04 NOTEXIST 排障固化）', () => {
  it('显式坏 token 撞 NOTEXIST：报错列出本机已知作品，默认作品不被污染', async () => {
    rememberWork({ baseToken: 'tokGood', name: '好作品' })
    rememberWorkToken('tokGood')

    await expect(withWorkToken(
      { workToken: 'tokBAD' },
      async () => {
        throw new Error('NOTEXIST（目标资源不存在：...）')
      },
      undefined,
    )).rejects.toThrow(/好作品/)

    // 关键回归断言：坏 token 不得覆盖落盘的默认作品（旧实现「解析即记住」会覆盖，
    // 导致后续无参调用继续撞同一个 NOTEXIST 的死循环）
    expect(getLastWorkToken()).toBe('tokGood')
  })

  it('显式好 token 成功：切换默认（内存 + 落盘）', async () => {
    rememberWork({ baseToken: 'tokOld', name: '旧作' })
    rememberWorkToken('tokOld')

    const r = await withWorkToken({ workToken: 'tokNew' }, async (token) => `ran:${token}`, undefined)
    expect(r).toBe('ran:tokNew')
    expect(getLastWorkToken()).toBe('tokNew')
    // 后续无参调用应解析到新默认
    expect(resolveWorkToken({})).toBe('tokNew')
    consumeLastResolveInfo()
  })

  it('无参调用走回退 token 成功：同样记住', async () => {
    rememberWork({ baseToken: 'tokFallback', name: '回退作' })
    rememberWorkToken('tokFallback')
    // 重新加载 defaults 模块让内存 lastWorkToken 为空（模拟冷启动，回退走落盘）
    vi.resetModules()
    const { withWorkToken: withFresh } = await import('../src/tools/defaults.ts')
    const r = await withFresh({}, async (token) => token, undefined)
    expect(r).toBe('tokFallback')
    expect(getLastWorkToken()).toBe('tokFallback')
  })

  it('非 not_found 错误原样透传（不被包装）', async () => {
    await expect(withWorkToken(
      { workToken: 'tokX' },
      async () => {
        throw new Error('权限不足')
      },
      undefined,
    )).rejects.toThrow(/^权限不足$/)
  })

  it('not_found 包装错误保留 cause 原始异常', async () => {
    const cause = new Error('NOTEXIST')
    await expect(withWorkToken(
      { workToken: 'tokY' },
      async () => {
        throw cause
      },
      undefined,
    )).rejects.toMatchObject({ cause })
  })
})
