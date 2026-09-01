/**
 * 设定 / 人物 / 大纲 / 伏笔 / 卷 / 分支 的增删改查。
 *
 * 这一层提供「先查后写」的 upsert 语义：按名称查找，存在则更新、不存在则创建。
 * 对模型来说这比「先 query 判断再决定 create/update」少一步，更不容易出错。
 *
 * 所有写入都复用 `awaitVisible` 之外的既有约定：
 *   - 字段值一律走常量（@unwr/schema），禁止字面量
 *   - 查询失败**向上抛**，不静默返回空（曾由此掩盖过冲突检测失效）
 *
 * @module @unwr/novel/domain/entity
 */

import { base } from '@unwr/feishu'
import type { CellValue } from '@unwr/feishu'
import {
  BRANCH_F, CHARACTER_F, CHAPTER_F, FORESHADOW_F, PLOTLINE_F,
  SETTING_F, TABLE, VOLUME_F,
} from '@unwr/schema'
import { awaitVisible } from './chapter.ts'
import { createRecordsWithSelfHeal } from './selfheal.ts'

/** 可写入的字段集合（可变，便于逐字段赋值）。 */
type Fields = Record<string, CellValue>

/** upsert 结果。 */
export interface UpsertResult {
  recordId: string
  /** true = 更新了既有记录；false = 新建 */
  updated: boolean
  warnings: string[]
}

