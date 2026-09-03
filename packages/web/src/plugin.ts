/**
 * UnWr 工作台 DSH 插件入口。
 *
 * 把自己注册到 ctx.webServer：
 *   - 静态资源 3 个文件 → /workbench, /workbench/app.js, /workbench/style.css
 *   - 领域 API → /api/agents, /api/works (GET/POST), /api/outline,
 *                /api/chapter, /api/context, /api/checks, /api/view/:view
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
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    try {
      if (pathname === '/api/health' && method === 'GET') {
        json(res, 200, { ok: true })
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

export function apply(_ctx: unknown, _config: unknown): void {
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
  // 借助 ctx 注入取 webServer
  // cordis 通用注册法：插件被传入 (ctx, config)，ctx.inject('webServer')。
  const ctx = _ctx as { webServer?: WebServerLike; inject?: <T>(svc: string) => T; get?: <T>(svc: string) => T }
  const ws: WebServerLike | undefined =
    ctx.webServer ?? ctx.inject?.('webServer') ?? ctx.get?.('webServer')
  if (ws === undefined) {
    throw new Error('unwr-web: DSH 未暴露 webServer（应确认 dsh-host-webserver 已启用）。')
  }

  const dispatch = apiDispatcher(publicDir)

  ws.register({ kind: 'exact', path: '/workbench',          handler: sendStaticHtml(publicDir, 'index.html') })
  ws.register({ kind: 'exact', path: '/workbench/app.js',   handler: serveStatic(publicDir, 'app.js') })
  ws.register({ kind: 'exact', path: '/workbench/style.css', handler: serveStatic(publicDir, 'style.css') })
  ws.register({ kind: 'prefix', path: '/api',               handler: dispatch })
}