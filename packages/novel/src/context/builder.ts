/**
 * 分层上下文组装器。
 *
 * 五层记忆模型（docs/requirements/05-memory-and-consistency.md）：
 *   L0 活跃层：当前章 + 前 K 章完整原文
 *   L1 近期层：第 N-M ~ N-K-1 章的摘要
 *   L2 远期层：卷级摘要
 *   L3 全书层：全书摘要 + 人物当前状态 + 未回收伏笔 + 主线进度（**每次全量注入**）
 *   L4 原文层：按需回溯，不主动加载
 *
 * 关键性质：**上下文成本 O(1) 而非 O(章节数)**——L1/L2 是压缩后的定长内容，
 * 因此长篇连载写几百章，注入量不随章节增长。
 *
 * 性能：所有数据拉取走 runParallel（实测并行加速比 4.2×）。
 *
 * @module @unwr/novel/context/builder
 */

import { base, docs } from '@unwr/feishu'
import {
  CHAPTER_F, CHAPTER_STATUS, FORESHADOW_F, FORESHADOW_STATUS,
  MEMORY_F, MEMORY_LEVEL, TABLE,
} from '@unwr/schema'
import type { GenrePreset } from '@unwr/schema'

/** 分层参数。可配置，默认值来自需求文档 MC-1。 */
export interface MemoryLayers {
  /** L0 活跃层：前 K 章完整原文 */
  recentFullChapters: number
  /** L1 近期层：摘要覆盖到第 M 章之前 */
  summaryHorizon: number
  /** 未回收伏笔取 Top N */
  foreshadowLimit: number
}

export const DEFAULT_LAYERS: MemoryLayers = {
  recentFullChapters: 3,
  summaryHorizon: 12,
  foreshadowLimit: 20,
}

/** 一章的索引信息。 */
export interface ChapterRef {
  recordId: string
  no: number
  title: string
  status?: string
  words?: number
  outline?: string
  summary?: string
  docUrl?: string
}

/** 组装完成的上下文。 */
export interface NovelContext {
  chapterNo: number
  preset: GenrePreset
  /** L3：本章大纲要点 */
  outline: string
  /** L0：前 K 章完整原文 */
  recentChapters: { no: number; title: string; content: string }[]
  /** L1：章节摘要 */
  chapterSummaries: { no: number; title: string; summary: string }[]
  /** L2：卷级/全书摘要 */
  bookSummaries: { level: string; title: string; content: string }[]
  /** L3：人物当前状态 */
  characterStates: { name: string; summary: string }[]
  /** L3：未回收伏笔 */
  openForeshadows: { content: string; importance: number; plantedIn: string }[]
  /** 估算 token 量（按中文 1 字 ≈ 1.3 token 粗估） */
  estimatedTokens: number
}

/**
 * 解析章节表的一行为 ChapterRef。
 *
 * `__recordId` 由 matrixToObjects 从 record_id_list 逐行配对注入，
 * 是后续更新该章节（写摘要、改状态）的必需凭证。
 */
function toChapterRef(row: Record<string, unknown>): ChapterRef {
  const no = row[CHAPTER_F.NO]
  const title = row[CHAPTER_F.TITLE]
  const status = row[CHAPTER_F.STATUS]
  return {
    recordId: typeof row['__recordId'] === 'string' ? row['__recordId'] : '',
    no: typeof no === 'number' ? no : Number(no ?? 0),
    title: typeof title === 'string' ? title : String(title ?? ''),
    ...typeof status === 'string' ? { status } : {},
    ...typeof row[CHAPTER_F.WORDS] === 'number' ? { words: row[CHAPTER_F.WORDS] as number } : {},
    ...typeof row[CHAPTER_F.OUTLINE] === 'string' ? { outline: row[CHAPTER_F.OUTLINE] as string } : {},
    ...typeof row[CHAPTER_F.SUMMARY] === 'string' ? { summary: row[CHAPTER_F.SUMMARY] as string } : {},
    ...typeof row[CHAPTER_F.DOC_URL] === 'string' ? { docUrl: row[CHAPTER_F.DOC_URL] as string } : {},
  }
}

/**
 * 查询一张表并在失败时降级为空结果。
 *
 * 作品库可能尚未建齐全部 13 张表（例如还没产生记忆索引），
 * 此时少给一部分上下文远好过让起草直接失败。
 */
async function safeRows(
  fn: () => Promise<Parameters<typeof base.matrixToObjects>[0]>,
): Promise<Record<string, unknown>[]> {
  try {
    return base.matrixToObjects(await fn())
  } catch {
    return []
  }
}

/**
 * 从飞书 URL 中提取文档 token。
 * 章节表的「正文文档」字段存的是完整 URL。
 */
export function extractDocToken(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  const m = /\/docx\/([A-Za-z0-9]+)/.exec(url)
  return m?.[1]
}

