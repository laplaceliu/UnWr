/**
 * 记忆领域服务。
 *
 * 分层记忆的**写入侧**（读取侧见 context/builder.ts）：
 *   - 章节摘要（G1）：写入章节表「章节摘要」
 *   - 人物状态快照（G3）：写入人物状态表
 *   - 事件索引（G2）：写入事件表
 *
 * 摘要采用固定模板，这样后续可做结构化比对，支撑 H7 前后文矛盾检查。
 *
 * @module @unwr/novel/domain/memory
 */

import { base } from '@unwr/feishu'
import {
  CHAPTER_F, CHARACTER_F, CHARACTER_STATE_F, EVENT_F, MEMORY_F,
  MEMORY_LEVEL, TABLE,
} from '@unwr/schema'
import type { MemoryLevel } from '@unwr/schema'
import type { CellValue } from '@unwr/feishu'
// 记忆写入必须走自愈包装：旧库缺 link 字段 / 新库收敛期都会报 not_found，
// 裸调 createRecords 会让章末记忆沉淀整批失败（2026-09-01 实测 8 连挂）。
import { createRecordWithLinks, createRecordsWithSelfHeal, updateRecordsWithSelfHeal } from './selfheal.ts'

/**
 * 待写入的字段集合。
 * 刻意用可变版本：`RecordFields` 是 Readonly，无法逐字段赋值。
 */
type MutableFields = Record<string, CellValue>

/** 章节摘要的结构化字段（固定模板，便于机器比对）。 */
export interface ChapterSummaryInput {
  /** 场景：本章发生在何时何地 */
  scene?: string
  /** 事件：按顺序发生了什么（3-5 条） */
  events?: string[]
  /** 人物变化：谁的状态发生了什么改变 */
  characterChanges?: string[]
  /** 新信息：揭示了什么此前未知的信息 */
  newInfo?: string[]
  /** 新埋伏笔 */
  newForeshadows?: string[]
  /** 章末状态：人物处境与未解决问题 */
  endState?: string
  /** 自由格式补充（模板之外的内容） */
  freeform?: string
}

/** 把结构化摘要渲染为存储文本。 */
export function renderSummary(input: ChapterSummaryInput): string {
  const lines: string[] = []
  const push = (label: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== '') lines.push(`【${label}】${value.trim()}`)
  }
  const pushList = (label: string, items: string[] | undefined): void => {
    const valid = (items ?? []).filter((s) => s.trim() !== '')
    if (valid.length > 0) lines.push(`【${label}】\n${valid.map((s) => `- ${s.trim()}`).join('\n')}`)
  }

  push('场景', input.scene)
  pushList('事件', input.events)
  pushList('人物变化', input.characterChanges)
  pushList('新信息', input.newInfo)
  pushList('新埋伏笔', input.newForeshadows)
  push('章末状态', input.endState)
  push('补充', input.freeform)

  return lines.join('\n')
}

/** 按章节号查找章节记录 ID。 */
export async function findChapterRecordByNo(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.NO],
      filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/** 按姓名查找人物记录 ID。 */
