/**
 * 把 UnWr 打包为 DSH 可加载的 JS bundle。
 *
 * 为什么需要打包：npx 安装的 DSH（0.1.1-rc.2）是编译后的 dist，
 * **不含 tsx**，无法直接加载我们的 .ts 源码插件。
 * 因此把 schema/feishu/novel/web 四个包内联为单个 ESM 文件。
 *
 * external 保留 @deepseek-ai/* 与 node:* —— 由宿主 DSH 提供，
 * 这样同一份 bundle 在源码版与 npx 版都能用。
 *
 * Web 插件额外拷 packages/web/public/ → dist/public/，
 * 这样 plugin.ts 通过 `import.meta.dirname + 'public'` 解析静态资源。
 *
 * 用法：node scripts/build-plugin.mjs [--watch]
 */

import { context, build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

/** 宿主 DSH 提供的依赖，不打包进 bundle。 */
const external = [
  '@deepseek-ai/*',
  'node:*',
]

/**
 * One bundle per plugin: each must land in its own file so the cordis config
 * can import by absolute path. Sharing a bundle would force one plugin per
 * process or a multi-entry file with name prefixes.
 */
const targets = [
  { name: 'unwr-novel', entry: resolve(root, 'packages/novel/src/index.ts'), outfile: resolve(root, 'dist/unwr-novel.mjs') },
  { name: 'unwr-web',   entry: resolve(root, 'packages/web/src/plugin.ts'),  outfile: resolve(root, 'dist/unwr-web.mjs') },
]

const baseOptions = {
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

async function buildAll() {
  await Promise.all(targets.map(async (t) => {
    await mkdir(dirname(t.outfile), { recursive: true })
    await build({ ...baseOptions, entryPoints: [t.entry], outfile: t.outfile })
    console.log(`[unwr] built → ${t.outfile}`)
  }))
  // web 插件需要的静态资源：从 packages/web/public/ 拷到 dist/public/
  const publicSrc = resolve(root, 'packages/web/public')
  const publicDst = resolve(root, 'dist/public')
  await rm(publicDst, { recursive: true, force: true })
  await cp(publicSrc, publicDst, { recursive: true })
  console.log(`[unwr] copied → ${publicDst}`)
}

async function watchAll() {
  const contexts = await Promise.all(targets.map((t) => context({ ...baseOptions, entryPoints: [t.entry], outfile: t.outfile })))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log(`[unwr] watching ${targets.map((t) => t.outfile).join(', ')}`)
}

if (watch) {
  await watchAll()
} else {
  await buildAll()
}