/**
 * novel_run_consistency_check —— 一致性检查。
 *
 * 拆成两个工具，对应两类检查：
 *
 *   `novel_run_consistency_check`  规则型：查表判定，结果确定，可落库
 *   `novel_get_semantic_check_pack` 语义型：备齐判所需的材料，交给模型审阅
 *
 * 为什么不放一个工具：语义型需要模型深度参与，返回值是"待审阅素材"；
 * 规则型返回的是"已确认的问题"。混在一起会让模型分不清哪些是确定结论。
 *
 * @module @unwr/novel/tools/consistency
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  buildSemanticCheckPack, persistIssues, runRuleChecks,
} from '../domain/consistency.ts'
import { getWorkConfig } from '../domain/work.ts'
import { renderReviewFocus, weightForIssueType } from '../genre/review-focus.ts'
import { resolveWorkToken } from './defaults.ts'

/** 注册一致性检查工具。 */
export function registerConsistencyTools(ctx: Context): void {
  registerRuleCheck(ctx)
  registerSemanticPack(ctx)
  registerReviewFocus(ctx)
}

function registerRuleCheck(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_run_consistency_check',
    description: 'Run rule-based consistency checks that need no judgement: '
      + 'overdue unresolved foreshadowing, character location jumps, '
      + 'unexplained injury recovery, and event ordering. '
      + 'Results are deterministic and can be saved to the issue table. '
      + 'Issues are ordered by this work\'s genre weights (consistency_weights) and '
      + 'blockingThreshold comes from the genre preset, not a fixed value. '
      + 'For subjective issues (character voice, setting conflicts) use '
      + 'novel_get_semantic_check_pack instead.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      currentChapterNo: {
        type: 'number',
        description: 'Treat this chapter number as "now". Defaults to the highest chapter number.',
      },
      payoffTolerance: {
        type: 'number',
        description: 'Grace period (in chapters) before a planted foreshadowing counts as overdue. Default 3.',
      },
      checkTimeline: {
        type: 'boolean',
        description: 'Also check event ordering. Off by default because in-story time is free text.',
      },
      persist: {
        type: 'boolean',
        description: 'Save new issues to the issue table (skips duplicates). Default false.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          blocking: { type: 'number', required: true },
          genreFocus: { type: 'string', required: true },
          blockingThreshold: { type: 'number', required: true },
          issues: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', required: true },
                severity: { type: 'number', required: true },
                title: { type: 'string', required: true },
                location: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
              },
            },
          },
          checkedTables: { type: 'array', required: true, items: { type: 'string' } },
          skippedTables: { type: 'array', required: true, items: { type: 'string' } },
          persisted: {
            type: 'object', additionalProperties: false,
            properties: {
              created: { type: 'number', required: true },
              skipped: { type: 'number', required: true },
            },
          },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const baseToken = resolveWorkToken(args)
      // 题材配置与检查并行拉取：权重与阈值来自作品表的题材预设（缺表降级为网文默认）
      const [r, cfg] = await Promise.all([
        runRuleChecks(
          baseToken,
          {
            ...args.currentChapterNo === undefined ? {} : { currentChapterNo: args.currentChapterNo },
            ...args.payoffTolerance === undefined ? {} : { payoffTolerance: args.payoffTolerance },
            ...args.checkTimeline === undefined ? {} : { checkTimeline: args.checkTimeline },
          },
          exec.signal,
        ),
        getWorkConfig(baseToken, exec.signal),
      ])

      const threshold = cfg.preset.consistency_weights.blocking_threshold
      // 跨类型排序按题材权重降序（同类内保持领域层给出的严重度降序）
      const issues = [...r.issues].sort((a, b) =>
        weightForIssueType(b.type, cfg.preset) - weightForIssueType(a.type, cfg.preset)
        || b.severity - a.severity)

      const persisted = args.persist === true && issues.length > 0
        ? await persistIssues(baseToken, issues, exec.signal)
        : undefined

      return {
        total: issues.length,
        // 阈值随题材：网文 3 / 类型小说 2 / 纯文学 4
        blocking: issues.filter((i) => i.severity >= threshold).length,
        // 内联映射而非调 toWire：让返回值形状与 output schema 精确匹配
        issues: issues.map((i) => ({
          type: i.type,
          severity: i.severity,
          title: i.title,
          location: i.location,
          confidence: i.confidence,
        })),
        genreFocus: renderReviewFocus(cfg.preset).genreFocus,
        blockingThreshold: threshold,
        checkedTables: r.checkedTables,
        skippedTables: r.skipped,
        ...persisted === undefined ? {} : { persisted },
      }
    },
  }))
}

function registerSemanticPack(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_get_semantic_check_pack',
    description: 'Gather the material needed to judge subjective consistency issues: '
      + 'character profiles (traits, catchphrases, motives), worldbuilding entries, '
      + 'open foreshadowing, and recent chapter summaries. '
      + 'Review this YOURSELF against the chapter draft — this tool only supplies evidence, '
      + 'it does not judge.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter being checked' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          characters: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                traits: { type: 'array', required: true, items: { type: 'string' } },
                catchphrase: { type: 'string', required: true },
                motive: { type: 'string', required: true },
              },
            },
          },
          settings: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                term: { type: 'string', required: true },
                definition: { type: 'string', required: true },
              },
            },
          },
          foreshadows: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                importance: { type: 'number', required: true },
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
          reviewChecklist: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const baseToken = resolveWorkToken(args)
      const [pack, cfg] = await Promise.all([
        buildSemanticCheckPack(baseToken, args.chapterNo, exec.signal),
        getWorkConfig(baseToken, exec.signal),
      ])
      return {
        ...pack,
        // 检查清单按题材权重排序（评审重点因题材而异，见 03 文档第六节）
        reviewChecklist: renderReviewFocus(cfg.preset).checklist,
      }
    },
  }))
}

/**
 * novel_get_review_focus —— 题材化评审重点。
 *
 * persona 是静态 YAML，不随作品题材变化；评审侧的题材差异化
 * （先看什么、什么算阻断、专项评估什么）只能由工具在运行时产出。
 * 评审官应在开评前调用一次，让检查顺序与该作品的题材配置对齐。
 */
function registerReviewFocus(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_get_review_focus',
    description: 'Get this work\'s genre-specific review focus: check weights (what to look '
      + 'at first), the blocking threshold, and the genre-specific assessment line '
      + '(webnovel: pacing/payoff appeal; genre fiction: clue fairness and self-consistency; '
      + 'literary: language and psychological depth). Call this BEFORE reviewing a chapter '
      + 'or interpreting consistency check results.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          presetId: { type: 'string', required: true },
          presetName: { type: 'string', required: true },
          genreFocus: { type: 'string', required: true },
          blockingThreshold: { type: 'number', required: true },
          weights: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                label: { type: 'string', required: true },
                weight: { type: 'number', required: true },
              },
            },
          },
          checklist: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const cfg = await getWorkConfig(resolveWorkToken(args), exec.signal)
      return renderReviewFocus(cfg.preset)
    },
  }))
}
