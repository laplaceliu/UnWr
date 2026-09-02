/**
 * 设定 / 人物 / 大纲 / 伏笔 / 卷 / 分支 / 关系 的增删改查。
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
  RELATION_F, SETTING_F, TABLE, VOLUME_F,
} from '@unwr/schema'
import { awaitVisible } from './chapter.ts'

/**
 * 确保 select 字段包含将写入的选项（缺失则合并进字段定义）。
 *
 * 为什么必须自动补：select 是封闭列表，但小说的人物性格、设定分类
 * 本质开放——预置选项永远不够（实测用户写「沉默寡言」「人物」分类
 * 均触发 800030005）。写前读字段 → diff → 整体提交合并结果。
 *
 * 性能：每次 upsert 多一次 field-get + 至多一次 field-update。
 * 对「选项已齐」的常见路径只有 field-get 的开销。
 */
async function ensureSelectOptions(
  baseToken: string,
  table: string,
  fieldName: string,
  incoming: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const values = incoming.filter((v) => v.trim() !== '')
  if (values.length === 0) return

  const { field } = await base.getField(baseToken, table, fieldName, signal)
  if (field.type !== 'select') return

  const existing = new Set((field.options ?? []).map((o) => o.name))
  const missing = values.filter((v) => !existing.has(v))
  if (missing.length === 0) return

  // field-update 是 full PUT：必须提交含既有选项的完整定义
  await base.updateField(
    baseToken,
    table,
    fieldName,
    {
      name: field.name,
      type: 'select',
      ...field.multiple === undefined ? {} : { multiple: field.multiple },
      options: [
        ...(field.options ?? []),
        ...missing.map((name) => ({ name })),
      ],
    },
    signal,
  )
}
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
  // 分类是 select：先补齐缺失选项（用户可能用「人物」「事件」等未预置分类）
  if (input.category !== undefined) {
    await ensureSelectOptions(baseToken, TABLE.SETTING, SETTING_F.CATEGORY, input.category, signal)
  }
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
  // 性格标签是 select：先补齐缺失选项（人物性格本质开放，预置不够用）
  if (input.traits !== undefined) {
    await ensureSelectOptions(baseToken, TABLE.CHARACTER, CHARACTER_F.TRAITS, input.traits, signal)
  }
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
/* 人物关系                                                              */
/* ------------------------------------------------------------------ */

export interface RelationInput {
  /** 人物 A 的姓名（必须是 CHARACTER 表里已有的）。 */
  characterA: string
  /** 人物 B 的姓名（必须是 CHARACTER 表里已有的）。 */
  characterB: string
  /** 关系类型：师徒 / 血亲 / 敌对 / 爱慕 / 同盟 / 利用。 */
  type: string
  description?: string
  /** 起始章节号；用于"X 章起两人相识"。 */
  startChapter?: number
  /** 当前状态：存续 / 已破裂 / 已转化。 */
  status?: string
  /**
   * 强行覆盖软删除戳：默认对已被 deleteRelation 标记的关系，
   * upsertRelation 不会覆盖 status/description；需重新激活时传 true。
   */
  force?: boolean
}

/** 检测 description 字段是否已被 deleteRelation 打了 [已删除] 戳。 */
const hasDeleteStamp = (description: unknown): boolean =>
  typeof description === 'string' && description.includes('[已删除]')

/**
 * 读取关系现有描述与状态（用于软删除戳检测）。
 */
async function readRelationMeta(
  baseToken: string,
  a: string,
  b: string,
  type: string,
  signal?: AbortSignal,
): Promise<{ description: string; status: string } | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.RELATION, {
      fieldIds: [RELATION_F.DESCRIPTION, RELATION_F.STATUS],
      filter: {
        logic: 'and',
        conditions: [
          [RELATION_F.A, '==', a],
          [RELATION_F.B, '==', b],
          [RELATION_F.TYPE, '==', type],
        ],
      },
      limit: 1,
    }, signal),
  )
  const row = rows[0]
  if (row === undefined) return undefined
  return {
    description: str(row[RELATION_F.DESCRIPTION]),
    status: firstStr(row[RELATION_F.STATUS]),
  }
}

