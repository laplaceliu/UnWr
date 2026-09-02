/**
 * 本地端到端测试入口。两种模式：
 *
 * A. 域级 e2e（默认）：跑 vitest——直接调用工具函数，无 LLM 参与。
 *    - 从 .env.local 读 UNWR_TEST_BASE；缺失则提示运行 setup
 *    - 只跑 *.e2e.spec.ts 与 describe.skipIf(!HAS_BASE) 这两类
 *    - **串行** + 关闭并发：飞书 QPS 限制；e2e 操作共享同一个测试 base
 *    - 输出落到 e2e-results/<时间戳>/
 *
 * B. 智能体写作 e2e（--agent）：驱动**真实 LLM** 完成一次小说写作。
 *    用官方 dsh-headless bundle（一次性任务：答一个任务、流式输出、退出）
 *    加载 unwr-agent profile（dsh-base + dsh-headless + UnWr 插件层 +
 *    7 个角色子代理）。跑完后自动对飞书落库结果做结构验收。
 *    不需要 playwright，也不需要 3080 端口的 web 实例。
 *
 *    链路：build bundle → 安装 profile → `dsh --profile unwr-agent "<任务>"`
 *    → 提取 UNWR_WORK_BASE → agent-verify 验收 → report.md
 *
 * 用法：
 *   pnpm test:e2e                     # A：跑所有域级 e2e
 *   pnpm test:e2e -- packages/novel/tests/chapter.spec.ts   # A：单文件
 *   pnpm test:agent                   # B：智能体写作 e2e
 *   node scripts/run-e2e.mjs --agent --timeout-minutes=40 --min-words=1200
 *
 * B 模式选项：
 *   --task="<任务文本>"        覆盖默认任务
 *   --task-file=<路径>         从文件读任务（相对仓库根）
 *   --work-name=<名字>         覆盖默认作品名（默认 雾锁长街-e2e<stamp>）
 *   --min-words=<N>            验收字数阈值（默认 800）
 *   --timeout-minutes=<N>      智能体超时（默认 30）
 *   --skip-build / --skip-profile / --skip-verify   跳过对应阶段
 *
 * @module
 */

import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envLocalPath = resolve(root, '.env.local')

/** 读 .env.local（仅简单 K=V 格式）。 */
function readEnvLocal() {
  if (!existsSync(envLocalPath)) return {}
  const text = readFileSync(envLocalPath, 'utf8')
  const out = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*UNWR_TEST_(BASE|SPACE)\s*=\s*"?([^"\s#]+)"?\s*$/)
    if (m) out[m[1] === 'BASE' ? 'UNWR_TEST_BASE' : 'UNWR_TEST_SPACE'] = m[2]
  }
  return out
}

// ─── 参数 ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const agentMode = argv.includes('--agent')
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit !== undefined ? hit.slice(name.length + 3) : dflt
}
const flag = (name) => argv.includes(`--${name}`)

// ══════════════════════════════════════════════════════════════════════
// A. 域级 e2e（vitest）
// ══════════════════════════════════════════════════════════════════════

async function runDomainE2E() {
  const env = { ...process.env, ...readEnvLocal() }

  if (!env.UNWR_TEST_BASE) {
    console.error('[test:e2e] 未设置 UNWR_TEST_BASE。')
    console.error('  → 先跑: pnpm test:setup-base')
    console.error('  → 或手动: 在 .env.local 加 UNWR_TEST_BASE=<飞书 base_token>')
    console.error('  → 或跳过 e2e: pnpm test（vitest 会自动 skipIf）')
    console.error('  → 或跑智能体验收（无需测试库）: pnpm test:agent')
    process.exit(2)
  }

  console.log(`[test:e2e] UNWR_TEST_BASE=${env.UNWR_TEST_BASE.slice(0, 8)}...`)
  console.log(`[test:e2e] UNWR_TEST_SPACE=${env.UNWR_TEST_SPACE ?? '(未设置)'}`)
  console.log('[test:e2e] 注：e2e 会真实调用飞书。请勿在生产 base 上跑。')

  // 时间戳目录
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const resultDir = resolve(root, `e2e-results/${stamp}`)
  mkdirSync(resultDir, { recursive: true })
  console.log(`[test:e2e] 结果输出: ${resultDir}`)

  // 调用 vitest，透传 args。node_modules/.bin/vitest 是 shell 脚本，必须 spawn sh。
  const finalArgs = ['run', '--reporter=verbose', ...argv]
  const code = await new Promise((res) => {
    const child = spawn(
      'sh',
      [resolve(root, 'node_modules/.bin/vitest'), ...finalArgs],
      { stdio: ['ignore', 'inherit', 'inherit'], env },
    )
    child.on('exit', (c) => res(c ?? 1))
    child.on('error', (e) => {
      console.error(`[test:e2e] vitest 启动失败: ${e.message}`)
      res(1)
    })
  })
  process.exit(code)
}

