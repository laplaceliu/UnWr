/**
 * argument-guard —— 拦截 `exec.arguments` 不是 plain object 的情况。
 *
 * 起因（实机 2026-09-04）：
 *   模型生成 tool_call 时，`arguments` 字段是 JSON 字符串。DSH 框架的
 *   `parseArguments` 在 JSON.parse 失败时会**返回原始字符串**（而不是抛错），
 *   目的是「保留诊断信息」。但下游 `validateArgs` 看到 arguments 是字符串
 *   直接抛 `invalid arguments: "arguments" must be an object`——
 *   **完全没暴露「JSON 解析失败」的真因**，模型照做的结果就是反复 5+ 次
 *   重试同一份巨大 payload，每次都被同一句话堵死。
 *
 * 触发场景（实测）：
 *   1. model 输出 token 撞上限 → JSON 末尾的 `]}` 被截掉
 *   2. events 数组过长，单字符串超 model 单次输出余量
 *   3. 字符串里含未转义引号 / 反斜杠 / 换行
 *
 * 修复：监听 `tools/pre-execute` waterfall，在 schema 校验之前检查
 *   `exec.arguments` 的形态。命中即抛一个**对模型友好**的 ToolArgsError：
 *     - 明说「你的 JSON 字符串解析失败」（不是 schema 错）
 *     - 给一段截断片段 + 截断长度，让模型自己看到「我输出了多少字符」
 *     - 建议三选一：① 拆小批次重试 ② 缩短字段内容 ③ 转义特殊字符
 *
 * 故意只针对 arguments 形态异常——合法 object 一律放行。
 *
 * 已知限制：本插件只服务 UnWr 工具的 DSH 调用链，不能修复 DSH 自身的
 *   parseArguments 设计；但能让模型看到更明确的真因，少走 5+ 次死循环。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

/** DSH 的 `parseArguments` 失败时透传过来的原始字符串长度上限 */
const RAW_DUMP_LIMIT = 480
/** 截断片段前后保留字符数，便于模型定位卡点 */
const HEAD_TAIL_SAMPLE = 120

/**
 * 把任意值压缩成一行 plain object 形态判定。
 * 与 DSH `isPlainJsonRecord` 对齐：排除 null/数组/函数/Date/类实例等。
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * 给模型看的 JSON 解析失败诊断。
 * 形如：
 *   arguments JSON 解析失败：参数是字符串而不是对象。
 *   长度 1820 字符，前后片段（前 80 / 后 80）：
 *     {"chapterNo": 24, "scene": "开元四十一年 三月二十 夜...", "events": ["裴三错去万年县小院找万俟休对质——万俟休左手执黑右手执白自己跟自己下残局,棋落一
 *     （后略 1640 字符）
 *   可能原因：
 *     1. JSON 字符串没闭合（被 model 输出 token 上限截断）
 *     2. 字符串中含未转义 " / \n / \\
 *     3. events / newInfo / scenes 等长数组超出单次输出余量
 *   建议：
 *     - 把大数组拆成多次调用（每次 events ≤ 5 条）
 *     - 缩短 scene / freeform 字段里的中长篇文本
 *     - 检查字符串里的引号和换行是否需要转义
 */
function buildArgParseDiagnostic(raw: string): string {
  const length = raw.length
  let sample = raw
  if (length > RAW_DUMP_LIMIT) {
    const head = raw.slice(0, HEAD_TAIL_SAMPLE)
    const tail = raw.slice(-HEAD_TAIL_SAMPLE)
    sample = `${head}\n\n...（省略 ${length - HEAD_TAIL_SAMPLE * 2} 字符）...\n\n${tail}`
  }
  const lines: string[] = []
  lines.push('arguments JSON 解析失败：参数是字符串而不是对象。')
  lines.push(`长度 ${length} 字符：`)
  lines.push(sample)
  lines.push('可能原因：')
  lines.push('  1. JSON 字符串没闭合（被 model 输出 token 上限截断）')
  lines.push('  2. 字符串里含未转义的 " / \\n / \\\\')
  lines.push('  3. 长数组（events / newInfo / scenes）超出单次输出余量')
  lines.push('建议：')
  lines.push('  - 把大数组拆成多次调用（每次 events ≤ 5 条）')
  lines.push('  - 缩短 scene / freeform 字段里的中长篇文本')
  lines.push('  - 检查字符串里的引号和换行是否需要转义')
  return lines.join('\n')
}

/** arguments 形态异常的统一守卫错误类型名（便于日志聚合 / e2e 断言）。 */
export const ARG_GUARD_ERROR_NAME = 'UnWrArgumentGuardError'

/**
 * 注册 `tools/pre-execute` waterfall 监听器。
 * DSH 在执行任何工具前会触发此 waterfall（详见 DSH docs/api/tools.md）。
 * 我们把非对象 arguments 在 schema 校验前拦下，给出可读错误。
 */
export function registerArgumentGuard(ctx: Context): void {
  // 防御：精简版 ctx 可能缺 on API（如测试 fakeContext），
  // 真实 cordis Context 必有 on。缺失时降级为「不挂守卫」，但打印警告，
  // 避免整插件崩在加载阶段——20 个工具比守卫重要得多。
  if (typeof (ctx as { on?: unknown }).on !== 'function') {
    console.error('[unwr] argument-guard: ctx.on 不可用，跳过守卫注册')
    return
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const e = exec as { arguments?: unknown } | undefined
    const args = e?.arguments
    if (isPlainObject(args)) return next()
    // arguments 不是 plain object —— DSH schema 校验会抛 `must be an object`
    // 但这条信息对模型毫无帮助，我们在更上层抛一个明确错误。
    let diagnostic = ''
    if (typeof args === 'string') {
      diagnostic = buildArgParseDiagnostic(args)
    } else if (args === null || args === undefined) {
      diagnostic = `arguments 为 ${args === null ? 'null' : 'undefined'}。`
      diagnostic += '\n通常意味着：1) tool_call 的 arguments 字段被模型写成空 / 缺失；'
      diagnostic += '2) 本会话首次调用此工具时未提供必要字段。'
      diagnostic += '\n请补齐必填字段后重试。'
    } else if (Array.isArray(args)) {
      diagnostic = 'arguments 是 JSON 数组。UnWr 工具的 arguments 必须是 JSON 对象 {...}，不接受数组 [,...]。'
      diagnostic += '\n请把数组作为某个字段（如 events / newInfo / scenes）的值传入。'
    } else {
      diagnostic = `arguments 是非法类型：${typeof args}（值预览：${String(args).slice(0, 80)}）。`
      diagnostic += '\n请重写成 JSON 对象 {...}。'
    }
    const err = new Error(diagnostic)
    err.name = ARG_GUARD_ERROR_NAME
    throw err
  })
}