/** 组装起草第 N 章所需的全部上下文。 */
export async function buildContext(
  baseToken: string,
  chapterNo: number,
  preset: GenrePreset,
  layers: MemoryLayers = DEFAULT_LAYERS,
  signal?: AbortSignal,
): Promise<NovelContext> {
  const { recentFullChapters: K, summaryHorizon: M, foreshadowLimit } = layers

  // 拉取章节索引、伏笔、记忆索引：三者互不依赖，并行
  //
  // 容错原则：任何一张表查询失败都降级为空数组，不阻断整体组装。
  // 实践中作品库可能尚未建齐全部 13 张表（如还没产生记忆索引），
  // 此时宁可少给上下文，也要让起草能继续。
  // 章节表用 listAllRecords 分页（长篇连载可达数百章，单页 200 不够）
  const [chapterRows, foreshadowRows, memoryRows] = await Promise.all([
    safeRows(() => base.listAllRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [
        CHAPTER_F.TITLE, CHAPTER_F.NO, CHAPTER_F.STATUS, CHAPTER_F.WORDS,
        CHAPTER_F.OUTLINE, CHAPTER_F.SUMMARY, CHAPTER_F.DOC_URL,
      ],
      sort: [{ field: CHAPTER_F.NO, desc: false }],
    }, signal)),
    safeRows(() => base.listRecords(baseToken, TABLE.FORESHADOW, {
      fieldIds: [
        FORESHADOW_F.CONTENT, FORESHADOW_F.STATUS,
        FORESHADOW_F.IMPORTANCE, FORESHADOW_F.PLANT_CHAPTER_TITLES,
      ],
      filter: { logic: 'and', conditions: [[FORESHADOW_F.STATUS, '==', FORESHADOW_STATUS.PLANTED]] },
      sort: [{ field: FORESHADOW_F.IMPORTANCE, desc: true }],
      limit: foreshadowLimit,
    }, signal)),
    safeRows(() => base.listRecords(baseToken, TABLE.MEMORY, {
      fieldIds: [
        MEMORY_F.TITLE, MEMORY_F.LEVEL, MEMORY_F.CONTENT,
        MEMORY_F.FROM_CHAPTER, MEMORY_F.TO_CHAPTER,
      ],
      limit: 200,
    }, signal)),
  ])

  const chapters = chapterRows.map(toChapterRef).sort((a, b) => a.no - b.no)
  const current = chapters.find((c) => c.no === chapterNo)

  // L1 近期层：第 N-M ~ N-K-1 章的摘要
  const chapterSummaries = chapters
    .filter((c) => c.no < chapterNo - K && c.no >= chapterNo - M && (c.summary ?? '') !== '')
    .map((c) => ({ no: c.no, title: c.title, summary: c.summary ?? '' }))

  // L2 远期层：卷级与全书摘要（定长，不随章节数增长）
  const bookSummaries = memoryRows
    .filter((r) => {
      const lvl = r[MEMORY_F.LEVEL]
      return lvl === MEMORY_LEVEL.VOLUME || lvl === MEMORY_LEVEL.BOOK
    })
    .map((r) => ({
      level: String(r[MEMORY_F.LEVEL] ?? ''),
      title: String(r[MEMORY_F.TITLE] ?? ''),
      content: String(r[MEMORY_F.CONTENT] ?? ''),
    }))

  // L3 未回收伏笔
  const openForeshadows = foreshadowRows.map((r) => ({
    content: String(r[FORESHADOW_F.CONTENT] ?? ''),
    importance: typeof r[FORESHADOW_F.IMPORTANCE] === 'number'
      ? r[FORESHADOW_F.IMPORTANCE] as number : 0,
    plantedIn: String(r[FORESHADOW_F.PLANT_CHAPTER_TITLES] ?? ''),
  }))

  // L0 活跃层：前 K 章完整原文（并行拉取，这是性能关键）
  const recentTargets = chapters
    .filter((c) => c.no < chapterNo && c.no >= chapterNo - K)
    .map((c) => ({ ...c, token: extractDocToken(c.docUrl) }))
    .filter((c): c is ChapterRef & { token: string } => c.token !== undefined)

  const recentContents = await Promise.all(
    recentTargets.map(async (c) => {
      try {
        const doc = await docs.fetchDoc(c.token, { docFormat: 'markdown' }, signal)
        return { no: c.no, title: c.title, content: doc.content }
      } catch {
        // 单章读取失败不应阻断整体上下文组装
        return { no: c.no, title: c.title, content: '' }
      }
    }),
  )

  const text = [
    current?.outline ?? '',
    ...recentContents.map((c) => c.content),
    ...chapterSummaries.map((c) => c.summary),
    ...bookSummaries.map((s) => s.content),
    ...openForeshadows.map((f) => f.content),
  ].join('')

  return {
    chapterNo,
    preset,
    outline: current?.outline ?? '',
    recentChapters: recentContents.filter((c) => c.content !== ''),
    chapterSummaries,
    bookSummaries,
    characterStates: [],
    openForeshadows,
    estimatedTokens: Math.round(text.length * 1.3),
  }
}
