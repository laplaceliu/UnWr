/**
 * UnWr —— Unlimited Writing.
 *
 * 小说写作 AI 智能体的 DSH 工具插件。
 * 8 个写作角色（主编排官/设定官/人物官/大纲官/起草官/改稿官/评审官/救援官）
 * 通过提示词切换而非独立插件，见 docs/requirements/03-agent-matrix.md。
 *
 * 依赖飞书适配层：`inject: ['feishu']`。
 * @module @unwr/novel
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerContextTool } from './tools/context.ts'

export const name = 'unwr-novel'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 高空操作保护：禁止注册任何删除类工具（默认开启） */
  readOnlySafeMode?: boolean
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.readOnlySafeMode !== false) {
    // 安全策略：删除类 CLI 命令（table-delete / node-delete / record-delete）
    // 与本插件的 overwrite 一律不注册，避免模型幻觉造成不可逆损失。
  }
  registerContextTool(ctx)
}
