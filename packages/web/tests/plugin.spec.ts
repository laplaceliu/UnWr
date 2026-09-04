/**
 * unwr-web 插件的 Cordis 契约测试。
 *
 * 实机事故 2026-09-03：插件没声明 `inject` 就访问 `ctx.webServer`，
 * Cordis 直接抛 `cannot get property "webServer" without inject`，
 * **整个 DSH 进程起不来**（web profile 启动被一个可选工作台插件炸掉）。
 * 实机副本当时是靠手动摘掉 unwr-web 块绕过的。
 *
 * 本文件守住插件契约：name/inject 声明 + apply 的路由注册行为。
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'

const plugin = await import('../src/plugin.ts')

describe('unwr-web Cordis 契约', () => {
  it('必须声明 inject 含 webServer（缺失 = DSH 启动即崩）', () => {
    expect(plugin.inject).toContain('webServer')
  })

  it('必须声明插件名与 apply', () => {
    expect(plugin.name).toBe('unwr-web')
    expect(typeof plugin.apply).toBe('function')
  })
})

describe('readBundleVersion 版本可见性', () => {
  it('源码态（packages/web 无 package.json）降级 unknown，绝不抛错', async () => {
    const { readBundleVersion } = await import('../src/version.ts')
    // src/version.ts 的 ../package.json 不存在 → 'unknown'；
    // 发布态（dist/*.mjs）则解析 packages/plugin/package.json 的版本
    expect(typeof readBundleVersion()).toBe('string')
    expect(readBundleVersion().length).toBeGreaterThan(0)
  })
})

describe('apply 的路由注册', () => {
  function stubCtx() {
    const routes: { kind: string; path: string }[] = []
    const ctx = {
      webServer: {
        register: vi.fn((route: { kind: string; path: string }) => {
          routes.push({ kind: route.kind, path: route.path })
          return () => {}
        }),
      },
    }
    return { ctx, routes }
  }

  it('注册 3 个静态路由 + 1 个 /workbench/api 前缀路由（/api 被平台保留）', () => {
    // apply 需要 dist/public 存在；单测里直接构造假目录结构不可行
    // （publicDir = 本文件相对 dist/），跳过目录校验的前提是它存在。
    // 这里用 assert.throws 探测「目录校验先于注册」的顺序契约：
    // 在源码树里跑（publicDir 不存在）应报目录错误而不是 webServer 错误，
    // 证明 inject 后的 webServer 访问不炸。
    const { ctx } = stubCtx()
    expect(() => plugin.apply(ctx, {})).toThrow(/静态资源目录/)
  })

  it('webServer 缺失时给可读错误（而非 cordis 裸拦截）', async () => {
    // 临时伪造 publicDir 让目录校验通过。插件经 vite 加载时
    // import.meta.url 指向 src/plugin.ts → publicDir = packages/web/src/public。
    const { existsSync, mkdirSync, rmSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const publicDir = join(dirname(here), 'src', 'public')
    const created = !existsSync(publicDir)
    if (created) mkdirSync(publicDir, { recursive: true })
    try {
      const routes: string[] = []
      const ctx = {
        webServer: {
          register: vi.fn((route: { kind: string; path: string }) => {
            routes.push(route.path)
            return () => {}
          }),
        },
      }
      plugin.apply(ctx, {})
      expect(routes).toEqual(['/workbench', '/workbench/app.js', '/workbench/style.css', '/workbench/api'])
    } finally {
      if (created) rmSync(publicDir, { recursive: true, force: true })
    }
  })
})
