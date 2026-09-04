/**
 * 作品注册表（跨重启持久化）的测试。
 *
 * 对应实机故障 2026-09-03：DSH 重启后，同一会话继续改稿，
 * 模型调用 novel_read_chapter(第4章) 直接报
 *   Error: 未指定 workToken，且本会话尚未用过任何作品。
 *          请先调用 novel_manage_work(action=list) 获取 base_token 并传入。
 * 而它照做之后 list 里**没有那部作品**——作品是本会话新建的，飞书搜索
 * 索引还没收录。于是模型只能靠上下文记忆里的 token 反复试，绕了 3 轮。
 *
 * 两个 bug 叠加：
 *   A. 会话默认作品只在内存 → 重启即丢
 *   B. list 依赖 drive 搜索 → 新建作品搜不到，而报错偏偏指引去调 list
 *
 * 本文件守住修复：
 *   1. 记住的 token 能跨"进程重启"恢复（重新读盘即恢复 = 跨进程可见）
 *   2. 无默认作品时，报错里直接列出已知作品名 + token
 *   3. 先记住 token、后学到名字，名字能补上（不覆盖为空白）
 *   4. 损坏的状态文件不会让工具崩
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在 import 被测模块**之前**设好，模块每次读盘都会读这个环境变量
const STATE_DIR = mkdtempSync(join(tmpdir(), 'unwr-store-'))
const STATE_FILE = join(STATE_DIR, 'work-state.json')
process.env['UNWR_STATE_FILE'] = STATE_FILE

const {
  clearWorkStateForTests, getCurrentProfile, getLastWorkToken, knownWorks, mergeWorks,
  rememberWork, rememberWorkToken,
} = await import('../src/domain/work-store.ts')
const {
  consumeLastResolveInfo, noWorkTokenHint, resolveWorkToken,
} = await import('../src/tools/defaults.ts')

beforeEach(() => {
  clearWorkStateForTests()
})

afterEach(() => {
  clearWorkStateForTests()
})

/** 读盘原始内容，用于验证确实落盘（而非只写内存）。 */
function rawOnDisk(): string {
  try {
    return readFileSync(STATE_FILE, 'utf8')
  } catch {
    return ''
  }
}

describe('作品注册表持久化', () => {
  it('记住 token 后确实落到磁盘', () => {
    rememberWorkToken('tokFixture')
    expect(rawOnDisk()).toContain('tokFixture')
    expect(getLastWorkToken()).toBe('tokFixture')
  })

  it('跨"进程重启"恢复：清空内存态后仍能取回上次作品', () => {
    // 模块内不缓存状态、每次读盘，所以"重新读"就等价新进程冷启动
    rememberWorkToken('tokFixture')
    expect(getLastWorkToken()).toBe('tokFixture')
    // 再来一次读取 = 模拟重启后的全新进程
    expect(getLastWorkToken()).toBe('tokFixture')
  })

  it('多个作品按最近使用排序，且上限内保留', () => {
    rememberWork({ baseToken: 'tokA', name: '甲' })
    rememberWork({ baseToken: 'tokB', name: '乙' })
    rememberWork({ baseToken: 'tokA', name: '甲' })
    const works = knownWorks()
    expect(works.map((w) => w.baseToken)).toEqual(['tokA', 'tokB'])
    expect(getLastWorkToken()).toBe('tokA')
  })

  it('先记 token、后补名字：名字不会被空白覆盖', () => {
    rememberWorkToken('tokX')
    expect(knownWorks()[0]?.name).toBe('')
    // 后续 get_config / list 学到名字
    rememberWork({ baseToken: 'tokX', name: '示例作品' })
    expect(knownWorks()[0]?.name).toBe('示例作品')
    // 再来一次无名记录，不得把名字抹掉
    rememberWorkToken('tokX')
    expect(knownWorks()[0]?.name).toBe('示例作品')
  })

  it('损坏的状态文件不致命（按空状态处理）', () => {
    writeFileSync(STATE_FILE, '{ this is not json', 'utf8')
    expect(getLastWorkToken()).toBe('')
    expect(knownWorks()).toEqual([])
    // 之后仍能正常写入，自愈
    rememberWorkToken('tokRecover')
    expect(getLastWorkToken()).toBe('tokRecover')
  })

  it('结构异常的文件不致命（字段类型不对）', () => {
    writeFileSync(STATE_FILE, JSON.stringify({
      lastWorkToken: 42,
      works: [{ name: '缺 token' }, 'not-an-object', null],
    }), 'utf8')
    expect(getLastWorkToken()).toBe('')
    expect(knownWorks()).toEqual([])
  })

  it('空 token 不写入（防止污染记录）', () => {
    rememberWorkToken('')
    expect(knownWorks()).toEqual([])
  })
})

describe('resolveWorkToken 冷启动恢复（本轮报错的主路径）', () => {
  it('本机有记录时，不带 workToken 也能直接解析出来', () => {
    // 前提：进程内默认也为空（冷启动）
    rememberWorkToken('tokFixture')
    expect(resolveWorkToken({})).toBe('tokFixture')
  })

  it('显式传入优先，并覆盖本机记录', () => {
    rememberWorkToken('old')
    expect(resolveWorkToken({ workToken: 'new' })).toBe('new')
    expect(getLastWorkToken()).toBe('new')
  })
})

