/**
 * 打包 UnWr 为 DSH 组合包（bundle）tarball —— tarball 分发通道。
 *
 * 产物：dist/unwr-<version>.tgz（零构建授权，用户侧一条命令安装）：
 *   dsh plugin --profile <name> add ./unwr-<version>.tgz
 *
 * 流程：
 *   1. pnpm build            产出根 dist/（unwr-novel.mjs / unwr-web.mjs / public/）
 *   2. verify:bundle         真实导出层验证 bundle 可加载并注册工具
 *   3. 组装 packages/plugin/dist/ —— 发布内容自包含（files 只引用包内路径）
 *   4. 生成 packages/plugin/cordis.patch.yml
 *      单一真源仍是 profiles/web/cordis.patch.yml，本脚本做三处**发布态改写**：
 *      a) 头部注释 → bundle 层语义
 *      b) __UNWR_ROOT__ 绝对路径引用 → 包名引用 unwr/dist/...
 *         （组合包安装后由 Node 模块解析定位，无需绝对路径——这正是
 *         开发态占位符 + sync-cordis-patch.mjs 机制在发布侧退休的原因）
 *      c) verbose: true → false（发布默认降噪，用户可按 id 覆盖整行开启）
 *      源文件结构变化导致锚点失配时**硬失败**，防止静默产出错误 patch。
 *   5. 隐私红线扫描 —— dist 文本文件与 patch 中禁止出现个人 home 路径
 *      （memory 78207951：发布物同样适用，不仅是仓库）
 *   6. pnpm pack → dist/unwr-<version>.tgz + 内容清单校验
 *
 * 用法：pnpm pack:plugin（等价 node scripts/build-publish.mjs）
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = resolve(root, 'packages/plugin')
const pluginDist = resolve(pluginDir, 'dist')
const rootDist = resolve(root, 'dist')
const srcPatchPath = resolve(root, 'profiles/web/cordis.patch.yml')
const dstPatchPath = resolve(pluginDir, 'cordis.patch.yml')

function fail(msg) {
  console.error('\n✗ ' + msg)
  process.exit(1)
}
function step(n, msg) {
  console.log(`\n── [${n}/6] ${msg}`)
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 退出码 ${r.status}`)
}
/** 断言出现次数后替换（防止上游文件结构漂移时静默产出错误 patch） */
function replaceN(str, from, to, expect, label) {
  const n = str.split(from).length - 1
  if (n !== expect) {
    fail(`发布态改写失配：${label}（"${from}" 出现 ${n} 次，预期 ${expect}）。profiles/web/cordis.patch.yml 结构变化，请同步更新本脚本的锚点。`)
  }
  return str.split(from).join(to)
}

// ─── 发布包清单与版本一致性 ─────────────────────────────────────────
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
/** 发布包名（含 scope）。组合包 patch 的插件行按它引用——改名只需动 package.json。 */
const pkgName = pluginPkg.name
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pluginPkg.version !== rootPkg.version) {
  fail(`版本不一致：根 package.json=${rootPkg.version}，packages/plugin=${pluginPkg.version}。发布前请同步 bump 两处。`)
}
if (!pluginPkg.dsh?.bundle?.patch) {
  fail('packages/plugin/package.json 缺少 dsh.bundle 声明——没有它 dsh plugin 只会当作普通依赖安装，不激活任何层。')
}

// ─── 1. 构建 ────────────────────────────────────────────────────────
step(1, 'pnpm build（esbuild 打包 novel / web 两个 bundle + 拷贝 public）')
run('node', ['scripts/build-plugin.mjs'])

// ─── 2. bundle 可加载验证 ───────────────────────────────────────────
step(2, 'verify:bundle（真实导出层验证注册逻辑）')
run('node', ['scripts/verify-bundle.mjs'])

