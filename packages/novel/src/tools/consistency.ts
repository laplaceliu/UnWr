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
import { resolveWorkToken } from './defaults.ts'

/** 注册一致性检查工具。 */
export function registerConsistencyTools(ctx: Context): void {
  registerRuleCheck(ctx)
  registerSemanticPack(ctx)
}

function registerRuleCheck(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_run_consistency_check',
    description: 'Run rule-based consistency checks that need no judgement: '
      + 'overdue unresolved foreshadowing, character location jumps, '
      + 'unexplained injury recovery, and event ordering. '
      + 'Results are deterministic and can be saved to the issue table. '
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
      const r = await runRuleChecks(
        resolveWorkToken(args),
        {
          ...args.currentChapterNo === undefined ? {} : { currentChapterNo: args.currentChapterNo },
          ...args.payoffTolerance === undefined ? {} : { payoffTolerance: args.payoffTolerance },
          ...args.checkTimeline === undefined ? {} : { checkTimeline: args.checkTimeline },
        },
        exec.signal,
      )

      const persisted = args.persist === true && r.issues.length > 0
        ? await persistIssues(resolveWorkToken(args), r.issues, exec.signal)
        : undefined

      return {
        total: r.issues.length,
        // severity >= 4 视为可能阻断定稿
        blocking: r.issues.filter((i) => i.severity >= 4).length,
        // 内联映射而非调 toWire：让返回值形状与 output schema 精确匹配
        issues: r.issues.map((i) => ({
          type: i.type,
          severity: i.severity,
          title: i.title,
          location: i.location,
          confidence: i.confidence,
        })),
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
      const pack = await buildSemanticCheckPack(resolveWorkToken(args), args.chapterNo, exec.signal)
      return {
        ...pack,
        reviewChecklist: [
          'H1 设定冲突：本章描写是否与设定词条矛盾？',
          'H2-a 性格违背：人物言行是否符合其性格标签？',
          'H2-b 口癖错用：该用口癖的地方是否用？有没有用错人？',
          'H2-c 动机合理：人物行为能否由其核心动机解释？',
          'H2-d 知识越界：人物是否表现出按理不该知道的信息？',
          'H7 前后矛盾：本章陈述是否与历史章节摘要冲突？',
        ],
      }
    },
  }))
}
