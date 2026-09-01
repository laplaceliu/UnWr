/**
 * UnWr —— Unlimited Writing.
 *
 * 小说写作 AI 智能体的 DSH 工具插件：20 个 novel_* 领域工具。
 *
 * 多智能体编排（7 个 novel_agent_* 委托工具）**不在这里注册**——
 * 由宿主配置层（~/.dsh/profiles/web/cordis.patch.yml）加载官方
 * @deepseek-ai/dsh-tool-subagent 的 7 个实例实现，见该文件。
 * spawn provider 由宿主 dsh-base 内置。
 *
 * 还会向主会话（主编排官）注入一段 system prompt 约定
 * （systemPrompt.section），让主会话也遵守标签纪律与记忆沉淀流程——
 * 它是最高频入口，且直接调工具时不经过任何子代理 persona。
 *
 * 依赖：`inject: ['tools', 'systemPrompt']`。
 * @module @unwr/novel
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerContextTool } from './tools/context.ts'
import { registerChapterTools } from './tools/chapter.ts'
import { registerMemoryTools } from './tools/memory.ts'
import { registerConsistencyTools } from './tools/consistency.ts'
import { registerRevisionTools } from './tools/revision.ts'
import { registerEntityTools } from './tools/entity.ts'
import { registerWorkTools } from './tools/work.ts'

export const name = 'unwr-novel'
export const inject = ['tools', 'systemPrompt']

/** 插件配置。 */
export interface Config {
  /** 安全模式：只注册安全工具，不注册任何删除类工具（默认开启） */
  readOnlySafeMode?: boolean
  /** 加载时向 stderr 打印已注册的工具清单，便于确认插件生效（默认关闭） */
  verbose?: boolean
  /** 是否向主会话注入写作约定 system prompt（默认开启） */
  injectSystemPrompt?: boolean
}

/** `ctx.tools.schemas()` 的返回形状（只取我们关心的字段）。 */
interface ToolSchemaLike {
  name?: unknown
}

/** systemPrompt.section 的最小形状（官方 tool-subagent 同款用法）。 */
interface SystemPromptLike {
  section(options: {
    name: string
    order: number
    /** text 可以是函数；组装 prompt 时才调用，context.scope 是当前会话作用域 */
    text: (context: { scope?: unknown }) => string
  }): unknown
}

/** ctx.tools.get 的最小形状（官方 tool-subagent 同款作用域检查）。 */
interface ToolsScopeLike {
  get(toolName: string, scope?: unknown): unknown
}

/**
 * 注入给主编排官（主会话）的写作约定。
 *
 * 为什么放在主会话而不是只有子代理 persona：主会话是最高频入口，
 * 它**直接**调 novel_manage_character 等工具时不会经过任何子代理
 * persona——没有这段，标签纪律就只对委托场景生效。
 */
const WRITING_CONVENTIONS = `
## 小说项目写作约定（UnWr）

你正在协助维护一部小说的结构化数据（飞书多维表格 + 云文档）。遵守：

1. **性格标签 / 设定分类纪律**：写入前先 query 已有数据，优先复用贴合的既有标签与分类；
   确实无合适的再创造，新标签与已有风格一致（2-4 字），避免同义碎片
   （已有「沉默寡言」不要再造「寡言」）。系统会自动把新选项合并进字段。
2. **记忆沉淀不可跳过**：用 novel_write_chapter 写完一章后，必须接着
   novel_update_summary（章节摘要）+ novel_record_character_state（出场人物
   章末状态）+ novel_record_event（关键事件）。跳过 = 后续章节失忆。
3. **章节正文结构**：正文用 ## 划分场景，不写 # 一级标题（章标题由系统承担）。
4. **职责边界**：复杂写作任务委托给 novel_agent_* 角色子代理（评审官只读、
   起草官管成稿、改稿官管修订）；简单查询可直接调工具。
5. **角色委托工具可用后台并行**：互不依赖的委托（如设定官+人物官）应放在
   同一条消息里并行发起。
`.trim()

export function apply(ctx: Context, config: Config = {}): void {
  // 安全策略：删除类 CLI 命令（table-delete / node-delete / record-delete）
  // 与覆盖式写入（overwrite）一律不注册，避免模型幻觉造成不可逆损失。
  if (config.readOnlySafeMode === false) {
    // 预留：未来若确需删除能力，应在此显式白名单化并配合审批钩子
  }

  registerContextTool(ctx)
  registerChapterTools(ctx)
  registerMemoryTools(ctx)
  registerConsistencyTools(ctx)
  registerRevisionTools(ctx)
  registerEntityTools(ctx)
  registerWorkTools(ctx)

  // 向主会话注入写作约定。
  // text 是惰性函数：DSH 组装 prompt 时才调用。作用域检查用官方同款
  // `ctx.tools.get(name, context.scope)`——工具被卸载/禁用或作用域不含
  // 本插件工具时返回空串，不污染宿主 prompt。
  const systemPrompt = (ctx as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
  if (config.injectSystemPrompt !== false && systemPrompt?.section !== undefined) {
    systemPrompt.section({
      name: 'unwr:writing-conventions',
      // 官方 tool-subagent 用 116.5（委托政策之后）。项目级约定应更早，
      // 取一个不与其冲突的靠前位置。
      order: 50,
      text: (context) =>
        hasToolInScope(ctx, 'novel_build_context', context?.scope) ? WRITING_CONVENTIONS : '',
    })
  } else if (config.injectSystemPrompt !== false) {
    // 宿主缺 systemPrompt 服务（如精简 profile）：降级不注入，
    // 但绝不让整个插件加载失败——20 个工具比约定提示重要得多。
    console.error('[unwr] 宿主无 systemPrompt 服务，跳过写作约定注入')
  }

  if (config.verbose === true) {
    const mine = registeredToolNames(ctx).filter((n) => n.startsWith('novel_'))
    console.error(`[unwr] 插件已加载: ${name}`)
    console.error(`[unwr] 已注册工具 (${mine.length}): ${mine.join(', ')}`)
  }
}

/**
 * 判断某工具在指定作用域是否可用。
 *
 * 与官方 tool-subagent 相同的两段检查：优先 `ctx.tools.get(name, scope)`
 * （作用域感知，是 DSH 的正式机制）；get 不可用时退回 schemas() 快照。
 */
function hasToolInScope(ctx: Context, toolName: string, scope?: unknown): boolean {
  const tools = (ctx as unknown as { tools?: ToolsScopeLike }).tools
  try {
    const got = tools?.get?.(toolName, scope)
    if (got !== undefined) return true
  } catch {
    // get 不可用则退回快照
  }
  return registeredToolNames(ctx).includes(toolName)
}

/**
 * 读取**当前时刻**已注册的工具名。
 *
 * `ctx.tools.schemas()` 是注册表的公开 API。
 * 注意：Cordis 并行加载插件，此处得到的只是本插件加载瞬间的快照，
 * 不代表最终工具集（宿主原生工具可能尚未注册完）。仅用于 verbose 日志。
 */
function registeredToolNames(ctx: Context): string[] {
  try {
    const schemas = (ctx as { tools?: { schemas?(): ToolSchemaLike[] } }).tools?.schemas?.()
    if (!Array.isArray(schemas)) return []
    return schemas
      .map((s) => (typeof s?.name === 'string' ? s.name : ''))
      .filter((n) => n !== '')
  } catch {
    return []
  }
}
