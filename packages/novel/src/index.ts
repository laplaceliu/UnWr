/**
 * UnWr —— Unlimited Writing.
 *
 * 小说写作 AI 智能体的 DSH 工具插件。
 * 8 个写作角色（主编排官/设定官/人物官/大纲官/起草官/改稿官/评审官/救援官）
 * 通过提示词切换而非独立插件，见 docs/requirements/03-agent-matrix.md。
 *
 * 依赖：`inject: ['tools']`（DSH 保证 ctx.tools 就绪后才调 apply）。
 * @module @unwr/novel
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerContextTool } from './tools/context.ts'
import { registerChapterTools } from './tools/chapter.ts'
import { registerMemoryTools } from './tools/memory.ts'

export const name = 'unwr-novel'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 安全模式：只注册安全工具，不注册任何删除类工具（默认开启） */
  readOnlySafeMode?: boolean
  /** 加载时向 stderr 打印已注册的工具清单，便于确认插件生效（默认关闭） */
  verbose?: boolean
}

/** `ctx.tools.schemas()` 的返回形状（只取我们关心的字段）。 */
interface ToolSchemaLike {
  name?: unknown
}

export function apply(ctx: Context, config: Config = {}): void {
  // 安全策略：删除类 CLI 命令（table-delete / node-delete / record-delete）
  // 与覆盖式写入（overwrite）一律不注册，避免模型幻觉造成不可逆损失。
  if (config.readOnlySafeMode === false) {
    // 预留：未来若确需删除能力，应在此显式白名单化并配合审批钩子
  }

  registerContextTool(ctx)
  registerChapterTools(ctx)
  registerMemoryTools(ctx)

  if (config.verbose === true) {
    const mine = registeredToolNames(ctx).filter((n) => n.startsWith('novel_'))
    console.error(`[unwr] 插件已加载: ${name}`)
    console.error(`[unwr] 已注册工具 (${mine.length}): ${mine.join(', ')}`)
  }
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