// ─── 3. 组装发布包 dist ─────────────────────────────────────────────
step(3, '组装 packages/plugin/dist/')
rmSync(pluginDist, { recursive: true, force: true })
mkdirSync(pluginDist, { recursive: true })
for (const f of ['unwr-novel.mjs', 'unwr-web.mjs']) {
  if (!existsSync(join(rootDist, f))) fail(`根 dist 缺少 ${f}，构建疑似失败`)
  cpSync(join(rootDist, f), join(pluginDist, f))
}
cpSync(resolve(rootDist, 'public'), resolve(pluginDist, 'public'), { recursive: true })
console.log(`[unwr] assembled → ${pluginDist}`)

// ─── 4. 生成 bundle patch ───────────────────────────────────────────
step(4, '生成 packages/plugin/cordis.patch.yml（发布态改写）')

const BUNDLE_HEADER = `# UnWr —— DeepSeek Harness 组合包（bundle）配置层。
#
# 本文件由 scripts/build-publish.mjs 从 profiles/web/cordis.patch.yml 生成，
# 请勿手工编辑；persona / toolFilter 的修改请编辑源文件后重新 pnpm pack:plugin。
#
# 层序：本层属于 profile 的 bundles 列表（最早应用），之后依次是
#   profile 自己的 cordis.patch.yml → home 级 cordis.patch.yml → --patch overlay。
# 用户可在自己 profile 的 cordis.patch.yml 里按 id 覆盖任何行——patch 按行胜出、
# **整行替换 config（不深度合并）**，覆盖时必须重述该行需要的每一个键。
#
# 插件行 name 按包名引用（${pkgName}/dist/...）：组合包安装进 profile 后由
# Node 模块解析定位，无需绝对路径。与开发态相同，name 必须是纯字符串
# （cordis-plugin-loader >= 1.0.3 只对 config / disabled 字段做 !!js 求值）。
#
# 默认值策略：readOnlySafeMode=true（不注册删除类工具）；verbose=false
# （发布降噪，需要加载期工具清单时按 id 覆盖 unwr-novel 行开启）。
`

const TOOL_COMMENT_BLOCK = `    # ---------- 领域工具 ----------
    # name 按包名引用（${pkgName}/dist/...）：组合包安装后由 Node 模块解析定位，
    # 无需绝对路径——这是与开发态（占位符 + sync 脚本）最大的差异。
`

const srcPatch = readFileSync(srcPatchPath, 'utf8')
let patchLines = srcPatch.split('\n')

const insertIdx = patchLines.findIndex((l) => l === '- insert:')
if (insertIdx < 0) fail('profiles/web/cordis.patch.yml 找不到 "- insert:" 锚点')

const blkStart = patchLines.findIndex((l) => l.includes('# ---------- 领域工具'))
const blkEnd = patchLines.findIndex((l) => l.includes('name.startsWith is not a function'))
if (blkStart < 0 || blkEnd < 0 || blkEnd < blkStart || blkStart <= insertIdx) {
  fail('领域工具注释块锚点失配，请同步更新 build-publish.mjs 的定位逻辑')
}
patchLines.splice(blkStart, blkEnd - blkStart + 1, ...TOOL_COMMENT_BLOCK.replace(/\n$/, '').split('\n'))
patchLines.splice(0, insertIdx, ...BUNDLE_HEADER.split('\n'))

let out = patchLines.join('\n')
out = replaceN(out, '__UNWR_ROOT__/dist/unwr-novel.mjs', `${pkgName}/dist/unwr-novel.mjs`, 1, 'novel 插件行')
out = replaceN(out, '__UNWR_ROOT__/dist/unwr-web.mjs', `${pkgName}/dist/unwr-web.mjs`, 1, 'web 插件行')
out = replaceN(out, '        verbose: true', '        verbose: false', 1, 'verbose 开关')

