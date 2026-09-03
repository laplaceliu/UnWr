/**
 * 作品注册表（跨进程持久化）。
 *
 * 解决两个实机问题（2026-09-03）：
 *
 * 1. **会话默认作品重启即丢**：`tools/defaults.ts` 的 `lastWorkToken` 是模块级
 *    变量，DSH 一重启进程就没了。而当时的报错偏偏指引模型去调
 *    `novel_manage_work(action=list)`——这条路在问题 2 上走不通，于是模型
 *    只能靠上下文记忆里的 token 反复试（实测绕了 3 轮才找回作品）。
 *
 * 2. **新建作品搜不到**：`list` 走 `drive +search`，飞书对新建 bitable 的搜索
 *    索引有分钟级延迟（e2e 里已为此专门写了轮询容忍）。刚创建的作品恰恰是
 *    模型最需要找的那一个，却不在 list 结果里。
 *
 * 两者同源：缺一份「本机已知作品」的持久记录。本模块提供它——
 *   - `lastWorkToken`：上次用过的作品，重启后自动恢复，零调用
 *   - `works`：已知作品（含新建但尚未被搜索索引到的），供 list 兜底
 *
 * 文件位置：默认 `~/.unwr/work-state.json`——**刻意放在仓库外**，避免把真实
 * base_token 写进工作区（隐私红线）。测试环境自动改用临时目录，单测不会
 * 污染/覆盖用户真实状态。可用 `UNWR_STATE_FILE` 覆盖。
 *
 * 多进程：主会话与子代理是**独立进程**，共享同一个文件。因此每次读取都重新
 * 读盘（文件极小，读一次远小于一次飞书调用），写入采用「临时文件 + 原子
 * rename」，避免并发下读到半截 JSON。
 *
 * 失效兜底：本地记录只是加速用的索引，不是事实来源。token 无效时平台调用
 * 会照常报错，模型可重新 list 纠正——所以这里的一切失败都静默降级。
 *
 * @module @unwr/novel/domain/work-store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 已知作品摘要（与 domain/work.ts 的 WorkSummary 同形）。 */
export interface KnownWork {
  baseToken: string
  name: string
  url?: string
  updatedAt?: string
}

interface WorkState {
  version: 1
  lastWorkToken: string
  works: KnownWork[]
}

/** 最多保留的作品数，防止长期无限增长。 */
const MAX_WORKS = 50

/** 状态文件路径（可用 UNWR_STATE_FILE 覆盖）。 */
function stateFile(): string {
  const override = process.env['UNWR_STATE_FILE']
  if (typeof override === 'string' && override !== '') return override
  // 测试环境绝不写真实用户状态：单测会把用户上次用的作品覆盖成假 token，
  // 用户下次启动就撞上"作品不对"的诡异问题。
  if (process.env['VITEST'] !== undefined) {
    return join(tmpdir(), 'unwr-work-state.test.json')
  }
  return join(homedir(), '.unwr', 'work-state.json')
}

function emptyState(): WorkState {
  return { version: 1, lastWorkToken: '', works: [] }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined

/** 把任意解析结果收敛成合法状态（文件损坏/手改都不该让工具崩）。 */
function normalize(raw: unknown): WorkState {
  if (typeof raw !== 'object' || raw === null) return emptyState()
  const o = raw as Record<string, unknown>
  const works: KnownWork[] = []
  if (Array.isArray(o['works'])) {
    for (const item of o['works']) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const baseToken = str(r['baseToken'])
      if (baseToken === '') continue
      const url = optStr(r['url'])
      const updatedAt = optStr(r['updatedAt'])
      works.push({
        baseToken,
        name: str(r['name']),
        ...url === undefined ? {} : { url },
        ...updatedAt === undefined ? {} : { updatedAt },
      })
    }
  }
  return {
    version: 1,
    lastWorkToken: str(o['lastWorkToken']),
    works: works.slice(0, MAX_WORKS),
  }
}

/**
 * 每次都重新读盘——主会话与子代理是不同进程，必须能看到彼此的写入
 * （子代理里 create 的作品，主会话的 list 也要能列出来）。
 */
function load(): WorkState {
  try {
    return normalize(JSON.parse(readFileSync(stateFile(), 'utf8')) as unknown)
  } catch {
    // 文件不存在 / 损坏 / 并发写冲突：一律按空状态处理，绝不让工具崩
    return emptyState()
  }
}

/** 原子写：先写临时文件再 rename，避免并发读到半截 JSON。 */
function save(state: WorkState): void {
  const file = stateFile()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // 只读环境 / 权限问题：本地记录只是兜底索引，写失败不影响主流程
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 把作品合入列表（同 token 则合并字段，最近使用的排在最前）。 */
function upsert(state: WorkState, w: KnownWork): void {
  const i = state.works.findIndex((x) => x.baseToken === w.baseToken)
  const prev = i >= 0 ? state.works[i] : undefined
  const url = w.url ?? prev?.url
  const updatedAt = w.updatedAt ?? prev?.updatedAt
  const merged: KnownWork = {
    baseToken: w.baseToken,
    // 名称以非空的为准：先记住 token、后学到名字是常见路径
    name: w.name !== '' ? w.name : (prev?.name ?? ''),
    ...url === undefined ? {} : { url },
    ...updatedAt === undefined ? {} : { updatedAt },
  }
  if (i >= 0) state.works.splice(i, 1)
  state.works.unshift(merged)
  if (state.works.length > MAX_WORKS) state.works.length = MAX_WORKS
}

/**
 * 合并「飞书搜索结果」与「本机记录」：远程优先，本机补齐缺失的。
 *
 * 新建作品的搜索索引有分钟级延迟——它不在 remote 里、却在 local 里，
 * 这正是要补回来的那一批（也是模型最需要找的那一部）。
 *
 * 抽成纯函数是为了可测：这段是问题 B 的核心，不该只能靠 e2e 覆盖。
 */
export function mergeWorks(
  remote: readonly KnownWork[],
  local: readonly KnownWork[],
): { works: KnownWork[]; localOnly: KnownWork[] } {
  const seen = new Set(remote.map((w) => w.baseToken))
  const localOnly = local.filter((w) => !seen.has(w.baseToken))
  return { works: [...remote, ...localOnly], localOnly }
}

/**
 * 本机上次使用的作品 token；无则空串。
 *
 * 用于**跨重启恢复默认作品**：进程内的 `lastWorkToken` 重启即空，
 * 这里能把它捞回来，模型无需任何额外调用。
 */
export function getLastWorkToken(): string {
  return load().lastWorkToken
}

/** 本机已知作品（最近使用的在前）。 */
export function knownWorks(): KnownWork[] {
  return load().works
}

/** 记住一个 token（名称未知时占位，后续学到名字会补上）。 */
export function rememberWorkToken(baseToken: string): void {
  if (baseToken === '') return
  const state = load()
  state.lastWorkToken = baseToken
  upsert(state, { baseToken, name: '' })
  save(state)
}

/** 记住一部作品（含名称/链接），并设为最近使用。 */
export function rememberWork(w: KnownWork): void {
  if (w.baseToken === '') return
  const state = load()
  state.lastWorkToken = w.baseToken
  upsert(state, w)
  save(state)
}

/** 清空本地记录（仅测试用）。 */
export function clearWorkStateForTests(): void {
  try {
    rmSync(stateFile(), { force: true })
  } catch {
    /* 忽略 */
  }
}
