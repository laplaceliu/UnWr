/**
 * 多智能体编排的装配层。
 *
 * **不自研子代理运行时**。DSH 已提供：
 *   - `dsh-subagent-spawn-in-process`：spawn provider（支持 persona / toolFilter）
 *   - `dsh-tool-subagent`：把「委托一个子代理」暴露为模型可调的工具
 *
 * 本模块只做装配：
 *   1. 调官方 spawn-in-process 的 apply 注册 provider（复用其全部运行时机制）
 *   2. 把每个写作角色配置成一个 tool-subagent 实例（toolName/persona/toolFilter 不同），
 *      循环调用官方 apply —— 已实测其 apply 直接 ctx.tools.register，可多次调用
 *
 * 主编排官 = 主会话模型本身，不需要单独注册。
 * 前置依赖：ctx.subagents 服务（由宿主 dsh-base 提供）。
 *
 * @module @unwr/novel/agents
 */

import type { Context } from '@deepseek-ai/cordis'
import { apply as applySpawnProvider } from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { apply as applyToolSubagent } from '@deepseek-ai/dsh-tool-subagent'
import { AGENT_ROLES } from './roles.ts'

/** agents 装配的配置。 */
export interface AgentsConfig {
  /**
   * spawn provider 在 ctx.subagents 注册表中的名字。
   * 必须与 cordis.patch.yml 里 spawn-in-process 插件的 providerName 一致。
   */
  providerName?: string
  /** 关闭后不注册任何角色委托工具（用于 A/B 或排查） */
  enabled?: boolean
}

/**
 * 注册全部角色委托工具。
 *
 * 注意：官方 config 无自定义 description 字段（描述由框架按 provider
 * 特性生成），角色语义靠 toolName 自解释 + persona 落到子代理提示词。
 *
 * inject 要求：本插件需声明 `subagents`（provider 就绪后 tool-subagent
 * 才会挂载）与 `systemPrompt`（官方插件依赖）。
 */
export function registerAgents(ctx: Context, config: AgentsConfig = {}): void {
  if (config.enabled === false) return
  const provider = config.providerName ?? 'spawn'

  // 1. 注册 spawn provider（幂等：同名 provider 重复注册会 fail loud，
  //    而 DSH 宿主本身一般未注册，所以这里总是注册）
  applySpawnProvider(ctx, { providerName: provider })

  // 2. 每个角色一个 tool-subagent 实例
  for (const role of AGENT_ROLES) {
    applyToolSubagent(ctx, {
      provider,
      toolName: role.toolName,
      // one-shot：前台等待、完成即回收，主编排官拿到子代理的最终报告——
      // 最适合「派活-收报告」的协作形态
      backgroundMode: 'one-shot',
      persona: role.persona,
      // 权限边界：白名单之外的工具对子代理**不存在**（硬约束，非提示词）
      toolFilter: { allow: [...role.allowTools] },
    })
  }
}

/** 角色清单（供 verbose 日志与测试用）。 */
export function listRoles(): { toolName: string; label: string; allowTools: string[] }[] {
  return AGENT_ROLES.map((r) => ({
    toolName: r.toolName,
    label: r.label,
    allowTools: [...r.allowTools],
  }))
}
