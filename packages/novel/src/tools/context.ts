/**
 * novel_build_context —— 组装起草某章所需的分层上下文。
 *
 * 这是整个系统**最高价值**的工具：把「起草前 11 次飞书调用」压缩成模型调 1 次，
 * 内部并行拉取，链路越短越可靠。
 *
 * @module @unwr/novel/tools/context
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { DEFAULT_LAYERS, buildContext } from '../context/builder.ts'
import { getPreset } from '../genre/presets.ts'
import { resolveWorkToken } from './defaults.ts'
import type { PresetId } from '@unwr/schema'

/** 上下文摘要，模型可见的精简投影。 */
interface ContextDigest {
  chapterNo: number
  /** L3 本章大纲 */
  outline: string
  /** L0 前 K 章原文（章节号 → 正文） */
  recentChapters: { no: number; title: string; content: string }[]
  /** L1 章节摘要 */
  chapterSummaries: { no: number; title: string; summary: string }[]
  /** L2 卷/全书摘要 */
  bookSummaries: { level: string; title: string; content: string }[]
  /** L3 未回收伏笔 */
  openForeshadows: { content: string; importance: number; plantedIn: string }[]
  /** 题材配置的写作指引 */
  writingGuide: string
  estimatedTokens: number
}

/** 把题材预设渲染为模型可执行的写作指引。 */
function renderWritingGuide(p: ReturnType<typeof getPreset>): string {
  const lines = [
    `题材：${p.preset_name}（${p.description ?? ''}）`,
    `目标字数：${p.pacing.target_words_per_chapter} 字／章，`
      + `场景数 ${p.pacing.scene_count_per_chapter[0]}-${p.pacing.scene_count_per_chapter[1]}`,
    `对话占比约 ${Math.round(p.pacing.dialogue_ratio * 100)}%，`
      + `描写占比约 ${Math.round(p.pacing.description_ratio * 100)}%`,
    `情绪刺激密度：每千字 ${p.stimulus.stimulus_density} 个（${p.stimulus.stimulus_types.join('、')}）`,
    p.hook.force_cliffhanger
      ? `章末钩子：强度 ${p.hook.hook_strength}/5，必须留下悬念（${p.hook.hook_style}）`
      : `章末钩子：强度 ${p.hook.hook_strength}/5，${p.hook.hook_style === 'aftertaste' ? '以余韵收束，不要硬断章' : '自然收束即可'}`,
    `设定自洽严格度 ${p.verisimilitude.worldbuilding_strictness}/5；`
      + `规则解释方式：${p.verisimilitude.explanation_style}`,
    p.continuity.motif_recurrence
      ? `意象母题需复现${p.narration.motif_list.length > 0 ? `：${p.narration.motif_list.join('、')}` : ''}`
      : `线索公平性 ${p.continuity.clue_fairness}/5，回收窗口约 ${p.continuity.clue_payoff_window} 章`,
    `语言：意象密度 ${p.language.imagery_density}/5，心理深度 ${p.language.psychological_depth}/5，`
      + `语域 ${p.language.lexical_register}`,
    `视角：${p.narration.pov_person}，`
      + `${p.narration.pov_switch_allowed ? '允许章内换视角' : '章内禁止换视角'}，`
      + `叙事时间 ${p.narration.narrative_time}`,
    `章节内用 ## 划分场景（每个 ## 为一个场景分节）`,
  ]
  return lines.join('\n')
}

/** 注册 novel_build_context。 */
export function registerContextTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_build_context',
    description: 'Assemble the layered context needed to draft a chapter: recent full text, '
      + 'chapter summaries, book-level summaries, unresolved foreshadowing, and the active '
      + 'genre preset. Call this before drafting a chapter.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number to draft' },
      presetId: {
        type: 'string',
        enum: ['webnovel', 'genre', 'literary'],
        description: 'Genre preset. Defaults to webnovel.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          outline: { type: 'string', required: true },
          recentChapters: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                no: { type: 'number', required: true },
                title: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
          chapterSummaries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                no: { type: 'number', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
          bookSummaries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                title: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
          openForeshadows: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                importance: { type: 'number', required: true },
                plantedIn: { type: 'string', required: true },
              },
            },
          },
          writingGuide: { type: 'string', required: true },
          estimatedTokens: { type: 'number', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const preset = getPreset((args.presetId ?? 'webnovel') as PresetId)
      const built = await buildContext(
        resolveWorkToken(args),
        args.chapterNo,
        preset,
        DEFAULT_LAYERS,
        exec.signal,
      )
      const digest: ContextDigest = {
        chapterNo: built.chapterNo,
        outline: built.outline,
        recentChapters: built.recentChapters,
        chapterSummaries: built.chapterSummaries,
        bookSummaries: built.bookSummaries,
        openForeshadows: built.openForeshadows,
        writingGuide: renderWritingGuide(preset),
        estimatedTokens: built.estimatedTokens,
      }
      return digest
    },
  }))
}