export async function findCharacterRecord(
  baseToken: string,
  name: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [CHARACTER_F.NAME],
      filter: { logic: 'and', conditions: [[CHARACTER_F.NAME, '==', name]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/**
 * 拆分人物串里的尾随括号注记：`陆铮（不在场）` → 姓名 `陆铮` + 注记 `不在场`。
 *
 * 为什么需要：模型传参与人物/状态人物时常把临场状态写成括号后缀，而
 * 人物 link 必须按人物表精确姓名匹配——整串传入恒匹配失败（2026-09-02
 * 实测 e2e：5 条事件的参与人物因此被静默跳过）。拆开后姓名进 link、
 * 注记进独立备注列，两边都不丢。
 *
 * 规则：
 *   - 只剥**完整的尾随**括号（中英文括号都认）；括号不闭合则不动
 *   - 剥离后为空（整串都在括号里，如「（路人）」）则原样返回，不当姓名用
 */
export function splitParticipantNote(raw: string): { name: string; note?: string } {
  const m = /[（(]([^（）()]*)[）)]\s*$/.exec(raw.trim())
  if (m === null) return { name: raw.trim() }
  const note = (m[1] ?? '').trim()
  const name = raw.slice(0, m.index).trim()
  if (name === '') return { name: raw.trim() }
  return note === '' ? { name } : { name, note }
}

/**
 * 按「先剥离注记、再原串兜底」的顺序解析人物记录。
 * 返回命中的记录 ID 与实际采用的解析说明（供 warnings 引用）。
 */
async function resolveCharacterFlexible(
  baseToken: string,
  raw: string,
  signal?: AbortSignal,
): Promise<{ recordId?: string; name: string; note?: string; strippedWorked: boolean }> {
  const { name, note } = splitParticipantNote(raw)
  if (note === undefined) {
    const recordId = await findCharacterRecord(baseToken, name, signal)
    return { recordId, name, strippedWorked: false }
  }
  const stripped = await findCharacterRecord(baseToken, name, signal)
  if (stripped !== undefined) return { recordId: stripped, name, note, strippedWorked: true }
  // 剥离后没找到：人物表里可能真有带括号的名字，用原串兜底
  const rawHit = await findCharacterRecord(baseToken, raw.trim(), signal)
  if (rawHit !== undefined) return { recordId: rawHit, name: raw.trim(), strippedWorked: false }
  return { name, note, strippedWorked: true }
}

/** 写入章节摘要。返回章节记录 ID。 */
export async function updateChapterSummary(
  baseToken: string,
  chapterNo: number,
  summary: ChapterSummaryInput | string,
  signal?: AbortSignal,
): Promise<{ recordId: string; summaryText: string }> {
  const recordId = await findChapterRecordByNo(baseToken, chapterNo, signal)
  if (recordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法写入摘要。请先创建章节。`)
  }
  const summaryText = typeof summary === 'string' ? summary : renderSummary(summary)
  await updateRecordsWithSelfHeal(
    baseToken,
    TABLE.CHAPTER,
    { [recordId]: { [CHAPTER_F.SUMMARY]: summaryText } },
    signal,
    (msg) => console.error(`[unwr] ${msg}`),
  )
  return { recordId, summaryText }
}

/** 人物状态快照入参。 */
export interface CharacterStateInput {
  /** 人物姓名（用于解析人物记录） */
  character: string
  /** 所在位置 */
  location?: string
  /** 身体状况 */
  physical?: string
  /** 情绪状态 */
  emotion?: string
  /** 持有物品 */
  belongings?: string
  /** 关系变化 */
  relationChange?: string
  /** 状态摘要 */
  summary?: string
}

/**
 * 记录人物在某章末尾的状态快照。
 *
 * 人物不存在时以 warnings 形式提示——记忆沉淀不应阻断主流程。
 */
export async function recordCharacterState(
  baseToken: string,
  chapterNo: number,
  state: CharacterStateInput,
  signal?: AbortSignal,
): Promise<{ recordId?: string; warnings: string[] }> {
  const warnings: string[] = []
  const chapterRecordId = await findChapterRecordByNo(baseToken, chapterNo, signal)
  if (chapterRecordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法记录人物状态。`)
  }
  // 括号注记拆分：`陆铮（重伤）` 按「陆铮」关联；注记不进结构化字段
  // （physical/emotion 等语义无从猜测），提示模型改用结构化字段表达
  const resolved = await resolveCharacterFlexible(baseToken, state.character, signal)
  const characterRecordId = resolved.recordId
  if (characterRecordId === undefined) {
    warnings.push(`人物「${state.character}」不存在于人物表，状态快照未关联人物（仍会记录章节）。`)
  } else if (resolved.note !== undefined) {
    warnings.push(
      `人物按「${resolved.name}」解析成功；括号注记「${resolved.note}」未单独存储，`
      + '状态信息请直接写入 physical / emotion / location / summary 等字段。',
    )
  }

  // 两段式：batch-create 不支持 link 字段（恒 not_found），标量先建、link 回填
  const scalarFields: MutableFields = {}
  if (state.location !== undefined) scalarFields[CHARACTER_STATE_F.LOCATION] = state.location
  if (state.physical !== undefined) scalarFields[CHARACTER_STATE_F.PHYSICAL] = state.physical
  if (state.emotion !== undefined) scalarFields[CHARACTER_STATE_F.EMOTION] = state.emotion
  if (state.belongings !== undefined) scalarFields[CHARACTER_STATE_F.BELONGINGS] = state.belongings
  if (state.relationChange !== undefined) scalarFields[CHARACTER_STATE_F.RELATION_CHANGE] = state.relationChange
  if (state.summary !== undefined) scalarFields[CHARACTER_STATE_F.SUMMARY] = state.summary

  const linkFields: Record<string, string[]> = {
    [CHARACTER_STATE_F.CHAPTER]: [chapterRecordId],
    ...(characterRecordId === undefined ? {} : { [CHARACTER_STATE_F.CHARACTER]: [characterRecordId] }),
  }

  const recordId = await createRecordWithLinks(
    baseToken, TABLE.CHARACTER_STATE, scalarFields, linkFields, signal,
    (event) => { if (event.level === 'warn') warnings.push(event.message) },
  )
  return { recordId, warnings }
}

/** 事件索引入参。 */
export interface EventInput {
  name: string
  location?: string
  storyTime?: string
  summary?: string
  impact?: string
  isTurningPoint?: boolean
  /**
   * 参与人物列表；不存在的人物会被跳过。
   * 允许尾随括号注记（如「陆铮（不在场）」）：姓名进 link，
   * 注记进「参与人物备注」列，两边都不丢。
   */
  participants?: string[]
}

/** 记录一条事件索引。 */
export async function recordEvent(
  baseToken: string,
  chapterNo: number,
  event: EventInput,
  signal?: AbortSignal,
): Promise<{ recordId: string; warnings: string[]; participantNotes?: string }> {
  const warnings: string[] = []
  const chapterRecordId = await findChapterRecordByNo(baseToken, chapterNo, signal)
  if (chapterRecordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法记录事件。`)
  }

  // 两段式：batch-create 不支持 link 字段，标量先建、link 回填
  const scalarFields: MutableFields = {
    [EVENT_F.NAME]: event.name,
  }
  if (event.location !== undefined) scalarFields[EVENT_F.LOCATION] = event.location
  if (event.storyTime !== undefined) scalarFields[EVENT_F.STORY_TIME] = event.storyTime
  if (event.summary !== undefined) scalarFields[EVENT_F.SUMMARY] = event.summary
  if (event.impact !== undefined) scalarFields[EVENT_F.IMPACT] = event.impact
  if (event.isTurningPoint !== undefined) scalarFields[EVENT_F.IS_TURNING_POINT] = event.isTurningPoint

  // 参与人物逐个解析：姓名（剥离括号注记后）进 link，注记进备注列
  const participantIds: string[] = []
  const notes: string[] = []
  for (const raw of event.participants ?? []) {
    const resolved = await resolveCharacterFlexible(baseToken, raw, signal)
    if (resolved.recordId !== undefined) participantIds.push(resolved.recordId)
    else {
      warnings.push(
        resolved.note !== undefined
          ? `参与人物「${raw}」不存在（已按剥离注记后的「${resolved.name}」查找），已跳过。`
          : `参与人物「${raw}」不存在，已跳过。`,
      )
    }
    if (resolved.note !== undefined) notes.push(`${resolved.name}：${resolved.note}`)
  }
  if (notes.length > 0) scalarFields[EVENT_F.PARTICIPANT_NOTES] = notes.join('；')

  const linkFields: Record<string, string[]> = {
    [EVENT_F.CHAPTER]: [chapterRecordId],
    ...(participantIds.length > 0 ? { [EVENT_F.PARTICIPANTS]: participantIds } : {}),
  }

  const recordId = await createRecordWithLinks(
    baseToken, TABLE.EVENT, scalarFields, linkFields, signal,
    (event) => { if (event.level === 'warn') warnings.push(event.message) },
  )
  return {
    recordId,
    warnings,
    ...(notes.length > 0 ? { participantNotes: notes.join('；') } : {}),
  }
}

/** 卷级/全书摘要查询的过滤条件。 */
export interface BookSummaryQuery {
  /** 只看某一层级；省略则返回 L2 全部（卷 + 全书，与 builder.ts 远期层同口径） */
  level?: MemoryLevel
  /** 标题/正文子串过滤 */
  keyword?: string
  limit?: number
}

/** 卷级/全书摘要条目。 */
export interface BookSummaryEntry {
  level: string
  title: string
  content: string
  /** 覆盖起始章节；未填时省略 */
  fromChapter?: number
  /** 覆盖结束章节；未填时省略 */
  toChapter?: number
}

/** 单元格 → 字符串（undefined/null → ''）。 */
const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)

/** select 字段可能是单值也可能是数组，统一取首个。 */
const firstStr = (v: unknown): string => (Array.isArray(v) ? str(v[0]) : str(v))

/** 单元格 → 数字；非数字返回 undefined（用于可选数值字段）。 */
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 把可能 undefined 的字段展开到对象里——undefined/null 时**不写入键**。
 *
 * 解决 DSH `value is not lossless JSON` 错（实机 2026-09-03）：
 *   - DSH 的 `@deepseek-ai/dsh-tools/snapshotJsonValue` 会逐属性 visit 对象值，
 *     遇 undefined 视为不可序列化，整对象拒收；
 *   - JSON.stringify 在这种场景下会**丢弃** undefined 键，dev 看不出来。
 *
 * 4 个会触发的 query 函数：
 *   - `entity.queryForeshadows`（plantChapter/planPayoffChapter/actualPayoffChapter）
 *   - 本文件 `queryBookSummaries`（fromChapter/toChapter）
 *   - `entity.queryPlotlines` 已用同等 spread，跳过；
 *   - `entity.queryRelations` `startChapter` `?? 0` 兜底，跳过。
 *
 * 用法见 entity.ts 同名函数。
 */
function presentSparse<K extends string, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  return (value === null || value === undefined
    ? {}
    : ({ [key]: value } as { [P in K]: V }))
}

/**
 * 查询卷级 / 全书摘要（分层记忆 L2 的**读取侧**）。
 *
 * 为什么必须有：upsert 的去重键是**标题**，模型不先查就写，会因标题
 * 略有出入（"第一卷 旧剑" vs "第一卷 旧剑（修订）"）堆出重复摘要行。
 * 实机踩坑 2026-09-03：模型想读已有卷摘要，按 novel_manage_* 的惯例
 * 传 `{action:"query", level:"卷"}`，而本工具彼时是纯写入工具且
 * title/content 为 schema 级 required → 校验阶段直接
 * `missing required property "title"; missing required property "content"`。
 */
export async function queryBookSummaries(
  baseToken: string,
  options: BookSummaryQuery = {},
  signal?: AbortSignal,
): Promise<BookSummaryEntry[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.MEMORY, {
      fieldIds: [
        MEMORY_F.TITLE, MEMORY_F.LEVEL, MEMORY_F.CONTENT,
        MEMORY_F.FROM_CHAPTER, MEMORY_F.TO_CHAPTER,
      ],
      limit: Math.min(options.limit ?? 200, 200),
    }, signal),
  )

  const isL2 = (lvl: string): boolean =>
    lvl === MEMORY_LEVEL.VOLUME || lvl === MEMORY_LEVEL.BOOK

  return rows
    .map((r) => ({
      level: firstStr(r[MEMORY_F.LEVEL]),
      title: str(r[MEMORY_F.TITLE]),
      content: str(r[MEMORY_F.CONTENT]),
      // 章节字段是 optional——单元格值不是数字（章节号列空 / link 反解失败）
      // 时 numOrUndef 回 undefined，必须用 presentSparse 跳过键。
      ...presentSparse('fromChapter', numOrUndef(r[MEMORY_F.FROM_CHAPTER])),
      ...presentSparse('toChapter', numOrUndef(r[MEMORY_F.TO_CHAPTER])),
    }))
    .filter((s) => s.title !== '')
    .filter((s) => (options.level === undefined ? isL2(s.level) : s.level === options.level))
    .filter((s) =>
      options.keyword === undefined
      || s.title.includes(options.keyword)
      || s.content.includes(options.keyword))
}

/** 写入卷级或全书摘要。 */
export async function upsertBookSummary(
  baseToken: string,
  level: Exclude<MemoryLevel, '章节'>,
  title: string,
  content: string,
  range: { fromChapter?: number; toChapter?: number } = {},
  signal?: AbortSignal,
): Promise<{ recordId: string; updated: boolean }> {
  const fields: MutableFields = {
    [MEMORY_F.TITLE]: title,
    [MEMORY_F.LEVEL]: level,
    [MEMORY_F.CONTENT]: content,
  }
  if (range.fromChapter !== undefined) fields[MEMORY_F.FROM_CHAPTER] = range.fromChapter
  if (range.toChapter !== undefined) fields[MEMORY_F.TO_CHAPTER] = range.toChapter

  // 同标题的记录做更新，否则新建。
  // 标题不跨层级唯一（卷级与全书可能重名），故在同标题候选里**优先取层级
  // 相同的那条**；层级读不到（字段投影异常）时退回首条，保持旧行为不回退。
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.MEMORY, {
      fieldIds: [MEMORY_F.TITLE, MEMORY_F.LEVEL],
      filter: { logic: 'and', conditions: [[MEMORY_F.TITLE, '==', title]] },
      limit: 10,
    }, signal),
  )
  const candidates = rows.filter((r) => typeof r['__recordId'] === 'string')
  const levelMatch = candidates.find((r) => firstStr(r[MEMORY_F.LEVEL]) === level)
  const existingId = (levelMatch ?? candidates[0])?.['__recordId']
  if (typeof existingId === 'string') {
    await updateRecordsWithSelfHeal(
      baseToken,
      TABLE.MEMORY,
      { [existingId]: fields },
      signal,
      (msg) => console.error(`[unwr] ${msg}`),
    )
    return { recordId: existingId, updated: true }
  }

  const ids = await createRecordsWithSelfHeal(
    baseToken, TABLE.MEMORY, [fields], signal,
    (msg) => console.error(`[unwr] ${msg}`),
  )
  const recordId = ids[0]
  if (recordId === undefined) throw new Error('记忆索引创建失败：未返回 record_id')
  return { recordId, updated: false }
}
