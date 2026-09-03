/**
 * novel_revise_chapter / novel_list_scenes / novel_get_chapter_history
 *
 * 改稿能力：局部改写 / 扩写 / 精确润色。视角、人称、文风切换
 * 本质上都是 replace——由模型生成新文本，工具负责精确定位与落库。
 *
 * 每次改稿都会在飞书留下版本，可用 novel_get_chapter_history 回溯。
 *
 * @module @unwr/novel/tools/revision
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  chapterHistory, listScenes, resolveChapterDoc, reviseChapter,
} from '../domain/revision.ts'
import { resolveWorkToken } from './defaults.ts'

/** 注册改稿相关工具。 */
export function registerRevisionTools(ctx: Context): void {
  registerReviseChapter(ctx)
  registerListScenes(ctx)
  registerHistory(ctx)
}

function registerReviseChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_revise_chapter',
    description: 'Revise an existing chapter in place. Four actions: '
      + '"replace" rewrites a whole scene or block (use for rewriting, condensing, '
      + 'switching POV/person/voice); "expand" inserts text after a scene or block; '
      + '"patch" does an exact text replacement (use for polishing a sentence); '
      + '"delete" removes a whole block (cleanup of placeholder/empty paragraphs, no content needed). '
      + 'Locate the target by "scene" (the ## heading, RECOMMENDED) or "blockId". '
      + 'For patch, provide "match" with the exact original text — a single-line snippet '
      + 'from inside ONE paragraph (newlines/blank lines are rejected: patch cannot span '
      + 'paragraphs; use replace + scene + paragraph for that). '
      + 'To merge several consecutive paragraphs into one, use action="replace" with '
      + 'scene + startParagraph/endParagraph (inclusive range, one call instead of '
      + 'replace-then-delete-twice). '
      + 'Every revision is versioned in Feishu and can be reviewed later.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      action: {
        type: 'string', enum: ['replace', 'expand', 'patch', 'delete'], required: true,
        description: 'replace = rewrite target; expand = insert after target; '
          + 'patch = exact text swap; delete = remove the whole block (no content).',
      },
      content: {
        // 不加 schema required：delete 不需要它；replace/expand/patch 缺失由
        // execute 守卫报动作级错误（与 novel_manage_* 的修复同一模式）。
        type: 'string',
        description: 'The new text. REQUIRED for replace/expand (Markdown) and patch '
          + '(the replacement string). NOT needed for delete — passing content with '
          + 'delete is an error.',
      },
      scene: {
        type: 'string',
        description: 'RECOMMENDED. The "## " heading of the scene to target, e.g. "二、交锋". '
          + 'Matched exactly first, then by number-stripped name, then by substring.',
      },
      paragraph: {
        type: 'number',
        description: '1-based paragraph index WITHIN the scene (use novel_list_scenes / '
          + 'novel_read_chapter to count). With scene, this locates one paragraph '
          + 'structurally — more reliable than copying exact text for patch. '
          + 'Mutually exclusive with startParagraph/endParagraph.',
      },
      startParagraph: {
        type: 'number',
        description: 'Start of a paragraph RANGE within the scene (1-based, INCLUSIVE). '
          + 'Must be paired with endParagraph and requires scene. Use it to merge several '
          + 'consecutive paragraphs into one: replace with scene + startParagraph/endParagraph '
          + 'collapses the whole range into your new content in a single call. '
          + 'CAUTION: every block in the range is affected, including non-paragraph blocks '
          + '(quotes, lists, images) sitting between the endpoints. '
          + 'Not supported for action=expand.',
      },
      endParagraph: {
        type: 'number',
        description: 'End of the paragraph RANGE (1-based, INCLUSIVE). Must be paired with '
          + 'startParagraph and requires scene.',
      },
      blockId: {
        type: 'string',
        description: 'Exact block id. Use only if you already fetched it — block ids '
          + 'change whenever the document structure changes. '
          + 'Cannot be combined with startBlockId/endBlockId.',
      },
      startBlockId: {
        type: 'string',
        description: 'Start of a sibling BLOCK RANGE (INCLUSIVE). Must be paired with '
          + 'endBlockId; cannot be combined with blockId. Prefer scene + '
          + 'startParagraph/endParagraph unless you already have the block ids.',
      },
      endBlockId: {
        type: 'string',
        description: 'End of the sibling BLOCK RANGE (INCLUSIVE). Must be paired with '
          + 'startBlockId.',
      },
      match: {
        type: 'string',
        description: 'REQUIRED for action=patch: the exact original text to replace. '
          + 'Copy it VERBATIM from novel_read_chapter output — do NOT reconstruct it from '
          + 'memory, since recalled paragraph order and wording are frequently wrong. '
          + 'MUST be a single-line snippet from WITHIN one paragraph: no newlines, cannot '
          + 'span paragraphs (to rewrite a whole paragraph use replace + scene + paragraph; '
          + 'for several consecutive ones use scene + startParagraph/endParagraph).',
      },
      updateWordCount: {
        type: 'boolean',
        description: 'Recount and write back the chapter word count, and set status to 修订. Default true.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          locatedBy: { type: 'string', required: true },
          blockId: { type: 'string', required: true },
          sceneTitle: { type: 'string' },
          paragraphIndex: { type: 'number' },
          paragraphRange: {
            type: 'object', additionalProperties: false,
            properties: {
              from: { type: 'number', required: true },
              to: { type: 'number', required: true },
            },
          },
          wordDelta: { type: 'number', required: true },
          revisionId: { type: 'number', required: true },
          documentId: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          historyHint: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const result = await reviseChapter(
        resolveWorkToken(args),
        args.chapterNo,
        {
          content: args.content,
          action: args.action,
          target: {
            ...args.blockId === undefined ? {} : { blockId: args.blockId },
            ...args.scene === undefined ? {} : { scene: args.scene },
            ...args.paragraph === undefined ? {} : { paragraph: args.paragraph },
            ...args.startParagraph === undefined ? {} : { startParagraph: args.startParagraph },
            ...args.endParagraph === undefined ? {} : { endParagraph: args.endParagraph },
            ...args.startBlockId === undefined ? {} : { startBlockId: args.startBlockId },
            ...args.endBlockId === undefined ? {} : { endBlockId: args.endBlockId },
            ...args.match === undefined ? {} : { match: args.match },
          },
          // 默认回写字数：改稿后字数必然变化
          updateWordCount: args.updateWordCount ?? true,
        },
        exec.signal,
      )
      return {
        ...result,
        historyHint: '本次改动已在飞书留下版本，可用 novel_get_chapter_history 查看历史并回滚。',
      }
    },
  }))
}

