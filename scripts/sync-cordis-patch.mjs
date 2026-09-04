/**
 * 把仓内的占位符配置生成为「源码版 DSH」的 --patch overlay（含真实绝对路径）。
 *
 * 产物（已脱离 git）：
 *   <root>/dist/cordis.local.yml —— 源码版 DSH 启动用：
 *     pnpm dsh web --patch <UNWR_ROOT>/dist/cordis.local.yml --port 3082
 *
 * 为何要脚本：DSH 要求插件 name 是可直接 import 的字符串，而 loader
 * （cordis-plugin-loader >= 1.0.3）只对 config / disabled 字段做 `!!js`
 * 求值，name 字段不求值——在 YAML 里写 `!!js` 拼路径会报
 * "name.startsWith is not a function"（实机踩坑 2026-09-02）。
 * 因此仓内 canonical 用占位符 __UNWR_ROOT__（保持零个人路径，隐私红线
 * memory 78207951），由本脚本在生成时内联真实路径。
 *
 * 曾有第二个产物 ~/.dsh/profiles/web/cordis.patch.yml（npx 安装版 DSH 的
 * home 副本），已随 npm 组合包发布流（scripts/build-publish.mjs）退休：
 * 组合包自带 insert 全部插件行的 patch，home 层再 insert 同 id 行会报
 * "duplicate loader entry id"（实机踩坑 2026-09-04）。home 层现在是
 * 用户自有文件，只允许放按 id 覆盖行——本脚本不再写它。
 *
 * 护栏：
 *   1. canonical 源文件**禁止**含个人 home 路径（防回退污染）
 *   2. UNWR_ROOT 必须已设置（占位符替换依赖它）；--skip-env-check 仅供排错
 *   3. 目标已存在且一致 → 跳过
 *   4. 目标已存在但不一致 → 默认报错；--force 备份 .bak 后覆盖
 *
 * 用法：
 *   export UNWR_ROOT=<仓库根绝对路径>
 *   pnpm sync:patch            # 等价于 node scripts/sync-cordis-patch.mjs
 *   pnpm sync:patch -- --force # 覆盖（先备份）
 *
 * 同步完之后需重启 DSH 实例（配置改动不会热生效）。
 *
 * @module
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 占位符 → 实机副本的映射：源文件 → 生成目标。 */
const TARGETS = [
  {
    src: resolve(root, 'cordis.yml'),
    dst: resolve(root, 'dist', 'cordis.local.yml'),
  },
]

/** 路径中禁止出现的字符串集合（隐私红线，见 memory 78207951） */
const home = homedir()
const FORBIDDEN_SUBSTRINGS = [
  home,
  // 兼容用户使用了其他用户名但目录是 /home/<user> 的情形
  ...(home.startsWith('/home/') ? [home.split('/').slice(0, 3).join('/')] : []),
]

function fail(msg, code = 1) {
  console.error('✗ ' + msg)
  process.exit(code)
}

// ─── 1. UNWR_ROOT 必须已设置（占位符替换依赖它） ────────────────────
const unwrRoot = process.env.UNWR_ROOT
if (!unwrRoot) {
  console.error('⚠ UNWR_ROOT 未设置。')
  console.error('  canonical 配置用 __UNWR_ROOT__ 占位符，本脚本要把它替换成仓库绝对路径。')
  if (!process.argv.includes('--skip-env-check')) {
    fail('必须先 export UNWR_ROOT=<仓库根>。加 --skip-env-check 跳过此检查（仅供排错）。')
  }
  console.warn('已跳过 UNWR_ROOT 检查：占位符将原样保留，DSH 启动会失败，仅用于脚本自检。')
}
const absoluteRoot = unwrRoot !== undefined ? resolve(unwrRoot) : '__UNWR_ROOT__'

const force = process.argv.includes('--force')
let synced = 0

for (const { src, dst } of TARGETS) {
  // ─── 2. source 必须存在 ────────────────────────────────────────────
  if (!existsSync(src)) {
    fail(`源文件不存在：${src}\n  漏提？git pull 一下`)
  }

  // ─── 3. source 内禁止带个人路径（防回退污染，替换前检查） ──────────
  const canonical = readFileSync(src, 'utf8')
  for (const fb of FORBIDDEN_SUBSTRINGS) {
    if (!fb) continue
    if (canonical.includes(fb)) {
      fail(
        `源文件含个人路径 "${fb}"。\n` +
        `  仓内配置必须用 __UNWR_ROOT__ 占位符，由本脚本在生成时内联真实路径。`,
      )
    }
  }

  // ─── 4. 占位符替换 → 实机内容 ─────────────────────────────────────
  if (!canonical.includes('__UNWR_ROOT__')) {
    fail(`源文件不含 __UNWR_ROOT__ 占位符：${src}\n  name 必须由占位符提供绝对路径，见文件头注释。`)
  }
  const rendered = canonical.replaceAll('__UNWR_ROOT__', absoluteRoot)

  // ─── 5. 目标处理 ──────────────────────────────────────────────────
  if (existsSync(dst)) {
    const existing = readFileSync(dst, 'utf8')
    if (existing === rendered) {
      console.log(`✓ 已存在且一致：${dst}`)
      continue
    }
    if (!force) {
      fail(
        `目标已存在但与生成结果不一致：${dst}\n` +
        `  这通常是因为改了实机副本，没同步回仓。\n` +
        `  解决办法：\n` +
        `    - 确认改动应该入仓 → 把实机副本内容粘回对应 canonical 后重跑\n` +
        `    - 确认改动只是临时调试 → 加 --force 覆盖（目标会先备份成 .bak）`,
      )
    }
    copyFileSync(dst, dst + '.bak')
    console.log(`! 已备份: ${dst}.bak`)
  }

  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, rendered)
  synced++
  console.log(`✓ 已生成: ${dst}`)
}

console.log()
if (synced > 0) {
  console.log('提醒：')
  console.log('  - 重启 DSH 实例使配置生效（cordis patch 不热重载）')
  console.log(`  - UNWR_ROOT 当前值：${absoluteRoot}`)
  console.log('  - 启动日志出现 7 个 unwr-agent-* 插件即表示编排注册成功')
} else {
  console.log('全部产物已是最新，无需重启。')
}
