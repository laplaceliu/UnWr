import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { withWorkToken } from './defaults.ts'
import { upsertCharacter } from '../domain/entity.ts'

/** 人物弧光阶段：四阶段开放枚举。 */
const ARC_STAGES = ['起始', '触发', '转折', '收束'] as const

/**
 * 人物弧光阶段推进工具。
 *
 * 触发时机：某章定稿后由评审官/人物官调用，把 CHARACTER.STATE_ARC 从
 * 「起始」推到「触发/转折/收束」。CHARACTER.STATE_ARC 是数据模型里
 * 的人物弧光追踪字段，本工具是唯一合法的写入入口。
 *
 * 幂等：同一人物同一阶段再次调用是 no-op（返回 updated=false）。
 */
export function registerCharacterArcTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_advance_character_arc',
    description: '人物弧光阶段推进：仅在某章定稿后由人物官/评审官调用。'
      + '把人物的 STATE_ARC 从起始推到触发/转折/收束。'
      + '调用前应确认该人物已在该章出场（参考 CHARACTER_STATE 表）。',
    parameters: {
      workToken: { type: 'string', description: '可选，作品 Base token；不传则使用默认作品。' },
      character: { type: 'string', required: true, description: '人物姓名（CHARACTER 表主字段）。' },
      arcStage: {
        type: 'string',
        required: true,
        enum: ARC_STAGES as unknown as string[],
        description: '弧光阶段：起始 / 触发 / 转折 / 收束。',
      },
    },
    async execute(args, exec) {
      const r = await withWorkToken(
        args,
        (baseToken, signal) => upsertCharacter(baseToken, {
          name: args.character,
          arcStage: args.arcStage,
        }, signal),
        exec.signal,
      )
      const warnings = [
        ...(args.arcStage === '收束' ? ['人物已收束，后续再次推进应改为创建支线或新人物。'] : []),
        ...(r.warnings ?? []),
      ]
      return { recordId: r.recordId, updated: r.updated, arcStage: args.arcStage, warnings }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
          arcStage: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }))
}