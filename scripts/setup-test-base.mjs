/**
 * 一键为本地端到端测试准备环境。两块职责：
 *
 * A. 飞书测试库（域级 e2e 用，vitest 直接调工具函数，无 LLM）：
 *    1. 创建新 base（返回 base_token）→ 已存在则复用，--recreate 才新建
 *    2. 跑 initWork 一次性建齐 13 张表 + 字段 + 关联
 *    3. 把 token 写回 .env.local（不污染 .env）
 *
 * B. 智能体验收环境（--install-agent-profile）：
 *    安装/刷新 DSH headless profile 到 ~/.dsh/profiles/unwr-agent/，
 *    供 `node scripts/run-e2e.mjs --agent` 用「一次性任务」驱动真实 LLM
 *    完成一次小说写作。原理：dsh-headless bundle = 官方 one-shot runner
 *    （答一个任务、流式输出、退出），叠加 UnWr 插件层即可驱动 25 个
 *    novel_* 工具 + 7 个角色子代理。3080 端口的 web 实例无需参与。
 *
 * 设计原则：
 *   - **实测**：不 mock 任何飞书 API；每个 step 调 lark-cli 实跑
 *   - **幂等 + 干净**：默认复用现有（避免误删）；--recreate 才新建
 *   - **零个人路径**：canonical 配置用 __UNWR_ROOT__ 占位符，本脚本
 *     渲染时才内联真实路径（隐私红线，见 memory 78207951）
 *
 * 用法：
 *   node scripts/setup-test-base.mjs                          # A：复用现有
 *   node scripts/setup-test-base.mjs --recreate               # A：新建测试库
 *   node scripts/setup-test-base.mjs --space=<wiki_space_id>  # A：登记 UNWR_TEST_SPACE
 *   node scripts/setup-test-base.mjs --install-agent-profile  # B：安装 headless profile
 *   node scripts/setup-test-base.mjs --print                  # 只打印已有 token
 *
 * 依赖：lark-cli 已登录（lark-cli status）。
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envLocalPath = resolve(root, '.env.local')

const argv = process.argv.slice(2)
const args = new Set(argv)
const recreate = args.has('--recreate')
const printOnly = args.has('--print')
const installProfile = args.has('--install-agent-profile')
const nameArg = argv.find((a) => a.startsWith('--name='))
const baseName = nameArg ? nameArg.slice('--name='.length) : 'UnWr 测试库'
const spaceArg = argv.find((a) => a.startsWith('--space='))
const spaceToken = spaceArg ? spaceArg.slice('--space='.length) : undefined

const LARK_BIN = process.env.UNWR_LARK_BIN ?? 'lark-cli'

/** 直接调 lark-cli 而不走任何 wrapper。 */
function runLark(args, opts = {}) {
  const cmd = [LARK_BIN, ...args].map(String)
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    })
    return out
  } catch (e) {
    const stderr = e.stderr instanceof String ? e.stderr : String(e.stderr ?? '')
    const stdout = e.stdout instanceof String ? e.stdout : String(e.stdout ?? '')
    throw new Error(`lark-cli ${args.join(' ')} 失败:\n${stderr}\n${stdout}\n${e.message}`)
  }
}

/**
 * 读 .env.local（兼容 K=V 简单格式）。
 * 返回 { base, space }——历史上这里有个把 BASE 错映射成 space 键的 bug
 * （m.groupKey 恒为 undefined），导致「复用现有库」永不生效、每次跑都
 * 新建 base，已于 2026-09-02 修复。
 */
function readEnvLocal() {
  if (!existsSync(envLocalPath)) return {}
  const text = readFileSync(envLocalPath, 'utf8')
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*UNWR_TEST_(BASE|SPACE)\s*=\s*"?([^"\s#]+)"?\s*$/)
    if (m) out[m[1] === 'BASE' ? 'base' : 'space'] = m[2]
  }
  return out
}

/** 写 .env.local 的一个键（只覆盖该键，不动其他变量）。 */
function writeEnvKey(key, value) {
  let text = ''
  if (existsSync(envLocalPath)) text = readFileSync(envLocalPath, 'utf8')

  const line = `${key}=${value}`
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  if (re.test(text)) text = text.replace(re, line)
  else {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += `# 由 scripts/setup-test-base.mjs 自动维护\n${line}\n`
  }
  writeFileSync(envLocalPath, text, 'utf8')
  console.log(`[setup-test-base] 已写入 ${key} → ${envLocalPath}`)
}

/** lark-cli 没有 list base 命令；只能 create 或 get(按 token)。 */
function findExistingTestBase() {
  // 读 .env.local 现有的 token
  return readEnvLocal().base
}

/** lark-cli 没有删除 base 的命令；提示用户去飞书 UI 归档。 */
function disposeBase() {
  console.log('[setup-test-base] 注：lark-cli 没有 base 删除命令。')
  console.log('  请去飞书 UI 打开旧测试 base → 设置 → 删除。')
  console.log('  （不要在生产 base 上跑！新建的 base 也请在归档页面手动清理。）')
}

/** 建新 base。返回 token。 */
function createBase(name) {
  const out = runLark([
    'base', '+base-create',
    '--name', name,
    '--as', 'user',
    '--time-zone', 'Asia/Shanghai',
  ])
  const json = JSON.parse(out)
  const token = json?.data?.base?.base_token ?? json?.base?.base_token ?? json?.base_token ?? json?.token
  if (typeof token !== 'string' || token === '') {
    throw new Error(`+base-create 返回格式异常:\n${out.slice(0, 400)}`)
  }
  return token
}

