/**
 * novel_write_chapter / novel_append_chapter / novel_read_chapter
 *
 * write 是「读 → 写」闭环的关键一环：创建正文文档 + 写入章节索引，
 * 一次调用完成起草官的落库动作。
 *
 * @module @unwr/novel/tools/chapter
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { base, docs } from '@unwr/feishu'
import {
  CHAPTER_F, CHAPTER_STATUS, TABLE,
} from '@unwr/schema'
import {
  countWords, findChapterRecord, maxChapterNo, writeChapter,
} from '../domain/chapter.ts'
import { extractDocToken } from '../context/builder.ts'
import { resolveWorkToken } from './defaults.ts'

/** 注册章节相关工具。 */
export function registerChapterTools(ctx: Context): void {
  registerWriteChapter(ctx)
  registerAppendChapter(ctx)
  registerReadChapter(ctx)
}

function registerWriteChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_write_chapter',
    description: 'Write the prose for a chapter: create the Feishu document and add its '
      + 'index row (title, number, word count, status) to the chapter table. '
      + 'Use this after drafting with novel_build_context. '
      + 'Three states are accepted: '
      + '(a) chapter number is unused → creates a new document + index row; '
      + '(b) chapter number exists but has no body document (an outline shell from '
      + 'novel_manage_chapter set_outline) → fills the shell by creating the body document '
      + 'and backfilling docUrl/words/status onto the existing row; '
      + '(c) chapter number exists AND already has a body document → fails — use '
      + 'novel_append_chapter to continue or novel_revise_chapter to rewrite parts.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      title: {
        type: 'string', required: true,
        description: 'Chapter title, e.g. "第三章 巷战". It becomes the Feishu document title.',
      },
      content: {
        type: 'string', required: true,
        description: 'Chapter prose in Markdown. Use "## " for scene breaks — do NOT start '
          + 'with "# " (the title parameter already carries the chapter title).',
      },
      chapterNo: {
        type: 'number',
        description: 'Chapter number. Omit to use (current max + 1).',
      },
      volume: { type: 'string', description: 'Volume name this chapter belongs to.' },
      outline: { type: 'string', description: 'Outline notes for this chapter.' },
      storyTime: { type: 'string', description: 'In-story time of this chapter, e.g. "三年后 秋".' },
      spaceId: { type: 'string', description: 'Wiki space id; provide to also create a wiki node.' },
      parentNodeToken: { type: 'string', description: 'Wiki parent node token (usually the volume node).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          title: { type: 'string', required: true },
          documentId: { type: 'string', required: true },
          documentUrl: { type: 'string', required: true },
          recordId: { type: 'string', required: true },
          words: { type: 'number', required: true },
          wikiNodeToken: { type: 'string' },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          nextHint: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const result = await writeChapter(
        resolveWorkToken(args),
        {
          title: args.title,
          content: args.content,
          ...args.chapterNo === undefined ? {} : { chapterNo: args.chapterNo },
          ...args.volume === undefined ? {} : { volume: args.volume },
          ...args.outline === undefined ? {} : { outline: args.outline },
          ...args.storyTime === undefined ? {} : { storyTime: args.storyTime },
        },
        {
          ...args.spaceId === undefined ? {} : { spaceId: args.spaceId },
          ...args.parentNodeToken === undefined ? {} : { parentNodeToken: args.parentNodeToken },
        },
        exec.signal,
      )
      return {
        ...result,
        nextHint: '草稿已落库。建议接着调用 novel_update_summary 沉淀本章摘要，'
          + '否则后续章节起草时无法回忆起本章内容。',
      }
    },
  }))
}

function registerAppendChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_append_chapter',
    description: 'Append more prose to the end of an existing chapter document and update its '
      + 'word count. Use this to continue a chapter that already exists.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number to continue' },
      content: {
        type: 'string', required: true,
        description: 'Prose to append, in Markdown. Use "## " to start a new scene.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          documentId: { type: 'string', required: true },
          appendedWords: { type: 'number', required: true },
          totalWords: { type: 'number', required: true },
          revisionId: { type: 'number', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const recordId = await findChapterRecord(resolveWorkToken(args), args.chapterNo, exec.signal)
      if (recordId === undefined) {
        throw new Error(`第 ${args.chapterNo} 章不存在，请先用 novel_write_chapter 创建。`)
      }
      const rows = await base_listChapter(resolveWorkToken(args), args.chapterNo, exec.signal)
      const docUrl = rows.docUrl
      if (docUrl === undefined || docUrl === '') {
        throw new Error(
          `第 ${args.chapterNo} 章没有正文文档（章节壳可能仅含大纲）。`
          + '请先用 novel_write_chapter 写入正文，再来续写。',
        )
      }
      const token = extractDocToken(docUrl)
      if (token === undefined) {
        throw new Error(`无法从「${docUrl}」解析文档 token。`)
      }

      const res = await docs.appendDoc(token, args.content, exec.signal)
      const appendedWords = countWords(args.content)

      // 回写总字数：读取当前正文统计，避免多轮续写后数字漂移
      const full = await docs.fetchDoc(token, { docFormat: 'markdown' }, exec.signal)
      const totalWords = countWords(full.content)
      await base_updateWords(resolveWorkToken(args), recordId, totalWords, exec.signal)

      return {
        chapterNo: args.chapterNo,
        documentId: token,
        appendedWords,
        totalWords,
        revisionId: res.revision_id,
      }
    },
  }))
}

function registerReadChapter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_read_chapter',
    description: 'Read the prose of an existing chapter, or search inside it by keyword, '
      + 'or list its scene outline. Use it to check what has already been written.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      mode: {
        type: 'string', enum: ['full', 'outline', 'search'],
        description: 'full = whole text; outline = scene headings only; search = find keyword. Defaults to full.',
        default: 'full',
      },
      keyword: { type: 'string', description: 'Required when mode is search. Required (and only valid) when mode=search.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          title: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          content: { type: 'string', required: true },
          words: { type: 'number', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const rows = await base_listChapter(resolveWorkToken(args), args.chapterNo, exec.signal)
      if (rows.docUrl === undefined || rows.docUrl === '') {
        throw new Error(
          `第 ${args.chapterNo} 章没有正文文档（章节壳可能仅含大纲）。`
          + '请先用 novel_write_chapter 写入正文，再来阅读。',
        )
      }
      const token = extractDocToken(rows.docUrl)
      if (token === undefined) {
        throw new Error(`无法从「${rows.docUrl}」解析文档 token。`)
      }

      const mode = args.mode ?? 'full'
      if (mode === 'search' && (args.keyword === undefined || args.keyword === '')) {
        throw new Error('mode=search 时必须提供 keyword。')
      }

      const doc = await docs.fetchDoc(
        token,
        {
          docFormat: 'markdown',
          ...mode === 'outline' ? { scope: 'outline' as const, docFormat: 'xml' as const } : {},
          ...mode === 'search' ? { scope: 'keyword' as const, keyword: args.keyword } : {},
        },
        exec.signal,
      )

      return {
        chapterNo: args.chapterNo,
        title: rows.title,
        mode,
        content: doc.content,
        words: countWords(doc.content),
      }
    },
  }))
}

/** 取某章的索引行（标题与正文链接）。 */
async function base_listChapter(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<{ title: string; docUrl?: string }> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.TITLE, CHAPTER_F.NO, CHAPTER_F.DOC_URL],
      filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
      limit: 1,
    }, signal),
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`第 ${chapterNo} 章不存在。`)
  const docUrl = row[CHAPTER_F.DOC_URL]
  return {
    title: typeof row[CHAPTER_F.TITLE] === 'string' ? row[CHAPTER_F.TITLE] as string : '',
    ...typeof docUrl === 'string' && docUrl !== '' ? { docUrl } : {},
  }
}

/** 回写章节字数。 */
async function base_updateWords(
  baseToken: string,
  recordId: string,
  words: number,
  signal?: AbortSignal,
): Promise<void> {
  await base.updateRecords(
    baseToken,
    TABLE.CHAPTER,
    { [recordId]: { [CHAPTER_F.WORDS]: words, [CHAPTER_F.STATUS]: [CHAPTER_STATUS.DRAFT] } },
    signal,
  )
}
