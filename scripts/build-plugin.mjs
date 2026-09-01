/**
 * 把 UnWr 打包为 DSH 可加载的 JS bundle。
 *
 * 为什么需要打包：npx 安装的 DSH（0.1.1-rc.2）是编译后的 dist，
 * **不含 tsx**，无法直接加载我们的 .ts 源码插件。
 * 因此把 schema/feishu/novel 三个包内联为单个 ESM 文件。
 *
 * external 保留 @deepseek-ai/* 与 node:* —— 由宿主 DSH 提供，
 * 这样同一份 bundle 在源码版与 npx 版都能用。
 *
 * 用法：node scripts/build-plugin.mjs [--watch]
 * @module
 */

import { context, build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist/unwr-novel.mjs')
const watch = process.argv.includes('--watch')

/** 宿主 DSH 提供的依赖，不打包进 bundle。 */
const external = [
  '@deepseek-ai/*',
  'node:*',
]

const options = {
  entryPoints: [resolve(root, 'packages/novel/src/index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // 保留 .ts 源码映射，便于出错时定位到原始行
  sourcemap: 'inline',
  // 不压缩：插件需要可读，且方便排查
  minify: false,
  external,
  logLevel: 'info',
}

await mkdir(dirname(outfile), { recursive: true })

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log(`[unwr] watching → ${outfile}`)
} else {
  await build(options)
  console.log(`[unwr] built → ${outfile}`)
}
