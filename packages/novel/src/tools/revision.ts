/**
 * novel_revise_chapter / novel_list_scenes / novel_get_chapter_history
 * / novel_restore_chapter
 *
 * 改稿能力：局部改写 / 扩写 / 精确润色 / 整段重写 / 回滚到任一历史版本。
 * 视角、人称、文风切换本质上都是 replace——由模型生成新文本，工具负责
 * 精确定位与落库。
 *
 * 每次改稿都会在飞书留下版本，可用 novel_get_chapter_history 回溯；
 * 改坏了可用 novel_restore_chapter 一键回滚到任意历史版本（Tier 5 安全网）。
 *
 * @module @unwr/novel/tools/revision
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  chapterHistory, listScenes, resolveChapterDoc, reviseChapter,
  restoreChapterVersion,
} from '../domain/revision.ts'
import { resolveWorkToken } from './defaults.ts'

/** 注册改稿相关工具。 */
export function registerRevisionTools(ctx: Context): void {
  registerReviseChapter(ctx)
  registerListScenes(ctx)
  registerHistory(ctx)
  registerRestoreChapter(ctx)
}

function registerReviseChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_revise_chapter',
    description: 'Revise an existing chapter in place. '
      + '\n\nDECIDE THE SCOPE FIRST (this avoids the most common stuck-loop pattern — '
      + 'dozens of single-block edits that keep invalidating block_ids):'
      + '\n• Rewriting or merging SEVERAL paragraphs at once? → action="replace" + '
      + 'scene + startParagraph/endParagraph (inclusive range, ONE call replaces the '
      + 'whole span — the right tool for "merge these 4 paragraphs into one" or '
      + '"rewrite this whole beat"). Block ids inside the range become invalid.'
      + '\n• Rewriting a whole SCENE? → action="replace" + scene (no paragraph index; '
      + 'replaces from the ## heading down to the next ## or end of doc).'
      + '\n• Rewriting ONE paragraph? → action="replace" + scene + paragraph.'
      + '\n• Polishing a sentence / swapping a phrase? → action="patch" + match '
      + '(single-line snippet, no newlines, must be VERBATIM from novel_read_chapter).'
      + '\n• Inserting new text after a scene or block? → action="expand" + '
      + 'scene|blockId + content.'
      + '\n• Removing a placeholder / empty paragraph? → action="delete" + '
      + 'blockId (no content needed).'
      + '\n\nActions: replace=rewrite target with content; expand=insert content '
      + 'after target; patch=swap an exact text snippet; delete=remove the whole '
      + 'block (no content).'
      + '\n\nLocation: prefer "scene" (the ## heading, RECOMMENDED — stable across '
      + 'edits) over "blockId" (ids change on every edit). For paragraph indices '
      + 'inside a scene, count from novel_list_scenes / novel_read_chapter.'
      + '\n\nPatch gotchas (the #1 source of stuck loops):'
      + '\n• match MUST be a single-line snippet from inside ONE paragraph '
      + '(newlines or blank lines are rejected — str_replace only matches inside a '
      + 'block; cross-paragraph matches will never hit even if they look like they '
      + 'do in a markdown preview).'
      + '\n• match MUST be VERBATIM from novel_read_chapter output — do NOT '
      + 'reconstruct it from memory, recalled paragraph order/wording are frequently '
      + 'wrong.'
      + '\n• If patch fails once: STOP patching that text, switch to action="replace" '
      + '+ scene + paragraph (structural location, no match needed).'
      + '\n\nEvery revision is versioned in Feishu and can be reviewed or rolled '
      + 'back via novel_get_chapter_history.',
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

/**
 * novel_restore_chapter —— 回滚章节正文到任一历史版本。
 *
 * 这是改稿的安全网：revise_chapter / write_chapter 改坏了不用慌，先
 * novel_get_chapter_history 看一眼，选个 revisionId 一键回滚。注意
 * 该工具是**写操作**，会撤销 revert 目标之后的所有编辑。
 */
function registerRestoreChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_restore_chapter',
    description: 'Roll a chapter\'s body back to any historical version (the SAFETY NET for revision). '
      + '\n\nTHIS IS A WRITE — it discards every edit after the target version. The chapter doc '
      + 'is rewritten to the chosen revision\'s content. Use it when:'
      + '\n• a multi-step revise_chapter session made things worse and you want to undo all of it'
      + '\n• the agent and the user disagree on the direction and want to revisit a prior cut'
      + '\n• the chapter grew too long and you want to step back to a more concise version'
      + '\n\nWORKFLOW:'
      + '\n1. Call novel_get_chapter_history first to see versions and their revisionIds / editTimes.'
      + '\n2. Pick a target version. Prefer the most recent "good" one. Note: a single revisionId '
      + 'may map to multiple historyVersionIds (one edit can produce several history rows) — '
      + 'in that case the tool returns the candidate list and asks you to retry with '
      + 'historyVersionId instead.'
      + '\n3. Call novel_restore_chapter with that revisionId (or historyVersionId).'
      + '\n\nOUTPUT:'
      + '\n• status="done" → revert succeeded; chapter doc body is now the chosen version.'
      + '\n• status="partial_failed" → revert succeeded for most blocks but a few failed (see '
      + 'failedBlockTokens); verify with novel_read_chapter and patch as needed.'
      + '\n• status="failed" → revert task itself failed (rare; usually permission).'
      + '\n• status="running" → you passed waitTimeoutMs=0 to opt out of waiting; use the '
      + 'returned taskId with docs +history-revert-status (or just call again).'
      + '\n\nBy default also refreshes the chapter record\'s WORDS and sets STATUS=REVISING '
      + '(matches revise_chapter).',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number to restore.' },
      revisionId: { type: 'number', description: 'Target revision id from novel_get_chapter_history. Mutually exclusive with historyVersionId.' },
      historyVersionId: { type: 'string', description: 'Target history_version_id directly (skips the chapterHistory lookup). Use this when revisionId is ambiguous.' },
      waitTimeoutMs: { type: 'number', description: 'How long to wait for the revert task (0~60000ms). Default 30000. Pass 0 for fire-and-forget (returns status="running" + taskId).' },
      updateWordCount: { type: 'boolean', description: 'Whether to refresh chapter.WORDS and set STATUS=REVISING. Default true.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true },
          revertedTo: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              revisionId: { type: 'number', required: true },
              historyVersionId: { type: 'string', required: true },
              editTime: { type: 'string', required: true },
            },
          },
          newRevisionId: { type: 'number' },
          newHistoryVersionId: { type: 'string' },
          status: { type: 'string', required: true },
          taskId: { type: 'string' },
          failedBlockTokens: { type: 'array', items: { type: 'string' } },
          newWords: { type: 'number' },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.revisionId === undefined && args.historyVersionId === undefined) {
        throw new Error('必须提供 revisionId 或 historyVersionId 之一。可先调 novel_get_chapter_history 拿到 revisionId 列表。')
      }
      if (args.revisionId !== undefined && args.historyVersionId !== undefined) {
        throw new Error('revisionId 与 historyVersionId 互斥，只能传一个。')
      }
      const r = await restoreChapterVersion(
        resolveWorkToken(args),
        args.chapterNo,
        {
          revisionId: args.revisionId,
          historyVersionId: args.historyVersionId,
          waitTimeoutMs: args.waitTimeoutMs,
          updateWordCount: args.updateWordCount,
        },
        exec.signal,
      )
      return r
    },
  }))
}