/** 按某字段精确查找记录 ID。查不到返回 undefined。 */
async function findBy(
  baseToken: string,
  table: string,
  field: string,
  // 章节号是 number 字段，故值可以是数字
  value: string | number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, table, {
      fieldIds: [field],
      filter: { logic: 'and', conditions: [[field, '==', value]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/** 通用 upsert：按 key 字段查找，存在则更新否则创建。 */
async function upsert(
  baseToken: string,
  table: string,
  keyField: string,
  keyValue: string,
  fields: Fields,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const warnings: string[] = []
  const existing = await findBy(baseToken, table, keyField, keyValue, signal)

  if (existing !== undefined) {
    await base.updateRecords(baseToken, table, { [existing]: fields }, signal)
    return { recordId: existing, updated: true, warnings }
  }

  const ids = await createRecordsWithSelfHeal(baseToken, table, [fields], signal, (msg) => {
    warnings.push(msg)
  })
  const recordId = ids[0]
  if (recordId === undefined) {
    throw new Error(`${table} 记录创建失败：未返回 record_id`)
  }

  // 飞书 Base 有约 1 秒写入索引延迟：不等可见就返回的话，
  // 调用方紧接着的第二次 upsert 会查不到这条记录而重复创建。
  await awaitVisible(
    async () => (await findBy(baseToken, table, keyField, keyValue, signal)) === recordId,
    signal,
    (msg) => { warnings.push(msg) },
  )

  return { recordId, updated: false, warnings }
}

/* ------------------------------------------------------------------ */
/* 设定                                                                */
/* ------------------------------------------------------------------ */

export interface SettingInput {
  term: string
  category?: string[]
  definition?: string
  importance?: number
  status?: string
}

/** 创建或更新设定词条。 */
export async function upsertSetting(
  baseToken: string,
  input: SettingInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [SETTING_F.TERM]: input.term }
  if (input.category !== undefined) fields[SETTING_F.CATEGORY] = input.category
  if (input.definition !== undefined) fields[SETTING_F.DEFINITION] = input.definition
  if (input.importance !== undefined) fields[SETTING_F.IMPORTANCE] = input.importance
  if (input.status !== undefined) fields[SETTING_F.STATUS] = [input.status]
  return upsert(baseToken, TABLE.SETTING, SETTING_F.TERM, input.term, fields, signal)
}

/** 查询设定词条。keyword 为空时返回全部。 */
export async function querySettings(
  baseToken: string,
  options: { keyword?: string; category?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ term: string; category: string[]; definition: string; importance: number }[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.SETTING, {
      fieldIds: [
        SETTING_F.TERM, SETTING_F.CATEGORY,
        SETTING_F.DEFINITION, SETTING_F.IMPORTANCE,
      ],
      limit: Math.min(options.limit ?? 200, 200),
    }, signal),
  )

  const kw = options.keyword ?? ''
  return rows
    .map((r) => ({
      term: str(r[SETTING_F.TERM]),
      category: Array.isArray(r[SETTING_F.CATEGORY])
        ? (r[SETTING_F.CATEGORY] as unknown[]).map((x) => String(x))
        : [],
      definition: str(r[SETTING_F.DEFINITION]),
      importance: num(r[SETTING_F.IMPORTANCE]),
    }))
    .filter((s) => s.term !== '')
    .filter((s) => kw === '' || s.term.includes(kw) || s.definition.includes(kw))
    .filter((s) => options.category === undefined || s.category.includes(options.category))
    // 重要度高的排前面，便于模型优先看到关键设定
    .sort((a, b) => b.importance - a.importance)
}

/* ------------------------------------------------------------------ */
/* 人物                                                                */
/* ------------------------------------------------------------------ */

export interface CharacterInput {
  name: string
  alias?: string
  role?: string
  traits?: string[]
  catchphrase?: string
  motive?: string
  appearance?: string
  arcStage?: string
}

/** 创建或更新人物档案。 */
export async function upsertCharacter(
  baseToken: string,
  input: CharacterInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [CHARACTER_F.NAME]: input.name }
  if (input.alias !== undefined) fields[CHARACTER_F.ALIAS] = input.alias
  if (input.role !== undefined) fields[CHARACTER_F.ROLE] = input.role
  if (input.traits !== undefined) fields[CHARACTER_F.TRAITS] = input.traits
  if (input.catchphrase !== undefined) fields[CHARACTER_F.CATCHPHRASE] = input.catchphrase
  if (input.motive !== undefined) fields[CHARACTER_F.MOTIVE] = input.motive
  if (input.appearance !== undefined) fields[CHARACTER_F.APPEARANCE] = input.appearance
  if (input.arcStage !== undefined) fields[CHARACTER_F.ARC_STAGE] = input.arcStage
  return upsert(baseToken, TABLE.CHARACTER, CHARACTER_F.NAME, input.name, fields, signal)
}

/** 查询人物档案。 */
export async function queryCharacters(
  baseToken: string,
  options: { name?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  name: string; alias: string; role: string; traits: string[]
  catchphrase: string; motive: string; arcStage: string
}[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [
        CHARACTER_F.NAME, CHARACTER_F.ALIAS, CHARACTER_F.ROLE,
        CHARACTER_F.TRAITS, CHARACTER_F.CATCHPHRASE,
        CHARACTER_F.MOTIVE, CHARACTER_F.ARC_STAGE,
      ],
      limit: Math.min(options.limit ?? 200, 200),
    }, signal),
  )

  return rows
    .map((r) => ({
      name: str(r[CHARACTER_F.NAME]),
      alias: str(r[CHARACTER_F.ALIAS]),
      role: str(r[CHARACTER_F.ROLE]),
      traits: Array.isArray(r[CHARACTER_F.TRAITS])
        ? (r[CHARACTER_F.TRAITS] as unknown[]).map((x) => String(x))
        : [],
      catchphrase: str(r[CHARACTER_F.CATCHPHRASE]),
      motive: str(r[CHARACTER_F.MOTIVE]),
      arcStage: str(r[CHARACTER_F.ARC_STAGE]),
    }))
    .filter((c) => c.name !== '')
    .filter((c) => options.name === undefined || c.name === options.name)
}

/* ------------------------------------------------------------------ */
/* 大纲：卷与章节要点                                                    */
/* ------------------------------------------------------------------ */

export interface VolumeInput {
  name: string
  order?: number
  theme?: string
  status?: string
  summary?: string
}

