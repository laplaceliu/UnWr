/**
 * UnWr 工作台 DSH 插件入口。
 *
 * 把自己注册到 ctx.webServer：
 *   - 静态资源 3 个文件 → /workbench, /workbench/app.js, /workbench/style.css
 *   - 领域 API → /workbench/api/agents, /workbench/api/works (GET/POST),
 *                /workbench/api/outline, /workbench/api/chapter,
 *                /workbench/api/context, /workbench/api/checks,
 *                /workbench/api/view/:view
 *
 * **API 前缀必须是 /workbench/api**：`/api` 被 dsh-client-connection 保留
 * （API_PATH 常量，webServer 对重复 prefix 路由直接报
 * `duplicate prefix route`，实机 2026-09-03）。
 *
 * 资源定位：
 *   - 静态文件相对本文件 URL 解析 → `dist/public/`（build 脚本拷 public/ 到这里）
 *   - 智能体配置从 process.env.UNWR_ROOT/profiles/web/cordis.patch.yml 解析
 *
 * 启动后：浏览器访问 DSH 端口根（聊天 UI）/workbench（工作台）。
 *
 * @module @unwr/web/plugin
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  json, fail, readBody, workCards, createWork, outline, chapterDetail,
  contextDigest, checks, tableView, parseAgentProfiles, STATIC_MIME,
  type AgentProfile,
} from './api.ts'
import { configureLark } from '../../feishu/src/cli.ts'
import { readBundleVersion } from './version.ts'

/* ============================== 静态资源 ============================== */

/**
 * 防 traversal 的精确文件服务：path 必须是 `publicDir` 内的相对路径。
 * 服务端再拼接，防止请求方传入 `../../etc/passwd`。
 * 失败时返回 404 + 简短 plain text（handler 必须 void | Promise<void>）。
 */
function serveStatic(publicDir: string, rel: string) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const base = publicDir.endsWith('/') ? publicDir : `${publicDir}/`
    const norm = join(publicDir, rel)
    if (!norm.startsWith(base) || !existsSync(norm) || !statSync(norm).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': STATIC_MIME[rel.includes('.') ? '.' + rel.split('.').pop() : ''] ?? 'application/octet-stream' })
    res.end(readFileSync(norm))
  }
}

function sendStaticHtml(publicDir: string, rel: string) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    const file = join(publicDir.endsWith('/') ? publicDir : `${publicDir}/`, rel)
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(file))
  }
}

/* ============================== 路由分派 ============================== */

/**
 * 单一 prefix 路由 /api：内部 if/else 分派到具体领域函数。
 * 优点：插件只需 register 1 次；缺点：路由表全部在一个函数里。
 * 当前 API 数量 < 12 个，可接受；超过后改 dispatch 表。
 */