// 只检测**残留的占位符路径引用**（插件行/说明性注释提及占位符名不算失败）
if (out.includes('__UNWR_ROOT__/dist/')) fail('生成的 bundle patch 仍含占位符路径引用，改写不完整')
// 源文件为混合 CRLF 行尾，归一化为 LF，保证发布产物跨平台稳定
out = out.replace(/\r\n/g, '\n')

const REQUIRED_IDS = [
  'unwr-novel',
  'unwr-web',
  'unwr-agent-worldkeeper',
  'unwr-agent-characterkeeper',
  'unwr-agent-outliner',
  'unwr-agent-drafter',
  'unwr-agent-reviser',
  'unwr-agent-critic',
  'unwr-agent-rescuer',
]
for (const id of REQUIRED_IDS) {
  if (!out.includes(`id: ${id}`)) fail(`生成的 bundle patch 缺少 id: ${id}`)
}

writeFileSync(dstPatchPath, out)
console.log(`[unwr] patch → ${dstPatchPath}（${REQUIRED_IDS.length} 行插件定义）`)

// ─── 5. 隐私红线扫描 ────────────────────────────────────────────────
step(5, '隐私红线扫描（发布物禁止出现个人 home 路径）')

const home = homedir()
const FORBIDDEN = [
  home,
  // 兼容其他用户名但同为 /home/<user> 布局的情形（与 sync-cordis-patch.mjs 同逻辑）
  ...(home.startsWith('/home/') ? [home.split('/').slice(0, 3).join('/')] : []),
]
const TEXT_EXT = new Set(['.mjs', '.js', '.ts', '.yml', '.yaml', '.json', '.html', '.css', '.txt', '.md'])

function* walkFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkFiles(p)
    else yield p
  }
}

const offenders = []
const scanFile = (f) => {
  if (!TEXT_EXT.has(extname(f))) return
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const s of FORBIDDEN) {
      if (line.includes(s)) offenders.push(`${f}:${i + 1}`)
    }
  })
}
for (const f of walkFiles(pluginDist)) scanFile(f)
scanFile(dstPatchPath)
if (offenders.length > 0) {
  fail(`隐私红线命中（发布物禁含个人 home 路径）：\n  ${offenders.join('\n  ')}`)
}
console.log('[unwr] 隐私扫描通过（0 命中）')

// ─── 6. pnpm pack ───────────────────────────────────────────────────
step(6, 'pnpm pack → dist/unwr-<version>.tgz')
run('pnpm', ['pack', '--pack-destination', rootDist], { cwd: pluginDir })

// pnpm pack 产物文件名：@scope/name → scope-name-version.tgz
const tgzName = `${pkgName.replace(/^@/, '').replace('/', '-')}-${pluginPkg.version}.tgz`
const tgz = resolve(rootDist, tgzName)
if (!existsSync(tgz)) fail(`未找到产物 ${tgz}（pnpm pack 输出名与预期不符？）`)

const tar = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
if (tar.status !== 0) fail(`tar -tzf 校验失败：${tar.stderr}`)
const listing = tar.stdout
for (const need of ['package/dist/unwr-novel.mjs', 'package/dist/unwr-web.mjs', 'package/cordis.patch.yml']) {
  if (!listing.includes(need)) fail(`tgz 缺少 ${need}`)
}
if (!listing.split('\n').some((l) => l.startsWith('package/dist/public/'))) {
  fail('tgz 缺少 dist/public/（工作台静态资源）')
}

console.log(`
✓ 打包完成：${tgz}

用户侧安装（tarball 通道，零构建授权）：
  dsh plugin --profile <profile> add ${tgz}
npm 通道（包已发布时）：
  dsh plugin --profile <profile> add ${pkgName}
验证与启动：
  dsh --profile <profile> --dump-config            # 确认出现 unwr* 层
  npx @deepseek-ai/dsh --profile <profile> web     # 注意：--profile 在子命令前

后续版本迭代：同步 bump 根 package.json 与 packages/plugin/package.json 的 version。`)