/** 跑 schema 初始化脚本。 */
function initSchema(baseToken) {
  const cmd = ['node', '--import', 'tsx/esm',
    resolve(root, 'packages/schema/scripts/init-work.ts'),
    baseToken, '--sync-fields']
  const out = execFileSync(cmd[0], cmd.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(out)
}

// ─── B. headless profile 安装 ─────────────────────────────────────────

/** 路径中禁止出现的字符串集合（隐私红线，与 sync-cordis-patch.mjs 同规则）。 */
function forbiddenSubstrings() {
  const home = homedir()
  return [
    home,
    // 兼容其他用户名但目录是 /home/<user> 的情形
    ...(home.startsWith('/home/') ? [home.split('/').slice(0, 3).join('/')] : []),
  ]
}

const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** unwr-agent profile 的骨架：dsh-base 之上的官方 one-shot runner bundle。 */
const PROFILE_PACKAGE_JSON = {
  name: 'dsh-profile-unwr-agent',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      // dsh-headless = 官方一次性任务 bundle（无 Host/HTTP/浏览器层）：
      // `dsh --profile unwr-agent "<任务>"` → 跑完打印最终回复并退出。
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
      ],
    },
  },
}

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** 读取 canonical 配置并做隐私护栏校验（替换占位符之前）。 */
function readCanonical(relPath) {
  const src = resolve(root, relPath)
  if (!existsSync(src)) {
    throw new Error(`源文件不存在：${src}`)
  }
  const text = readFileSync(src, 'utf8')
  for (const fb of forbiddenSubstrings()) {
    if (fb && text.includes(fb)) {
      throw new Error(
        `${relPath} 含个人路径 "${fb}"。\n`
        + '  仓内配置必须用 __UNWR_ROOT__ 占位符，由脚本渲染时内联真实路径。',
      )
    }
  }
  return text
}

/**
 * 安装/刷新 ~/.dsh/profiles/unwr-agent/。
 *
 * patch 组成 = profiles/web/cordis.patch.yml 渲染（UnWr 插件层 + 7 个
 * 角色子代理，与 web 实例同一份 canonical，防止两处漂移）
 *          + profiles/agent/headless-overlay.yml 渲染（headless 专属覆盖）。
 *
 * 与 sync-cordis-patch.mjs 的关系：那个脚本服务 web profile（3080 实例），
 * 本函数服务验收 profile；两者读同一份 canonical，互不覆盖。
 */
function installAgentProfile() {
  // 仓库根：优先 UNWR_ROOT 环境变量（与 sync-cordis-patch 语义一致），
  // 缺省回退到脚本位置推导——两者一致，除非目录被移动过。
  const unwrRoot = resolve(process.env.UNWR_ROOT ?? root)

  const canonical = readCanonical('profiles/web/cordis.patch.yml')
  const overlay = readCanonical('profiles/agent/headless-overlay.yml')

  const render = (text) => text.replaceAll('__UNWR_ROOT__', unwrRoot)
  const patch = `${render(canonical).trimEnd()}\n\n${render(overlay).trimStart()}`

  const dir = join(homedir(), '.dsh', 'profiles', 'unwr-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(PROFILE_PACKAGE_JSON, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'cordis.yml'), PROFILE_ROOT_CONFIG, 'utf8')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE, 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), patch, 'utf8')

  console.log(`[setup-test-base] ✓ headless profile 已安装: ${dir}`)
  console.log(`[setup-test-base]   插件路径: ${join(unwrRoot, 'dist', 'unwr-novel.mjs')}`)
  console.log('[setup-test-base] 下一步：')
  console.log('  node scripts/build-plugin.mjs        # 确保 dist bundle 是最新')
  console.log('  node scripts/run-e2e.mjs --agent     # 驱动智能体写一次小说')
}

// ─── main ─────────────────────────────────────────────────────────────

async function main() {
  // B. 只装 profile，不碰飞书测试库
  if (installProfile) {
    installAgentProfile()
    return
  }

  // 仅打印模式
  if (printOnly) {
    const env = readEnvLocal()
    if (env.base === undefined) {
      console.log('(无) .env.local 未设置 UNWR_TEST_BASE')
      process.exit(0)
    }
    console.log(env.base)
    if (env.space !== undefined) console.log(`UNWR_TEST_SPACE=${env.space}`)
    return
  }

  // --space 单独登记（全流程域级 e2e 的跳过开关用它）
  if (spaceToken !== undefined) {
    writeEnvKey('UNWR_TEST_SPACE', spaceToken)
    if (!recreate && findExistingTestBase() !== undefined) return
  }

  // 1. 决定 token：复用 or 建新
  let baseToken = findExistingTestBase()
  if (baseToken !== undefined && !recreate) {
    console.log(`[setup-test-base] 复用现有测试 base: ${baseToken}`)
    console.log('[setup-test-base] （用 --recreate 重新建一个；当前 base 不会被删除）')
  } else {
    if (baseToken !== undefined && recreate) disposeBase()
    baseToken = createBase(baseName)
    console.log(`[setup-test-base] 新建测试 base: ${baseToken}`)
  }

  // 2. 跑 schema 初始化
  console.log('[setup-test-base] 初始化 13 张表 + 字段 + 关联...')
  initSchema(baseToken)

  // 3. 写 .env.local
  writeEnvKey('UNWR_TEST_BASE', baseToken)

  console.log()
  console.log('[setup-test-base] 完成。下一步：')
  console.log('  pnpm test:e2e              # 跑域级 e2e（自动读 .env.local）')
  console.log('  pnpm test                  # 跑所有 vitest，skipIf 检查')
  console.log('  pnpm test:agent            # 智能体写作 e2e（headless，无需测试库）')
}

await main()