/**
 * 创建或更新一对人物关系。
 *
 * 去重 key = (characterA, characterB, type)：
 *   - A→B 同类型关系**只允许一条**（避免师徒关系被复制粘贴出 N 份）。
 *   - A→B 和 B→A 视为**同一条**（按字典序归一），写入时谁是 first 不影响去重。
 *   - 同对角色不同关系（如既是师徒又是敌对）允许共存。
 *
 * 起始章节、状态、描述可单独 patch：tools 层应允许只传其中之一。
 *
 * 软删除保护：若记录已被 `deleteRelation` 打了 `[已删除]` 戳，
 * 后续 `upsertRelation` 默认**不会覆盖** status/description 字段，
 * 防止误把删除戳抹平。startChapter 仍可更新（用于"这条关系从某章重新
 * 发生"等用例）。需强行覆盖请传 `force: true`。
 *
 * @throws CHARACTER 表查不到 A 或 B 时抛错（要求建模前先建人物档案）。
 */
export async function upsertRelation(
  baseToken: string,
  input: RelationInput,
  signal?: AbortSignal,
): Promise<UpsertResult> {
  if (input.characterA === '' || input.characterB === '') {
    throw new Error('characterA 和 characterB 都必须提供。')
  }
  if (input.characterA === input.characterB) {
    throw new Error('characterA 与 characterB 不能相同——人物不可能与自己建立关系。')
  }

  // 验证人物存在——避免关系指向幽灵角色。
  const allChars = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [CHARACTER_F.NAME],
    }, signal),
  )
  const charNames = new Set(
    allChars
      .map((r) => str(r[CHARACTER_F.NAME]))
      .filter((n) => n !== ''),
  )
  if (!charNames.has(input.characterA)) {
    throw new Error(
      `人物「${input.characterA}」在 CHARACTER 表中不存在。`
      + `请先用 novel_manage_character(action=upsert) 建档。`,
    )
  }
  if (!charNames.has(input.characterB)) {
    throw new Error(
      `人物「${input.characterB}」在 CHARACTER 表中不存在。`
      + `请先用 novel_manage_character(action=upsert) 建档。`,
    )
  }

  // 归一：A/B 字典序排序后再查，避免「李寻欢→阿飞」与「阿飞→李寻欢」重复入库。
  const sortedPair: string[] = [input.characterA, input.characterB].sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'))
  const a: string = sortedPair[0] ?? input.characterA
  const b: string = sortedPair[1] ?? input.characterB

  const existing = await findRelation(baseToken, a, b, input.type, signal)
  const existingMeta = existing !== undefined
    ? await readRelationMeta(baseToken, a, b, input.type, signal)
    : undefined
  const wasDeleted = existingMeta !== undefined
    && (hasDeleteStamp(existingMeta.description) || existingMeta.status === '已破裂')
  const skipPreserve = wasDeleted && input.force !== true

  const fields: Fields = {
    [RELATION_F.A]: a,
    [RELATION_F.B]: b,
    [RELATION_F.TYPE]: [input.type],
  }
  if (input.description !== undefined && input.description !== '') {
    // 软删除戳保护：保留 [已删除] 戳不被常规 upsert 抹平
    if (!skipPreserve) {
      fields[RELATION_F.DESCRIPTION] = input.description
    }
  }
  if (input.startChapter !== undefined && input.startChapter > 0) {
    // 起始章节允许在删除戳存在时仍然更新（用于"关系从 X 章重新发生"）
    fields[RELATION_F.START_CHAPTER] = input.startChapter
  }
  if (input.status !== undefined && input.status !== '') {
    if (!skipPreserve) {
      fields[RELATION_F.STATUS] = [input.status]
    }
  }

  const preservedWarning = skipPreserve
    ? ['关系已被软删除，status/description 字段未覆盖（需传 force=true 强行更新）。']
    : []

  if (existing !== undefined) {
    await base.updateRecords(baseToken, TABLE.RELATION, { [existing]: fields }, signal)
    return { recordId: existing, updated: true, warnings: preservedWarning }
  }

  const warnings: string[] = []
  const ids = await createRecordsWithSelfHeal(baseToken, TABLE.RELATION, [fields], signal, (msg) => {
    warnings.push(msg)
  })
  const recordId = ids[0]
  if (recordId === undefined) {
    throw new Error(`${TABLE.RELATION} 记录创建失败：未返回 record_id`)
  }

  await awaitVisible(
    async () => (await findRelation(baseToken, a, b, input.type, signal)) === recordId,
    signal,
    (msg) => { warnings.push(msg) },
  )

  return { recordId, updated: false, warnings }
}

/**
 * 按（归一后的 A,B,type）查找关系记录 ID。查不到返回 undefined。
 */
