/**
 * 把仓内 profiles/web/cordis.patch.yml 同步到 ~/.dsh/profiles/web/cordis.patch.yml。
 *
 * 为何要脚本：DSH 配置文件按"用户层"放在 ~/.dsh 下，不入 git。
 * 该文件含 bundle 绝对路径，硬编码进仓会暴露个人目录，且无法跨机器复用。
 * 仓内文件用 `!!js | process.env.UNWR_ROOT` 表达式拼接路径——只要 sync 时
 * UNWR_ROOT 已 export，copy 即可，无需 envsubst 或模板。
 *
 * 本脚本只做一件事：单文件复制，含以下护栏：
 *   1. 校验仓内源文件**不含**当前用户的 home 路径（防回退：历史上有
 *      用户的 home 绝对路径被直接粘进 patch，污染了 git 历史与下游协作者
 *      配置；这条 guard 在 sync 时阻断此类回退——见 memory 78207951）
 *   2. 校验 process.env.UNWR_ROOT 已设置（patch 文件依赖此变量）
 *   3. 目标已存在且字节级一致 → 跳过
 *   4. 目标已存在但不一致 → 默认报错；--force 备份成 .bak 后覆盖
 *
 * 用法：
 *   export UNWR_ROOT=<仓库根绝对路径>
 *   node scripts/sync-cordis-patch.mjs           # 安全模式
 *   node scripts/sync-cordis-patch.mjs --force   # 覆盖（先备份）
 *
 * 同步完之后需重启 DSH 实例（配置改动不会热生效）。
 *
 * @module
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'profiles/web/cordis.patch.yml')

/** ~/.dsh/profiles/web/cordis.patch.yml —— 仓内文件的"实机"位置 */
const dst = resolve(
  homedir(),
  '.dsh',
  'profiles',
  'web',
  'cordis.patch.yml',
)

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

// ─── 1. source 必须存在 ─────────────────────────────────────────────
if (!existsSync(src)) {
  fail(`源文件不存在：${src}\n  漏提？git pull 一下`)
}

// ─── 2. source 内禁止带个人路径（防止 patch 文件被回退污染） ─────
const content = readFileSync(src, 'utf8')
for (const fb of FORBIDDEN_SUBSTRINGS) {
  if (!fb) continue
  if (content.includes(fb)) {
    fail(
      `源文件含个人路径 "${fb}"。\n` +
        `  仓内 profiles/web/cordis.patch.yml 必须用 process.env.UNWR_ROOT 拼接路径。\n` +
        `  修复方式：把硬编码绝对路径改成 cordis.yml 同款的 !!js | process.env.UNWR_ROOT 表达式。`,
    )
  }
}

// ─── 3. UNWR_ROOT 必须已设置（patch 文件依赖此变量） ─────────────
if (!process.env.UNWR_ROOT) {
  console.error('⚠ UNWR_ROOT 未设置。')
  console.error('  patch 文件用 `!!js | process.env.UNWR_ROOT` 拼接 bundle 路径，')
  console.error('  未设置时 DSH 加载时直接抛 "请先 export UNWR_ROOT=<仓库根>"。')
  if (!process.argv.includes('--skip-env-check')) {
    fail('必须先 export UNWR_ROOT=<仓库根>。加 --skip-env-check 跳过此检查（仅供排错）。')
  }
  console.warn('已跳过 UNWR_ROOT 检查。DSH 启动会失败，仅用于脚本自检。')
}

// ─── 4. 目标处理 ───────────────────────────────────────────────────
const force = process.argv.includes('--force')

if (existsSync(dst)) {
  const existing = readFileSync(dst, 'utf8')
  if (existing === content) {
    console.log(`✓ 已存在且一致：${dst}`)
    console.log('  无需修改。')
    process.exit(0)
  }
  if (!force) {
    fail(
      `目标已存在但与仓内版不一致：${dst}\n` +
        `  这通常是因为改了 home 副本，没同步回仓。\n` +
        `  解决办法：\n` +
        `    - 确认改动应该入仓 → 把 home 副本内容粘回 profiles/web/cordis.patch.yml 后重跑\n` +
        `    - 确认改动只是临时调试 → 加 --force 覆盖（目标会先备份成 .bak）`,
    )
  }
  copyFileSync(dst, dst + '.bak')
  console.log(`! 已备份: ${dst}.bak`)
}

copyFileSync(src, dst)
console.log(`✓ 已同步:`)
console.log(`    ${src}`)
console.log(`  → ${dst}`)
console.log()
console.log('提醒：')
console.log('  - 重启 DSH 实例使配置生效（cordis patch 不热重载）')
console.log(`  - 确认 UNWR_ROOT 已 export（当前值：${process.env.UNWR_ROOT ?? '未设置'}）`)
console.log('  - 启动日志出现 7 个 unwr-agent-* 插件即表示编排注册成功')