/** 创建或更新卷。 */
export async function upsertVolume(
  baseToken: string,
  input: VolumeInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [VOLUME_F.NAME]: input.name }
  if (input.order !== undefined) fields[VOLUME_F.ORDER] = input.order
  if (input.theme !== undefined) fields[VOLUME_F.THEME] = input.theme
  if (input.status !== undefined) fields[VOLUME_F.STATUS] = [input.status]
  if (input.summary !== undefined) fields[VOLUME_F.SUMMARY] = input.summary
  return upsert(baseToken, TABLE.VOLUME, VOLUME_F.NAME, input.name, fields, signal)
}

/** 写入某章的大纲要点。章节不存在时抛错。 */
export async function setChapterOutline(
  baseToken: string,
  chapterNo: number,
  outline: string,
  options: { volume?: string; storyTime?: string } = {},
  signal?: AbortSignal,
): Promise<{ recordId: string; chapterNo: number }> {
  const recordId = await findChapterRecordId(baseToken, chapterNo, signal)
  if (recordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法写入大纲。请先用 novel_write_chapter 创建。`)
  }
  const fields: Fields = { [CHAPTER_F.OUTLINE]: outline }
  if (options.volume !== undefined) fields[CHAPTER_F.VOLUME] = options.volume
  if (options.storyTime !== undefined) fields[CHAPTER_F.STORY_TIME] = options.storyTime
  await base.updateRecords(baseToken, TABLE.CHAPTER, { [recordId]: fields }, signal)
  return { recordId, chapterNo }
}

/** 按章节号取章节记录 ID。 */
export async function findChapterRecordId(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return findBy(baseToken, TABLE.CHAPTER, CHAPTER_F.NO, chapterNo, signal)
}

/** 查询章节大纲（按章节号升序）。 */
export async function queryOutline(
  baseToken: string,
  options: { fromChapter?: number; toChapter?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  no: number; title: string; status: string; outline: string; words: number
}[]> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [
        CHAPTER_F.NO, CHAPTER_F.TITLE, CHAPTER_F.STATUS,
        CHAPTER_F.OUTLINE, CHAPTER_F.WORDS,
      ],
      sort: [{ field: CHAPTER_F.NO, desc: false }],
    }, signal),
  )

  return rows
    .map((r) => ({
      no: num(r[CHAPTER_F.NO]),
      title: str(r[CHAPTER_F.TITLE]),
      status: firstStr(r[CHAPTER_F.STATUS]),
      outline: str(r[CHAPTER_F.OUTLINE]),
      words: num(r[CHAPTER_F.WORDS]),
    }))
    .filter((c) => options.fromChapter === undefined || c.no >= options.fromChapter)
    .filter((c) => options.toChapter === undefined || c.no <= options.toChapter)
    .slice(0, options.limit ?? 500)
}

/* ------------------------------------------------------------------ */
/* 伏笔                                                                */
/* ------------------------------------------------------------------ */

export interface ForeshadowInput {
  content: string
  type?: string
  status?: string
  importance?: number
  note?: string
}

/** 创建或更新伏笔。 */
export async function upsertForeshadow(
  baseToken: string,
  input: ForeshadowInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [FORESHADOW_F.CONTENT]: input.content }
  if (input.type !== undefined) fields[FORESHADOW_F.TYPE] = [input.type]
  if (input.status !== undefined) fields[FORESHADOW_F.STATUS] = [input.status]
  if (input.importance !== undefined) fields[FORESHADOW_F.IMPORTANCE] = input.importance
  if (input.note !== undefined) fields[FORESHADOW_F.NOTE] = input.note
  return upsert(baseToken, TABLE.FORESHADOW, FORESHADOW_F.CONTENT, input.content, fields, signal)
}

/** 查询伏笔。status 为空返回全部。 */
export async function queryForeshadows(
  baseToken: string,
  options: { status?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ content: string; type: string; status: string; importance: number }[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.FORESHADOW, {
      fieldIds: [
        FORESHADOW_F.CONTENT, FORESHADOW_F.TYPE,
        FORESHADOW_F.STATUS, FORESHADOW_F.IMPORTANCE,
      ],
      limit: Math.min(options.limit ?? 200, 200),
    }, signal),
  )

  return rows
    .map((r) => ({
      content: str(r[FORESHADOW_F.CONTENT]),
      type: firstStr(r[FORESHADOW_F.TYPE]),
      status: firstStr(r[FORESHADOW_F.STATUS]),
      importance: num(r[FORESHADOW_F.IMPORTANCE]),
    }))
    .filter((f) => f.content !== '')
    .filter((f) => options.status === undefined || f.status === options.status)
    .sort((a, b) => b.importance - a.importance)
}

/* ------------------------------------------------------------------ */
/* 剧情线                                                              */
/* ------------------------------------------------------------------ */

export interface PlotlineInput {
  name: string
  type?: string
  status?: string
  description?: string
}

/** 创建或更新剧情线（主线 / 支线）。 */
export async function upsertPlotline(
  baseToken: string,
  input: PlotlineInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [PLOTLINE_F.NAME]: input.name }
  if (input.type !== undefined) fields[PLOTLINE_F.TYPE] = [input.type]
  if (input.status !== undefined) fields[PLOTLINE_F.STATUS] = [input.status]
  if (input.description !== undefined) fields[PLOTLINE_F.DESCRIPTION] = input.description
  return upsert(baseToken, TABLE.PLOTLINE, PLOTLINE_F.NAME, input.name, fields, signal)
}

/** 查询剧情线。 */
export async function queryPlotlines(
  baseToken: string,
  options: { type?: string } = {},
  signal?: AbortSignal,
): Promise<{ name: string; type: string; status: string; description: string }[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.PLOTLINE, {
      fieldIds: [
        PLOTLINE_F.NAME, PLOTLINE_F.TYPE,
        PLOTLINE_F.STATUS, PLOTLINE_F.DESCRIPTION,
      ],
      limit: 200,
    }, signal),
  )
  return rows
    .map((r) => ({
      name: str(r[PLOTLINE_F.NAME]),
      type: firstStr(r[PLOTLINE_F.TYPE]),
      status: firstStr(r[PLOTLINE_F.STATUS]),
      description: str(r[PLOTLINE_F.DESCRIPTION]),
    }))
    .filter((p) => p.name !== '')
    .filter((p) => options.type === undefined || p.type === options.type)
}

/* ------------------------------------------------------------------ */
/* 卡文救援：候选分支                                                    */
/* ------------------------------------------------------------------ */

export interface BranchInput {
  title: string
  description?: string
  adoptStatus?: string
  note?: string
}

/** 记录一条候选剧情分支（卡文救援）。 */
export async function upsertBranch(
  baseToken: string,
  input: BranchInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  const fields: Fields = { [BRANCH_F.TITLE]: input.title }
  if (input.description !== undefined) fields[BRANCH_F.DESCRIPTION] = input.description
  if (input.adoptStatus !== undefined) fields[BRANCH_F.ADOPT_STATUS] = [input.adoptStatus]
  if (input.note !== undefined) fields[BRANCH_F.NOTE] = input.note
  return upsert(baseToken, TABLE.BRANCH, BRANCH_F.TITLE, input.title, fields, signal)
}

/** 查询候选分支。 */
export async function queryBranches(
  baseToken: string,
  options: { adoptStatus?: string } = {},
  signal?: AbortSignal,
): Promise<{ title: string; description: string; adoptStatus: string }[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.BRANCH, {
      fieldIds: [BRANCH_F.TITLE, BRANCH_F.DESCRIPTION, BRANCH_F.ADOPT_STATUS],
      limit: 200,
    }, signal),
  )
  return rows
    .map((r) => ({
      title: str(r[BRANCH_F.TITLE]),
      description: str(r[BRANCH_F.DESCRIPTION]),
      adoptStatus: firstStr(r[BRANCH_F.ADOPT_STATUS]),
    }))
    .filter((b) => b.title !== '')
    .filter((b) => options.adoptStatus === undefined || b.adoptStatus === options.adoptStatus)
}

/* ------------------------------------------------------------------ */

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const firstStr = (v: unknown): string =>
  Array.isArray(v) && typeof v[0] === 'string' ? v[0] : str(v)
