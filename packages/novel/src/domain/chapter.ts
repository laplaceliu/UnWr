/**
 * 章节领域服务。
 *
 * 把「新建一章」这个业务动作编排为多次飞书调用：
 *   1. 校验章节号（查重 / 自动递增）
 *   2. 规范化正文（剥离 h1——章标题由文档标题承担）
 *   3. 创建正文文档
 *   4. 写入章节索引记录
 *   5. 可选：创建 Wiki 目录节点并回填 URL
 *
 * 与飞书 CLI 无关的业务规则都在这里，可单测、可 mock。
 *
 * @module @unwr/novel/domain/chapter
 */

import { base, docs, wiki } from '@unwr/feishu'
import {
  CHAPTER_F, CHAPTER_STATUS, TABLE,
} from '@unwr/schema'
import type { ChapterStatus } from '@unwr/schema'
import type { CellValue } from '@unwr/feishu'
import { extractDocToken } from '../context/builder.ts'

/**
 * 待写入的字段集合。
 * 刻意用可变版本：`RecordFields` 是 Readonly，无法逐字段赋值。
 */
type MutableFields = Record<string, CellValue>

/** 写章节的入参。 */
export interface WriteChapterParams {
  /** 章节号。省略时自动取「当前最大章节号 + 1」 */
  chapterNo?: number
  /** 章标题，同时作为飞书文档标题 */
  title: string
  /** 正文 Markdown。章内用 ## 划分场景 */
  content: string
  /** 所属卷名 */
  volume?: string
  /** 初始状态，默认「草稿」 */
  status?: ChapterStatus
  /** 大纲要点 */
  outline?: string
  /** 故事内时间 */
  storyTime?: string
}

/** 写章节的可选动作。 */
export interface WriteChapterOptions {
  /** 创建 Wiki 节点所需的空间 ID */
  spaceId?: string
  /** 创建 Wiki 节点所需的父节点（通常是卷节点） */
  parentNodeToken?: string
}

/** 写章节的结果。 */
export interface WriteChapterResult {
  /** 实际使用的章节号 */
  chapterNo: number
  title: string
  /** 正文文档 ID */
  documentId: string
  documentUrl: string
  /** 章节表记录 ID */
  recordId: string
  /** 正文字数 */
  words: number
  /** Wiki 节点（仅在提供了 spaceId/parentNodeToken 时创建） */
  wikiNodeToken?: string
  /** 非致命提示，例如自动修正了正文格式 */
  warnings: string[]
}

/**
 * 统计中文字数。
 *
 * 先剥离 Markdown 标记与空白，再数字符。
 * 中文场景字符数即字数（英文按词计会更准，但小说以中文为主）。
 */
export function countWords(markdown: string): number {
  const plain = markdown
    // 去掉代码块
    .replace(/```[\s\S]*?```/g, '')
    // 去掉标题标记
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // 去掉引用标记
    .replace(/^\s{0,3}>\s?/gm, '')
    // 去掉列表标记
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    // 去掉行内标记：粗体/斜体/删除线/行内代码
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    // 去掉图片与链接，保留文字
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 合并空白
    .replace(/\s+/g, '')
  return plain.length
}

/**
 * 规范化正文。
 *
 * 约定（技术选型阶段实测）：**章标题由飞书文档标题承担，正文只用 `##` 做场景分节**。
 * 若模型传入的正文首行写了 `# 章标题`，CLI 会用 --title 覆盖它导致层级丢失，
 * 因此这里主动剥离首行 h1，并在 warnings 中说明。
 */
export function normalizeContent(content: string): { content: string; warnings: string[] } {
  const warnings: string[] = []
  const trimmed = content.replace(/^\s+/, '')

  // 剥离首行 h1
  const h1Match = /^#\s+(.+)$/m.exec(trimmed)
  if (h1Match !== null && h1Match.index === 0) {
    warnings.push(`已剥离正文首行的 h1 标题「${(h1Match[1] ?? '').trim()}」：章标题由 title 参数承担，正文应只用 ## 划分场景。`)
    const stripped = trimmed.slice(h1Match[0].length).replace(/^\s*\n/, '')
    return { content: stripped, warnings }
  }

  // 正文完全没有任何 ## 分节时给出提示（不强制，短章节可能就一段）
  if (!/^\s{0,3}##\s+/m.test(trimmed)) {
    warnings.push('正文未使用 ## 划分场景分节；长章节建议分节，便于后续按块改写与导航。')
  }

  return { content: trimmed, warnings }
}