// ══════════════════════════════════════════════════════════════════════
// B. 智能体写作 e2e（headless one-shot）
// ══════════════════════════════════════════════════════════════════════

/** 解析 dsh 可执行入口。优先级：UNWR_DSH_BIN > PATH > npx 缓存 > npm exec。 */
function resolveDsh() {
  if (process.env.UNWR_DSH_BIN !== undefined && process.env.UNWR_DSH_BIN !== '') {
    return { cmd: process.env.UNWR_DSH_BIN, prefix: [] }
  }
  try {
    execFileSync('which', ['dsh'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return { cmd: 'dsh', prefix: [] }
  } catch {
    // PATH 里没有，继续找 npx 缓存
  }
  try {
    const npxDir = join(homedir(), '.npm', '_npx')
    for (const entry of readdirSync(npxDir)) {
      const bin = join(npxDir, entry, 'node_modules', '.bin', 'dsh')
      if (existsSync(bin)) return { cmd: bin, prefix: [] }
    }
  } catch {
    // 没有 npx 缓存
  }
  // 兜底：npm exec 现场拉起（慢，但一定能用）
  return { cmd: 'npm', prefix: ['exec', '--yes', '@deepseek-ai/dsh', '--'] }
}

/** 默认任务：一次完整的最小写作闭环（无人值守）。 */
function defaultTask(workName) {
  return `这是 UnWr 插件的无人值守端到端验收，你的写作模式是全自动。请依次完成：
1. 用 novel_manage_work(action=create) 新建作品《${workName}》：题材=类型小说，子题材=都市悬疑，规模=中长篇，目标字数=200000，叙事视角=第三人称限知，写作模式=全自动。
2. 委托设定官创建至少 3 条世界观设定（覆盖城市地点、组织势力、规则各至少一条）。
3. 委托人物官创建至少 2 名主要人物（性格标签、口癖、核心动机齐全），并建立 1 条人物关系。
4. 委托大纲官：建第一卷（卷主题自拟，起止章节 1-3），写第 1、2、3 章的章纲，登记至少 1 条伏笔（状态=已埋设，重要度≥4）和 1 条主线剧情线。
5. 委托起草官写第 1 章：正文不少于 1200 字，用 ## 划分场景、不写 # 一级标题，按题材预设控制对话比例与章末钩子，用 novel_write_chapter 落库。
6. 确认第 1 章记忆沉淀完成：章节摘要（novel_update_summary）、每个出场人物的章末状态（novel_record_character_state）、关键事件（novel_record_event）。
7. 跑一次 novel_run_consistency_check。
硬性约束：全程自动，绝不向用户提问；正文只写进飞书文档，绝不把整章正文贴在回复里。
最后输出简明验收报告：每个步骤的结果、第 1 章实际字数、一致性问题数量；最后一行必须是 UNWR_WORK_BASE=<该作品的 base_token>。`
}

/** 跑一个子进程直到退出，stdout/stderr 原样继承。返回退出码。 */
function runInherit(cmd, args, env) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: root, env })
    p.on('exit', (c) => res(c ?? 1))
    p.on('error', (e) => {
      console.error(`[agent-e2e] ${cmd} 启动失败: ${e.message}`)
      res(1)
    })
  })
}

