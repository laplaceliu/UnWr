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
import { listChapterBlocks } from '../domain/revision.ts'

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
      + 'novel_manage_outline set_chapter_outline) → fills the shell by creating the body document '
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
      cast: {
        type: 'array', items: { type: 'string' },
        description: 'Characters appearing in this chapter. Names only (e.g. "沈砚"); '
          + 'optional parenthetical note is auto-split (e.g. "陆铮（不在场）" → name="陆铮", note="不在场"). '
          + 'Recorded bidirectionally: chapter.出场人物 ∪ this name, and each character.出场章节 ∪ this chapter. '
          + 'Unresolvable names yield warnings but do not block the write.',
      },
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
          ...args.cast === undefined ? {} : { cast: args.cast },
        },
        {
          ...args.spaceId === undefined ? {} : { spaceId: args.spaceId },
          ...args.parentNodeToken === undefined ? {} : { parentNodeToken: args.parentNodeToken },
        },
        exec.signal,
      )
      return {
        ...result,
        nextHint: '草稿已落库。收尾沉淀清单（漏一项，后续章节就会失忆或人物对不上，'
          + '全部做完才算写完本章）：'
          + '① novel_update_summary 写本章结构化摘要；'
          + '② 为每个出场人物调 novel_record_character_state 记章末状态；'
          + '③ 新人物建档：cast 中未解析的名字、本章首次登场而人物表查无者，先 query 查重再 '
          + 'novel_manage_character(action=upsert)；'
          + '④ 新关系或关系转变 → novel_manage_relation(action=upsert, characterA/characterB/type)；'
          + '⑤ 关键事件 novel_record_event 登记。',
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
    description: 'Read the prose of an existing chapter, or list its scene/paragraph '
      + 'outline with block ids, or search inside it by keyword. '
      + 'Use it to check what has already been written, and — when you need precise '
      + 'block ids for novel_revise_chapter — use mode="outline" or mode="blocks".',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      mode: {
        type: 'string', enum: ['full', 'outline', 'blocks', 'search'],
        description: 'full = whole text; outline = scene headings only (the simpler ' +
          'probe, also returned by novel_list_scenes); blocks = every block under each ' +
          'scene with its block_id, type and text preview (paragraphs + images + ' +
          'quotes + code + lists, in order) — use this when you need a blockId that is ' +
          'NOT a scene heading; search = find keyword. Defaults to full.',
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
          blocks: {
            // 仅 mode='blocks' 时填充
            type: 'object',
            additionalProperties: false,
            properties: {
              docToken: { type: 'string', required: true },
              totalBlocks: { type: 'number', required: true },
              scenes: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    title: { type: 'string', required: true },
                    blockId: { type: 'string', required: true },
                    blocks: {
                      type: 'array', required: true,
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          index: { type: 'number', required: true },
                          blockId: { type: 'string', required: true },
                          type: { type: 'string', required: true },
                          preview: { type: 'string', required: true },
                        },
                      },
                    },
                    paragraphs: {
                      type: 'array', required: true,
                      items: {
                        type: 'object', additionalProperties: false,
                        properties: {
                          index: { type: 'number', required: true },
                          blockId: { type: 'string', required: true },
                          preview: { type: 'string', required: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
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

      // mode='blocks' 直走结构化路径——不进 markdown 也不进 outline XML；
      // 它的输出语义跟 full/outline 完全不同，挂在外层 blocks 字段。
      if (mode === 'blocks') {
        const blocks = await listChapterBlocks(token, exec.signal)
        return {
          chapterNo: args.chapterNo,
          title: rows.title,
          mode,
          content: '',
          words: 0,
          blocks,
        }
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

/** 回写章节字数（不动状态：续写不该把 修订/定稿 降级回 草稿）。 */
async function base_updateWords(
  baseToken: string,
  recordId: string,
  words: number,
  signal?: AbortSignal,
): Promise<void> {
  await base.updateRecords(
    baseToken,
    TABLE.CHAPTER,
    { [recordId]: { [CHAPTER_F.WORDS]: words } },
    signal,
  )
}
