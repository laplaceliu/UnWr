/**
 * 把 DSH 依赖指向本地 DSH 源码目录。
 *
 * 为什么需要：package.json 里的 `link:` 用相对路径，只在 DSH 源码与 UnWr
 * 同处 `github.com/` 目录时才成立。目录不同时需重新指向。
 *
 * 本脚本只做两件事：
 *   1. 校验目标目录确实是 DSH 源码（含 vendor/cordis 与 packages/core/tools）
 *   2. 在根 node_modules/@deepseek-ai/ 下重建符号链接
 *
 * 它**不修改 package.json**，因此不会把个人路径写回仓库。
 *
 * 用法：
 *   node scripts/setup-dsh-links.mjs <dsh-source-dir>
 *   DSH_ROOT=<dir> node scripts/setup-dsh-links.mjs
 * @module
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, readlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? process.env.DSH_ROOT

if (target === undefined || target === '') {
  console.error('用法: node scripts/setup-dsh-links.mjs <dsh-source-dir>')
  console.error('  或: DSH_ROOT=<dir> node scripts/setup-dsh-links.mjs')
  process.exit(1)
}

const dshRoot = resolve(target)

/** 期望存在的关键路径，用于确认这确实是 DSH 源码目录。 */
const REQUIRED = [
  ['vendor/cordis', '@deepseek-ai/cordis'],
  ['packages/core/tools', '@deepseek-ai/dsh-tools'],
]

for (const [rel] of REQUIRED) {
  if (!existsSync(resolve(dshRoot, rel))) {
    console.error(`✗ 目标目录不是 DSH 源码：缺少 ${rel}`)
    console.error(`  给定: ${dshRoot}`)
    process.exit(1)
  }
}

const scopeDir = resolve(root, 'node_modules/@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })

for (const [rel, pkgName] of REQUIRED) {
  const src = resolve(dshRoot, rel)
  const dst = resolve(scopeDir, pkgName)
  if (existsSync(dst) || (() => { try { readlinkSync(dst); return true } catch { return false } })()) {
    rmSync(dst, { recursive: true, force: true })
  }
  symlinkSync(src, dst, 'dir')
  console.log(`✓ ${pkgName} → ${src}`)
}

console.log(`\n完成。DSH 源码: ${dshRoot}`)
console.log('注意：本脚本不修改 package.json，个人路径不会写入仓库。')
