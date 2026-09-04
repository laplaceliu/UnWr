/**
 * 读取**实际加载的本 bundle** 所属包的版本号。
 *
 * 为什么不构建时注入（esbuild define）：注入的是「构建那一刻」的值，
 * bundle 被复制/缓存错位时会撒谎；这里直接读加载路径旁的 package.json——
 * 模块从哪个包里加载，就报哪个包的版本，所见即所装。
 *
 * 路径推演（bundle 被 esbuild 打到 dist/*.mjs，import.meta.url = dist/）：
 *   - 发布态  packages/plugin/dist/unwr-*.mjs → ../package.json = packages/plugin/package.json
 *   - 开发态  dist/unwr-*.mjs               → ../package.json = 根 package.json
 *   - 源码态（vitest）src/version.ts        → packages/web/package.json 不存在 → 'unknown'
 *
 * @module @unwr/web/version
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/** bundle 所属包的版本号；解析失败降级为 'unknown'（绝不抛错）。 */
export function readBundleVersion(): string {
  if (cached !== undefined) return cached
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    cached = typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown'
  } catch {
    cached = 'unknown'
  }
  return cached
}