/** 查询当前最大章节号；无记录时返回 0。 */
export async function maxChapterNo(
  baseToken: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const rows = base.matrixToObjects(
      await base.listAllRecords(baseToken, TABLE.CHAPTER, {
        fieldIds: [CHAPTER_F.NO],
      }, signal),
    )
    let max = 0
    for (const r of rows) {
      const n = r[CHAPTER_F.NO]
      if (typeof n === 'number' && n > max) max = n
    }
    return max
  } catch {
    // 章节表不存在或查询失败：按 0 处理，交给后续创建流程报错
    return 0
  }
}

/** 按章节号查找已有记录 ID；不存在返回 undefined。 */
export async function findChapterRecord(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const rows = base.matrixToObjects(
      await base.listRecords(baseToken, TABLE.CHAPTER, {
        fieldIds: [CHAPTER_F.NO, CHAPTER_F.TITLE],
        filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
        limit: 1,
      }, signal),
    )
    const id = rows[0]?.['__recordId']
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 新建一章。
 *
 * 章节号冲突时抛错（改稿应走 revise 类工具，避免重复建文档）。
 */
export async function writeChapter(
  baseToken: string,
  params: WriteChapterParams,
  options: WriteChapterOptions = {},
  signal?: AbortSignal,
): Promise<WriteChapterResult> {
  const { content: normalized, warnings } = normalizeContent(params.content)
  const words = countWords(normalized)

  // 1. 确定章节号
  const chapterNo = params.chapterNo ?? (await maxChapterNo(baseToken, signal)) + 1
  const existing = await findChapterRecord(baseToken, chapterNo, signal)
  if (existing !== undefined) {
    throw new Error(
      `第 ${chapterNo} 章已存在（记录 ${existing}）。`
      + '若要续写请用 novel_append_chapter，若要改写请用 novel_revise_chapter。',
    )
  }

  // 2. 创建正文文档（章标题由 --title 承担）
  const doc = await docs.createDoc(params.title, normalized, {}, signal)

  // 3. 写入章节索引
  const fields: MutableFields = {
    [CHAPTER_F.TITLE]: params.title,
    [CHAPTER_F.NO]: chapterNo,
    [CHAPTER_F.WORDS]: words,
    [CHAPTER_F.STATUS]: [params.status ?? CHAPTER_STATUS.DRAFT],
    [CHAPTER_F.DOC_URL]: doc.url,
  }
  if (params.volume !== undefined) fields[CHAPTER_F.VOLUME] = params.volume
  if (params.outline !== undefined) fields[CHAPTER_F.OUTLINE] = params.outline
  if (params.storyTime !== undefined) fields[CHAPTER_F.STORY_TIME] = params.storyTime

  const recordIds = await base.createRecords(baseToken, TABLE.CHAPTER, [fields], signal)
  const recordId = recordIds[0]
  if (recordId === undefined) {
    throw new Error('章节记录创建失败：未返回 record_id')
  }

  // 4. 可选：创建 Wiki 节点并回填 URL
  let wikiNodeToken: string | undefined
  if (options.spaceId !== undefined || options.parentNodeToken !== undefined) {
    try {
      const node = await wiki.createNode(
        params.title,
        {
          ...options.spaceId === undefined ? {} : { spaceId: options.spaceId },
          ...options.parentNodeToken === undefined ? {} : { parentNodeToken: options.parentNodeToken },
        },
        signal,
      )
      wikiNodeToken = node.node_token
      await base.updateRecords(
        baseToken,
        TABLE.CHAPTER,
        { [recordId]: { [CHAPTER_F.WIKI_URL]: node.url ?? '' } },
        signal,
      )
    } catch (e) {
      warnings.push(`Wiki 节点创建失败（正文与索引已写入成功）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    chapterNo,
    title: params.title,
    documentId: doc.document_id,
    documentUrl: doc.url,
    recordId,
    words,
    ...wikiNodeToken === undefined ? {} : { wikiNodeToken },
    warnings,
  }
}

/** 读取一章正文。 */
export async function readChapter(
  docTokenOrUrl: string,
  options: { docFormat?: 'markdown' | 'xml'; withIds?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ content: string; documentId: string }> {
  const token = extractDocToken(docTokenOrUrl) ?? docTokenOrUrl
  const doc = await docs.fetchDoc(
    token,
    {
      docFormat: options.docFormat ?? 'markdown',
      ...options.withIds === true ? { detail: 'with-ids' as const } : {},
    },
    signal,
  )
  return { content: doc.content, documentId: doc.document_id }
}
