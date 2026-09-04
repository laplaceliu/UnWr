/**
 * work-context-injector —— 委托子代理时自动注入 workToken/workName。
 *
 * 起因（实机 2026-09-04）：
 *   主会话委托 `novel_agent_outliner` 规划第 4-10 章大纲，子代理启动后
 *   调 `novel_manage_outline` 没传 workToken，工具回退到**主会话的默认作品**
 *   （即鸦骨账）——结果鸦骨账第 25 章大纲被写进了当前作品。修复后智能体
 *   只把大纲内容"替换为占位"了事，但写错的作品 + 占位记录仍是污染。
 *
 * 根因（与方向 1 同源）：
 *   - 子代理不读主会话的工具调用历史，因此不知道主会话在写哪部作品
 *   - 子代理也不强制要求 workToken，于是工具回退到「自己进程的默认」=
 *     「落盘的 lastWorkToken」=「主会话上次写的那部」
 *   - 唯一正解：把"作品身份"作为委托契约的一部分显式传递
 *
 * 修复（方向 3，DSH 子代理 workToken 显式继承）：
 *   监听 `tools/pre-execute` waterfall，对**委托类工具**（`novel_agent_*`
 *   和 DSH 自带 `dsh_agent_*` 委托子代理的）改写 prompt 参数：
 *     - 头部追加 `[工作上下文 workToken=xxx workName=xxx profile=xxx]`
 *     - 子代理的 systemPrompt/persona 应提示它从这里提取 workToken 并
 *       显式传到每个 novel_* 调用
 *
 *   workToken 来源优先级（与 tools/defaults.ts 同步）：
 *     1. exec.arguments.workToken（如果主会话已经显式传了 → 沿用主会话的）
 *     2. 当前进程已记忆的 lastWorkToken（work-store 落盘 + 内存）
 *     3. **没有** → 仍然注入，但 workToken=unknown，提示子代理"主会话还没
 *        锁定作品，请停下来问主会话"——这是反向警告，避免子代理再次猜
 *
 * 不影响：
 *   - 非委托工具（novel_* 直接调用）—— 已有 warnings 自纠正
 *   - 子代理对 novel_* 的调用—— 那是子代理自己的事情，sub-agent 进程
 *     内的 work-store 也是落盘的（profile=A 的 DSH → ~/.unwr/A/...），
 *     沿用同样的回退路径
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { getCurrentProfile, getLastWorkToken, knownWorks } from '../domain/work-store.ts'

/**
 * 委托类工具名前缀。
 *
 * 包括 UnWr 的 7 个子代理（novel_agent_*）和 DSH 自带的 dsh_agent_*。
 * 注意：不能用 startsWith('dsh_') 一刀切——`dsh_status` 等查询类不是委托。
 * 同理 `novel_read_*` 也不是委托。
 */
const DELEGATE_TOOL_PATTERNS: ReadonlyArray<RegExp> = [
  /^novel_agent_/,
  /^dsh_agent_/,
]

/** prompt 头部注入的 work-context 标记。子代理 persona 应约定「看到这行就提取」。 */
export const WORK_CONTEXT_MARKER = '[工作上下文'

/**
 * 构造要注入的 work-context 字符串。
 * 暴露本函数是为了让单测能直接验证文本格式。
 */
export function buildWorkContext(
  token: string | undefined,
  argsWorkToken: string | undefined,
  profile: string,
): string {
  // 优先级：args 显式 > 落盘 > 标记 unknown
  let resolved: string
  let note: string
  if (argsWorkToken !== undefined && argsWorkToken !== '') {
    resolved = argsWorkToken
    note = '(主会话已显式传入)'
  } else if (token !== undefined && token !== '') {
    resolved = token
    note = '(从主会话的 lastWorkToken 继承)'
  } else {
    resolved = 'unknown'
    note = '(主会话尚未锁定作品——子代理应停下来问主会话要 workToken，不要猜默认)'
  }
  // 从 knownWorks 里查作品名：token 解析到哪条就拿哪条的 name
  const works = knownWorks()
  const w = works.find((x) => x.baseToken === resolved)
  const workName = w?.name ?? '(未命名/未记录)'
  return `${WORK_CONTEXT_MARKER} workToken=${resolved} workName=${workName} profile=${profile} ${note}]`
}

interface ExecLike {
  toolName?: string
  arguments?: Record<string, unknown>
}

/**
 * 注册 work-context-injector。
 *
 * 监听 `tools/pre-execute` waterfall，在子代理工具的 execute 前改写
 * `arguments.prompt`，头部追加 work-context 块（用显眼的 `===` 隔开，
 * 防止子代理把它和正文混在一起）。
 */
export function registerWorkContextInjector(ctx: Context): void {
  if (typeof (ctx as { on?: unknown }).on !== 'function') {
    console.error('[unwr] work-context-injector: ctx.on 不可用，跳过注册')
    return
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const e = exec as ExecLike | undefined
    if (e === undefined) return next()
    const toolName = e.toolName ?? ''
    const isDelegate = DELEGATE_TOOL_PATTERNS.some((p) => p.test(toolName))
    if (!isDelegate) return next()
    const args = e.arguments
    if (args === undefined || typeof args !== 'object') return next()
    const prompt = args['prompt']
    if (typeof prompt !== 'string' || prompt === '') return next()

    const argsToken = typeof args['workToken'] === 'string'
      ? args['workToken'] as string
      : undefined
    const persisted = getLastWorkToken()
    const profile = getCurrentProfile()
    const ctxBlock = buildWorkContext(persisted, argsToken, profile)

    // 改写 prompt：头部追加 ctxBlock + 显眼的横线分隔 + 原 prompt
    // 注释行（解释 workToken 来自哪、为什么必须传）——让子代理在没看
    // persona 的情况下也能照着做。
    const rewritten = `${ctxBlock}
===以下是主会话的原始任务===
${prompt}
===end===
（提醒：你正在为 ${profile} profile 的作品工作。后续所有 novel_* 调用都应
显式传 workToken="${argsToken ?? persisted ?? 'unknown'}"，不要省略——
工具省略时虽然能跑，但会回退到默认作品，是 2026-09-04 跨作品污染的
主要成因。）`

    args['prompt'] = rewritten
    return next()
  })
}