function apiDispatcher(publicDir: string) {
  const agentCache: AgentProfile[] | null = null

  const loadAgents = (): AgentProfile[] => {
    const root = process.env.UNWR_ROOT
    if (root === undefined || root === '') {
      throw new Error('未设置 UNWR_ROOT，无法解析 profiles/web/cordis.patch.yml。')
    }
    const ymlPath = join(root, 'profiles', 'web', 'cordis.patch.yml')
    if (!existsSync(ymlPath)) {
      throw new Error(`profiles 文件不存在: ${ymlPath}`)
    }
    return parseAgentProfiles(readFileSync(ymlPath, 'utf8'))
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x')
    // 路由按 /workbench/api 挂载（/api 被平台保留）。把前缀归一回
    // /api 再做内部分支匹配，前后端路径语义保持不变。
    const pathname = url.pathname.replace(/^\/workbench\/api/, '/api')
    const method = req.method ?? 'GET'

    try {
      if (pathname === '/api/health' && method === 'GET') {
        // version = 实际加载的本 bundle 所属包版本（运行实例无法从外部
        // 直接判版本，health 是唯一权威入口；实机排障 2026-09-04）
        json(res, 200, { ok: true, version: readBundleVersion() })
        return
      }
      if (pathname === '/api/agents' && method === 'GET') {
        json(res, 200, { agents: agentCache ?? loadAgents() })
        return
      }
      if (pathname === '/api/works' && method === 'GET') {
        json(res, 200, { works: await workCards() })
        return
      }
      if (pathname === '/api/works' && method === 'POST') {
        json(res, 200, await createWork(await readBody(req)))
        return
      }
      if (pathname === '/api/outline' && method === 'GET') {
        const token = url.searchParams.get('baseToken')
        if (token === null || token === '') throw new Error('需要 baseToken。')
        json(res, 200, await outline(token))
        return
      }
      if (pathname === '/api/chapter' && method === 'GET') {
        const token = url.searchParams.get('baseToken')
        const no = Number(url.searchParams.get('chapterNo') ?? '0')
        if (token === null || token === '') throw new Error('需要 baseToken。')
        if (!Number.isFinite(no) || no <= 0) throw new Error('需要合法 chapterNo。')
        json(res, 200, await chapterDetail(token, no, {
          scenes: url.searchParams.get('scenes') === 'true',
          history: url.searchParams.get('history') === 'true',
        }))
        return
      }
      if (pathname === '/api/context' && method === 'GET') {
        const token = url.searchParams.get('baseToken')
        const no = Number(url.searchParams.get('chapterNo') ?? '0')
        if (token === null || token === '') throw new Error('需要 baseToken。')
        if (!Number.isFinite(no) || no <= 0) throw new Error('需要合法 chapterNo。')
        json(res, 200, await contextDigest(token, no))
        return
      }
      if (pathname === '/api/checks' && method === 'GET') {
        const token = url.searchParams.get('baseToken')
        if (token === null || token === '') throw new Error('需要 baseToken。')
        json(res, 200, await checks(token, url.searchParams))
        return
      }
      if (pathname.startsWith('/api/view/') && method === 'GET') {
        const token = url.searchParams.get('baseToken')
        if (token === null || token === '') throw new Error('需要 baseToken。')
        const view = pathname.slice('/api/view/'.length)
        json(res, 200, { rows: await tableView(token, view) })
        return
      }
      json(res, 404, { error: 'no route' })
    } catch (e) {
      fail(res, e)
    }
  }
}

/* ============================== 插件入口 ============================== */

/**
 * Cordis 插件名与服务声明。
 *
 * **必须声明 inject**：Cordis 对未声明的服务属性访问直接抛
 * `cannot get property "webServer" without inject`（实机 2026-09-03：
 * 之前没声明，DSH 一启动就崩，实机副本曾被人手动摘掉 unwr-web 块绕过）。
 * 声明后 cordis 会等 webServer 就绪再 apply——与官方 host 插件
 * （dsh-host-directory-picker-auto / dsh-client-modules）同款写法。
 */
export const name = 'unwr-web'
export const inject = ['webServer']

/** unwr-web 插件配置。 */
export interface Config {
  /**
   * lark-cli 路径（与 unwr-novel 的 larkBin 语义一致）。
   * web bundle 内联独立的适配层副本，与 novel 插件的配置互不相通，
   * 两个插件都要配（或在 patch 里只给用到的那个配）。
   */
  larkBin?: string
}

export function apply(_ctx: unknown, _config: Config | unknown): void {
  const config = (_config ?? {}) as Config
  configureLark({ bin: config.larkBin })
  // 解析 dist/public/：本文件被 esbuild bundle 到 dist/unwr-web.mjs，
  // 所以 import.meta.dirname 在运行时 = dist/。
  const here = dirname(fileURLToPath(import.meta.url))
  const publicDir = join(here, 'public')

  if (!existsSync(publicDir)) {
    throw new Error(`unwr-web: 静态资源目录不存在: ${publicDir}（build 脚本应拷 public/ → dist/public/）。`)
  }

  // 类型化不够宽松以兼容 cordis ctx——见 unwr-novel/plugin.ts 的同类写法
  type WebServerLike = {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  // inject 声明后 ctx.webServer 必然就绪；这里保留兜底，只在插件被
  // 脱离 web profile 误用时给出可读错误（而非 cordis 的裸拦截）。
  const ctx = _ctx as { webServer?: WebServerLike }
  const ws: WebServerLike | undefined = ctx.webServer
  if (ws === undefined) {
    throw new Error('unwr-web: webServer 服务不可用（unwr-web 只能在提供 webServer 的 profile 下加载）。')
  }

  const dispatch = apiDispatcher(publicDir)

  ws.register({ kind: 'exact', path: '/workbench',          handler: sendStaticHtml(publicDir, 'index.html') })
  ws.register({ kind: 'exact', path: '/workbench/app.js',   handler: serveStatic(publicDir, 'app.js') })
  ws.register({ kind: 'exact', path: '/workbench/style.css', handler: serveStatic(publicDir, 'style.css') })
  ws.register({ kind: 'prefix', path: '/workbench/api',     handler: dispatch })
}