function registerListScenes(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_list_scenes',
    description: 'List the scene headings (## sections) of a chapter with their block ids. '
      + 'Call this before novel_revise_chapter when you are unsure of the exact scene name.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          documentId: { type: 'string', required: true },
          scenes: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                blockId: { type: 'string', required: true },
              },
            },
          },
          hint: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const { docToken } = await resolveChapterDoc(resolveWorkToken(args), args.chapterNo, exec.signal)
      const scenes = await listScenes(docToken, exec.signal)
      return {
        chapterNo: args.chapterNo,
        documentId: docToken,
        scenes,
        hint: scenes.length === 0
          ? '该章没有 ## 场景分节，改稿请用 blockId 或 match 定位。'
          : '改稿时把这些 title 传给 novel_revise_chapter 的 scene 参数即可。',
      }
    },
  }))
}

function registerHistory(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_get_chapter_history',
    description: 'List the version history of a chapter. Every write, append and revision '
      + 'creates a version, so this is how you review what an AI changed and when.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      pageSize: { type: 'number', description: 'Number of versions to return. Default 20.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true },
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                revisionId: { type: 'number', required: true },
                editTime: { type: 'string', required: true },
                historyVersionId: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'number', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const r = await chapterHistory(
        resolveWorkToken(args),
        args.chapterNo,
        args.pageSize ?? 20,
        exec.signal,
      )
      return { ...r, total: r.entries.length }
    },
  }))
}