async function findRelation(
  baseToken: string,
  a: string,
  b: string,
  type: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // RELATION_F.TYPE 是单选 select → 字段存为数组（与 SETTING_F.CATEGORY 同形），
  // 飞书 list 过滤时按单字符串处理即可（select 单选在 list 层是普通字符串）。
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.RELATION, {
      fieldIds: [RELATION_F.A, RELATION_F.B, RELATION_F.TYPE],
      filter: {
        logic: 'and',
        conditions: [
          [RELATION_F.A, '==', a],
          [RELATION_F.B, '==', b],
          [RELATION_F.TYPE, '==', type],
        ],
      },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/** 查询人物关系网。character 可选；不传则返回整部作品所有关系。 */
export interface RelationRow {
  a: string
  b: string
  type: string
  status: string
  description: string
  startChapter: number
}

export async function queryRelations(
  baseToken: string,
  options: { character?: string; type?: string; status?: string } = {},
  signal?: AbortSignal,
): Promise<RelationRow[]> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.RELATION, {
      fieldIds: [
        RELATION_F.A, RELATION_F.B, RELATION_F.TYPE,
        RELATION_F.STATUS, RELATION_F.DESCRIPTION, RELATION_F.START_CHAPTER,
      ],
    }, signal),
  )

  return rows
    .map((r) => ({
      a: str(r[RELATION_F.A]),
      b: str(r[RELATION_F.B]),
      type: firstStr(r[RELATION_F.TYPE]),
      status: firstStr(r[RELATION_F.STATUS]),
      description: str(r[RELATION_F.DESCRIPTION]),
      startChapter: num(r[RELATION_F.START_CHAPTER]),
    }))
    .filter((rel) => rel.a !== '' && rel.b !== '')
    .filter((rel) => options.character === undefined || rel.a === options.character || rel.b === options.character)
    .filter((rel) => options.type === undefined || rel.type === options.type)
    .filter((rel) => options.status === undefined || rel.status === options.status)
    .sort((x, y) => x.a.localeCompare(y.a, 'zh-Hans-CN') || x.b.localeCompare(y.b, 'zh-Hans-CN'))
}

/**
 * 删除一条关系（按 A+B+type 三元组定位）。
 *
 * 安全说明：走**软删除**——把 description 标记为「已删除 @时间」，
 * 状态字段改成"已破裂"，其余字段保留。避免误删后无法回溯，
 * 也避免 tools 层暴露硬删除（readOnlySafeMode 下不应允许）。
 */
export async function deleteRelation(
  baseToken: string,
  characterA: string,
  characterB: string,
  type: string,
  signal?: AbortSignal,
): Promise<{ recordId: string | null }> {
  const sortedPair: string[] = [characterA, characterB].sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'))
  const a: string = sortedPair[0] ?? characterA
  const b: string = sortedPair[1] ?? characterB
  const existing = await findRelation(baseToken, a, b, type, signal)
  if (existing === undefined) {
    return { recordId: null }
  }
  await base.updateRecords(baseToken, TABLE.RELATION, {
    [existing]: {
      [RELATION_F.STATUS]: ['已破裂'],
      [RELATION_F.DESCRIPTION]: `[已删除] ${new Date().toISOString()}`,
    },
  }, signal)
  return { recordId: existing }
}

/* ------------------------------------------------------------------ */
/* 人物关系 → 注入上下文                                                  */
/* ------------------------------------------------------------------ */

/**
 * 取某人物涉及的全部关系，渲染成"- 王五（师徒 @第3章起）：养育之恩"行式字符串。
 *
 * 用于 context/builder.ts 注入"人物档案 → 关系网"节：
 * 模型在动笔前就知道"李白跟杜甫是师徒"，不至于写岔。
 */
export async function renderRelationLines(
  baseToken: string,
  characterName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const rels = await queryRelations(baseToken, { character: characterName }, signal)
  return rels.map((r) => {
    const other = r.a === characterName ? r.b : r.a
    const statusSuffix = r.status === '存续' || r.status === '' ? '' : `（${r.status}）`
    const chapterSuffix = r.startChapter > 0 ? ` @第${r.startChapter}章起` : ''
    const descSuffix = r.description === '' ? '' : `：${r.description}`
    return `- ${other}（${r.type}${statusSuffix}${chapterSuffix}）${descSuffix}`
  })
}

/* ------------------------------------------------------------------ */

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const firstStr = (v: unknown): string =>
  Array.isArray(v) && typeof v[0] === 'string' ? v[0] : str(v)
