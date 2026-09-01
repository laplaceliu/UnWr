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
  await base.updateRecords(
    baseToken,
    TABLE.CHAPTER,
    { [recordId]: { [CHAPTER_F.SUMMARY]: summaryText } },
    signal,
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
  const characterRecordId = await findCharacterRecord(baseToken, state.character, signal)
  if (characterRecordId === undefined) {
    warnings.push(`人物「${state.character}」不存在于人物表，状态快照未关联人物（仍会记录章节）。`)
  }

  const fields: MutableFields = {
    [CHARACTER_STATE_F.CHAPTER]: [{ id: chapterRecordId }],
  }
  if (state.location !== undefined) fields[CHARACTER_STATE_F.LOCATION] = state.location
  if (state.physical !== undefined) fields[CHARACTER_STATE_F.PHYSICAL] = state.physical
  if (state.emotion !== undefined) fields[CHARACTER_STATE_F.EMOTION] = state.emotion
  if (state.belongings !== undefined) fields[CHARACTER_STATE_F.BELONGINGS] = state.belongings
  if (state.relationChange !== undefined) fields[CHARACTER_STATE_F.RELATION_CHANGE] = state.relationChange
  if (state.summary !== undefined) fields[CHARACTER_STATE_F.SUMMARY] = state.summary
  if (characterRecordId !== undefined) {
    fields[CHARACTER_STATE_F.CHARACTER] = [{ id: characterRecordId }]
  }

  const ids = await base.createRecords(baseToken, TABLE.CHARACTER_STATE, [fields], signal)
  const recordId = ids[0]
  return {
    ...recordId === undefined ? {} : { recordId },
    warnings,
  }
}

/** 事件索引入参。 */
export interface EventInput {
  name: string
  location?: string
  storyTime?: string
  summary?: string
  impact?: string
  isTurningPoint?: boolean
  /** 参与人物姓名列表；不存在的人物会被跳过 */
  participants?: string[]
}

/** 记录一条事件索引。 */
export async function recordEvent(
  baseToken: string,
  chapterNo: number,
  event: EventInput,
  signal?: AbortSignal,
): Promise<{ recordId: string; warnings: string[] }> {
  const warnings: string[] = []
  const chapterRecordId = await findChapterRecordByNo(baseToken, chapterNo, signal)
  if (chapterRecordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法记录事件。`)
  }

  const fields: MutableFields = {
    [EVENT_F.NAME]: event.name,
    [EVENT_F.CHAPTER]: [{ id: chapterRecordId }],
  }
  if (event.location !== undefined) fields[EVENT_F.LOCATION] = event.location
  if (event.storyTime !== undefined) fields[EVENT_F.STORY_TIME] = event.storyTime
  if (event.summary !== undefined) fields[EVENT_F.SUMMARY] = event.summary
  if (event.impact !== undefined) fields[EVENT_F.IMPACT] = event.impact
  if (event.isTurningPoint !== undefined) fields[EVENT_F.IS_TURNING_POINT] = event.isTurningPoint

  // 参与人物需逐个解析，跳过不存在的
  const participantIds: { id: string }[] = []
  for (const name of event.participants ?? []) {
    const id = await findCharacterRecord(baseToken, name, signal)
    if (id === undefined) {
      warnings.push(`参与人物「${name}」不存在，已跳过。`)
      continue
    }
    participantIds.push({ id })
  }
  if (participantIds.length > 0) fields[EVENT_F.PARTICIPANTS] = participantIds

  const ids = await base.createRecords(baseToken, TABLE.EVENT, [fields], signal)
  const recordId = ids[0]
  if (recordId === undefined) throw new Error('事件记录创建失败：未返回 record_id')
  return { recordId, warnings }
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

  // 同标题的记录做更新，否则新建
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.MEMORY, {
      fieldIds: [MEMORY_F.TITLE, MEMORY_F.LEVEL],
      filter: { logic: 'and', conditions: [[MEMORY_F.TITLE, '==', title]] },
      limit: 1,
    }, signal),
  )
  const existingId = rows[0]?.['__recordId']
  if (typeof existingId === 'string') {
    await base.updateRecords(baseToken, TABLE.MEMORY, { [existingId]: fields }, signal)
    return { recordId: existingId, updated: true }
  }

  const ids = await base.createRecords(baseToken, TABLE.MEMORY, [fields], signal)
  const recordId = ids[0]
  if (recordId === undefined) throw new Error('记忆索引创建失败：未返回 record_id')
  return { recordId, updated: false }
}
