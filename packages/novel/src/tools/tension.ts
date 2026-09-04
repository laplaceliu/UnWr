/**
 * 章节张力与记忆失效工具。
 *
 * 两者组合由评审官/主编排官在章节状态流转时调用：
 *   - 章节草稿 → 修订/定稿：评估张力评分（setChapterTension）
 *   - 章节正文被改动：批量标记依赖该章的记忆条目为「已过期」
 *     （markMemoriesStaleForChapter，由后续重生成覆盖）
 *
 * @module @unwr/novel/tools/tension
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { withWorkToken } from './defaults.ts'
import { markMemoriesStaleForChapter, setChapterTension } from '../domain/entity.ts'

export function registerTensionTools(ctx: Context): void {
  // 写入张力评分
  ctx.tools.register(defineTool({
    name: 'novel_record_chapter_tension',
    description: '记录本章张力评分（1-5 星）。仅在评审官评审章节、或主编排官'
      + '进入修订/定稿状态时调用。张力评分会进入 L0 上下文，用于判定'
      + '「上一章张力曲线是否在本章延续」。',
    parameters: {
      workToken: { type: 'string', description: '可选，作品 Base token；不传则使用默认作品。' },
      chapterNo: { type: 'number', required: true, description: '章节号。' },
      score: { type: 'number', required: true, description: '1-5 整数。越界会被钳制并返回警告。' },
    },
    async execute(args, exec) {
      const r = await withWorkToken(
        args,
        (baseToken, signal) => setChapterTension(baseToken, args.chapterNo, args.score, signal),
        exec.signal,
      )
      return { recordId: r.recordId, chapterNo: r.chapterNo, score: r.score, warnings: r.warnings }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          chapterNo: { type: 'number', required: true },
          score: { type: 'number', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }))

  // 章节正文改动后批量打 STALE 戳
  ctx.tools.register(defineTool({
    name: 'novel_mark_chapter_memories_stale',
    description: '章节正文被改动后由主编排官调用：把覆盖该章区间的所有记忆'
      + '条目批量置为「已过期」。后续会触发摘要重生成流程。',
    parameters: {
      workToken: { type: 'string', description: '可选，作品 Base token；不传则使用默认作品。' },
      chapterNo: { type: 'number', required: true, description: '被改动的章节号。' },
    },
    async execute(args, exec) {
      const r = await withWorkToken(
        args,
        (baseToken, signal) => markMemoriesStaleForChapter(baseToken, args.chapterNo, signal),
        exec.signal,
      )
      return { affected: r.affected, warnings: r.warnings }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          affected: { type: 'number', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
  }))
}