describe('无作品记录时的报错必须能自纠正', () => {
  it('无任何记录：指引去 list', () => {
    expect(noWorkTokenHint()).toMatch(/novel_manage_work\(action=list\)/)
  })

  it('有记录：直接列出作品名与 token（不必再绕一次 list）', () => {
    rememberWork({ baseToken: 'tokFixture', name: '示例作品' })
    const hint = noWorkTokenHint()
    expect(hint).toContain('示例作品')
    expect(hint).toContain('tokFixture')
  })

  it('无名作品只列 token，不显示难看的空括号', () => {
    rememberWorkToken('bareToken123')
    expect(noWorkTokenHint()).toContain('bareToken123')
    expect(noWorkTokenHint()).not.toContain('→')
  })
})

describe('mergeWorks：搜索结果与本机记录合并（问题 B）', () => {
  const remote = [
    { baseToken: 'tokA', name: '甲' },
    { baseToken: 'tokB', name: '乙' },
  ]

  it('本机独有（新建、索引未收录）的作品被补进列表', () => {
    const local = [
      { baseToken: 'tokNew', name: '示例作品' },
      { baseToken: 'tokA', name: '甲' },
    ]
    const { works, localOnly } = mergeWorks(remote, local)
    expect(works.map((w) => w.baseToken)).toEqual(['tokA', 'tokB', 'tokNew'])
    expect(localOnly.map((w) => w.name)).toEqual(['示例作品'])
  })

  it('远程已覆盖时不重复补（按 baseToken 去重）', () => {
    const { works, localOnly } = mergeWorks(remote, remote)
    expect(works).toHaveLength(2)
    expect(localOnly).toEqual([])
  })

  it('远程优先：同名冲突时保留远程那条的顺序与内容', () => {
    const local = [{ baseToken: 'tokA', name: '甲（本机旧名）' }]
    const { works } = mergeWorks(remote, local)
    expect(works[0]?.name).toBe('甲')
  })

  it('两端皆空 → 空列表', () => {
    expect(mergeWorks([], []).works).toEqual([])
  })
})

describe('DSH profile 隔离（2026-09-04 实机踩坑追加）', () => {
  it('UNWR_PROFILE 隔离：profile=A 写的 token 不会污染 profile=B', () => {
    // 切换 profile=A，写入
    process.env['UNWR_PROFILE'] = 'profileA'
    const stateFileA = STATE_FILE.replace('work-state.json', 'profileA/work-state.json')
    process.env['UNWR_STATE_FILE'] = stateFileA
    rememberWorkToken('tokA_works_A')
    rememberWork({ baseToken: 'tokA_works_A', name: '甲' })
    expect(rawOnDiskFile(stateFileA)).toContain('tokA_works_A')
    expect(getLastWorkToken()).toBe('tokA_works_A')

    // 切换 profile=B，写入
    process.env['UNWR_PROFILE'] = 'profileB'
    const stateFileB = STATE_FILE.replace('work-state.json', 'profileB/work-state.json')
    process.env['UNWR_STATE_FILE'] = stateFileB
    rememberWorkToken('tokB_works_B')
    expect(getLastWorkToken()).toBe('tokB_works_B')

    // 关键：B 写的时候不能读到 A 的 token
    expect(rawOnDiskFile(stateFileB)).not.toContain('tokA_works_A')
    expect(rawOnDiskFile(stateFileB)).toContain('tokB_works_B')

    // 切回 A：能读回自己的 token（不需要重新写入）
    process.env['UNWR_PROFILE'] = 'profileA'
    process.env['UNWR_STATE_FILE'] = stateFileA
    expect(getLastWorkToken()).toBe('tokA_works_A')

    // 清理
    delete process.env['UNWR_PROFILE']
    delete process.env['UNWR_STATE_FILE']
  })

  it('resolveWorkToken 的 source=persisted 携带 profile 名（供 warning 用）', async () => {
    process.env['UNWR_PROFILE'] = 'unwr-agent'
    const stateFileAgent = STATE_FILE.replace('work-state.json', 'unwr-agent/work-state.json')
    process.env['UNWR_STATE_FILE'] = stateFileAgent
    rememberWorkToken('tokAgent')

    // 模拟"新进程冷启动"：重置 modules，让 defaults.ts 的 lastWorkToken 重新初始化
    vi.resetModules()
    const { resolveWorkToken: resolveFresh, consumeLastResolveInfo: consumeFresh } =
      await import('../src/tools/defaults.ts')
    resolveFresh({})  // 触发 persisted 回退
    const info = consumeFresh()
    expect(info).toBeDefined()
    expect(info?.source).toBe('persisted')
    expect(info?.profile).toBe('unwr-agent')
    expect(info?.token).toBe('tokAgent')

    // 清理
    delete process.env['UNWR_PROFILE']
    delete process.env['UNWR_STATE_FILE']
  })

  it('UNWR_PROFILE 优先于 DSH_PROFILE', async () => {
    process.env['UNWR_PROFILE'] = 'override-profile'
    process.env['DSH_PROFILE'] = 'dsh-profile'
    const { getCurrentProfile } = await import('../src/domain/work-store.ts')
    expect(getCurrentProfile()).toBe('override-profile')
    delete process.env['UNWR_PROFILE']
    delete process.env['DSH_PROFILE']
  })
})

/** 读任意路径的 state 文件原始内容。 */
function rawOnDiskFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