async function runAgentE2E() {
  const env = { ...process.env, ...readEnvLocal() }
  // headless 无 UI：放开审批（否则沙箱审批在无界面进程里无人应答）；
  // 测试运行不上传遥测。
  env.DSH_PERMISSION_MODE = 'danger-full-access'
  env.DSH_TELEMETRY_DISABLED = '1'

  const skipBuild = flag('skip-build')
  const skipProfile = flag('skip-profile')
  const skipVerify = flag('skip-verify')
  const minWords = Number(opt('min-words', '800')) || 800
  const timeoutMinutes = Number(opt('timeout-minutes', '30')) || 30

  const stamp = Date.now().toString(36)
  const workName = opt('work-name', `雾锁长街-e2e${stamp}`)
  const resultDir = resolve(root, `e2e-results/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-agent`)
  mkdirSync(resultDir, { recursive: true })
  console.log(`[agent-e2e] 结果目录: ${resultDir}`)

  // ── 1. 构建 bundle ──
  if (!skipBuild) {
    console.log('[agent-e2e] 1/5 构建 dist/unwr-novel.mjs ...')
    const code = await runInherit('node', [resolve(root, 'scripts/build-plugin.mjs')], env)
    if (code !== 0) process.exit(code)
  } else {
    console.log('[agent-e2e] 1/5 跳过构建（--skip-build）')
  }

  // ── 2. 安装 profile ──
  if (!skipProfile) {
    console.log('[agent-e2e] 2/5 安装 headless profile（~/.dsh/profiles/unwr-agent）...')
    const code = await runInherit('node', [resolve(root, 'scripts/setup-test-base.mjs'), '--install-agent-profile'], env)
    if (code !== 0) process.exit(code)
  } else {
    console.log('[agent-e2e] 2/5 跳过 profile 安装（--skip-profile）')
  }

  // ── 3. 任务文本 ──
  const taskFile = opt('task-file', '')
  const taskArg = opt('task', '')
  const task = taskFile !== ''
    ? readFileSync(resolve(root, taskFile), 'utf8')
    : taskArg !== '' ? taskArg : defaultTask(workName)
  writeFileSync(join(resultDir, 'task.md'), task, 'utf8')

  // ── 4. 驱动智能体 ──
  const dsh = resolveDsh()
  const dshArgs = [...dsh.prefix, '--profile', 'unwr-agent', task]
  console.log(`[agent-e2e] 3/5 启动智能体: ${dsh.cmd} ${[...dsh.prefix, '--profile', 'unwr-agent'].join(' ')} "<任务 ${task.length} 字符>"`)
  console.log('[agent-e2e]    模型与密钥来自 ~/.dsh/settings.yaml 与 ~/.dsh/.credentials.yaml（与 3080 web 实例同源）')
  console.log(`[agent-e2e]    超时 ${timeoutMinutes} 分钟；stderr 实时透出推理流；最终报告在 stdout 结束后打印`)

  const stdoutPath = join(resultDir, 'stdout.txt')
  const stderrPath = join(resultDir, 'stderr.log')
  let stdoutBuf = ''
  let stderrBytes = 0

  const child = spawn(dsh.cmd, dshArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk
    writeFileSync(stdoutPath, stdoutBuf, 'utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    process.stderr.write(chunk) // 推理流实时透出，方便盯进度
    appendFileSync(stderrPath, chunk)
  })

  const startedAt = Date.now()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(`\n[agent-e2e] ✗ 超过 ${timeoutMinutes} 分钟，SIGTERM 终止（10s 后 SIGKILL）`)
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 10_000)
  }, timeoutMinutes * 60_000)

  const heartbeat = setInterval(() => {
    const s = Math.round((Date.now() - startedAt) / 1000)
    console.log(`[agent-e2e] ⏱ ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s 运行中（stdout ${stdoutBuf.length}B / stderr ${stderrBytes}B）…`)
  }, 30_000)

  const agentCode = await new Promise((res) => {
    child.on('exit', (code) => res(code ?? -1))
    child.on('error', (e) => {
      console.error(`[agent-e2e] dsh 启动失败: ${e.message}`)
      res(-1)
    })
  })
  clearTimeout(timer)
  clearInterval(heartbeat)

  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.log(`\n[agent-e2e] 4/5 智能体退出：code=${agentCode}（用时 ${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s${timedOut ? '，超时截断' : ''}）`)

  // 最终报告（stdout = 智能体最后一条助手消息）
  const report = stdoutBuf.trim()
  if (report !== '') {
    console.log('────── 智能体最终报告 ──────')
    console.log(report)
    console.log('────────────────────────────')
  } else {
    console.log('[agent-e2e] ⚠ 智能体没有输出最终消息（详见 stderr.log）')
  }

  // ── 5. 验收：只信飞书落库，不信口头报告 ──
  const tokenMatch = report.match(/UNWR_WORK_BASE[=：:\s]*([A-Za-z0-9]{10,})/)
  const baseToken = tokenMatch?.[1] ?? ''
  let verifyOk = false
  let verifyJson = null

  if (skipVerify) {
    console.log('[agent-e2e] 5/5 跳过验收（--skip-verify）')
    verifyOk = agentCode === 0
  } else if (baseToken === '') {
    console.error('[agent-e2e] 5/5 ✗ 未能从智能体报告中提取 UNWR_WORK_BASE——')
    console.error('  若报告显示流程未走完，先看 stderr.log / stdout.txt 排查；')
    console.error('  若作品其实已建好，可手动验收：')
    console.error(`    node --import tsx/esm packages/novel/scripts/agent-verify.ts <baseToken> --expect-name=${workName}`)
  } else {
    console.log(`[agent-e2e] 5/5 对飞书落库做结构验收：base=${baseToken}`)
    const v = spawn('node', [
      '--import', 'tsx/esm',
      resolve(root, 'packages/novel/scripts/agent-verify.ts'),
      baseToken,
      `--min-words=${minWords}`,
      `--expect-name=${workName}`,
      '--chapter=1',
    ], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })

    let vOut = ''
    v.stdout.on('data', (c) => { vOut += c })
    const vCode = await new Promise((res) => {
      v.on('exit', (c) => res(c ?? -1))
      v.on('error', (e) => {
        console.error(`[agent-e2e] verify 启动失败: ${e.message}`)
        res(-1)
      })
    })
    verifyOk = vCode === 0
    const jsonStart = vOut.lastIndexOf('<<<AGENT_VERIFY_JSON>>>')
    if (jsonStart >= 0) {
      try { verifyJson = JSON.parse(vOut.slice(jsonStart + '<<<AGENT_VERIFY_JSON>>>'.length)) } catch { /* 落盘原始文本 */ }
    }
    writeFileSync(join(resultDir, 'verify.json'), verifyJson !== null ? JSON.stringify(verifyJson, null, 2) : vOut, 'utf8')
  }

  // ── 汇总报告 ──
  const lines = [
    '# UnWr 智能体写作 e2e 报告',
    '',
    `- 时间: ${new Date().toISOString()}`,
    `- 作品名: 《${workName}》`,
    `- 智能体退出码: ${agentCode}${timedOut ? '（超时截断）' : ''}`,
    `- 用时: ${elapsed}s`,
    `- 作品 base: ${baseToken === '' ? '（未提取到）' : baseToken}`,
    `- 落库验收: ${skipVerify ? '（跳过）' : verifyOk ? '✓ 通过' : '✗ 未通过'}`,
    '',
    '## 智能体最终报告',
    '',
    '```',
    report !== '' ? report : '（空——智能体没有输出最终消息）',
    '```',
    '',
    '## 产物',
    '',
    `- task.md / stdout.txt / stderr.log${verifyJson !== null ? ' / verify.json' : ''}`,
  ]
  writeFileSync(join(resultDir, 'report.md'), lines.join('\n') + '\n', 'utf8')
  console.log(`[agent-e2e] 报告: ${join(resultDir, 'report.md')}`)

  const ok = agentCode === 0 && (skipVerify || verifyOk)
  console.log(ok ? '[agent-e2e] ✓ 全部通过' : '[agent-e2e] ✗ 存在失败项（见上）')
  process.exit(ok ? 0 : 1)
}

// ─── 入口 ─────────────────────────────────────────────────────────────

if (!agentMode) {
  await runDomainE2E()
} else {
  await runAgentE2E().catch((e) => {
    console.error(`[agent-e2e] 异常退出: ${e instanceof Error ? e.stack : String(e)}`)
    process.exit(1)
  })
}
