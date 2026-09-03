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
  BRANCH_F, CHAPTER_STATUS, CHARACTER_F, CHAPTER_F, FORESHADOW_F, MEMORY_F, MEMORY_LEVEL,
  PLOTLINE_F, RELATION_F, SETTING_F, TABLE, VOLUME_F,
} from '@unwr/schema'
import { awaitVisible } from './chapter.ts'
import {
  findChapterRecordIdCached, rememberChapterRecordId,
} from './organize.ts'

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
import { createRecordWithLinks, createRecordsWithSelfHeal, updateRecordsWithSelfHeal } from './selfheal.ts'

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
  /** 关联字段（字段名 → 目标 recordId）。两阶段写入：先建标量再回填 link。 */
  links: Record<string, string[]> = {},
): Promise<UpsertResult> {
  const warnings: string[] = []
  const existing = await findBy(baseToken, table, keyField, keyValue, signal)

  // link 回填必须走 selfheal 版 update：它按 record-get 验证回填是否落库
  // （2026-09-03 实机事故：裸 update 在重名列/收敛窗口下静默失败，无验证
  // 就发现不了）。无 link 时保持裸 update——少一次验证读取。
  const hasLinks = Object.values(links).some((ids) => ids.length > 0)

  if (existing !== undefined) {
    if (hasLinks) {
      const patch: Fields = { ...fields }
      for (const [field, ids] of Object.entries(links)) {
        if (ids.length > 0) patch[field] = ids.map((id) => ({ id }))
      }
      await updateRecordsWithSelfHeal(baseToken, table, { [existing]: patch }, signal, (event) => {
        if (event.level === 'warn') warnings.push(event.message)
      })
    } else {
      await base.updateRecords(baseToken, table, { [existing]: fields }, signal)
    }
    return { recordId: existing, updated: true, warnings }
  }

  const recordId = await createRecordWithLinks(
    baseToken, table, fields, links, signal,
    (event) => { if (event.level === 'warn') warnings.push(event.message) },
  )

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

/**
 * 写入某章的大纲要点。
 *
 * 章节不存在时**自动创建章壳**（状态=大纲、标题=第 N 章）——大纲官先规划
 * 整卷章纲是自然工作流，此前"先建章再写大纲"的强制顺序曾让大纲官在
 * 章节创建前批量写章纲全部被拒（实机 2026-09-02 ×8）。
 *
 * 卷名是 link 字段（→ 卷表）：卷不存在时自动建同名卷壳，随后可由
 * upsert_volume 充实。
 */
export async function setChapterOutline(
  baseToken: string,
  chapterNo: number,
  outline: string,
  options: { volume?: string; storyTime?: string } = {},
  signal?: AbortSignal,
): Promise<{ recordId: string; chapterNo: number; created: boolean }> {
  const warnings: string[] = []
  const recordId = await findChapterRecordId(baseToken, chapterNo, signal)
  if (recordId !== undefined) {
    // 已有章节：直接 update。VOLUME 是 link → 解析卷名（缺卷则建壳）
    const fields: Fields = { [CHAPTER_F.OUTLINE]: outline }
    const volumeId = options.volume === undefined
      ? undefined
      : await ensureVolumeRecord(baseToken, options.volume, signal)
    if (volumeId !== undefined) fields[CHAPTER_F.VOLUME] = [{ id: volumeId }]
    if (options.storyTime !== undefined) fields[CHAPTER_F.STORY_TIME] = options.storyTime
    // 可能含 VOLUME link（且卷壳是刚建的）→ 走自愈版防 800030201
    await updateRecordsWithSelfHeal(baseToken, TABLE.CHAPTER, { [recordId]: fields }, signal, () => {})
    return { recordId, chapterNo, created: false }
  }

  // 自动建章：标量（NO/TITLE/OUTLINE/STATUS/STORY_TIME）+ VOLUME link 回填
  const scalarFields: Fields = {
    [CHAPTER_F.NO]: chapterNo,
    [CHAPTER_F.TITLE]: `第 ${chapterNo} 章`,
    [CHAPTER_F.OUTLINE]: outline,
    [CHAPTER_F.STATUS]: [CHAPTER_STATUS.OUTLINE],
  }
  if (options.storyTime !== undefined) scalarFields[CHAPTER_F.STORY_TIME] = options.storyTime
  const volumeId = options.volume === undefined
    ? undefined
    : await ensureVolumeRecord(baseToken, options.volume, signal)
  const newRecordId = await createRecordWithLinks(
    baseToken, TABLE.CHAPTER, scalarFields,
    volumeId === undefined ? {} : { [CHAPTER_F.VOLUME]: [volumeId] },
    signal, (event) => {
      // selfheal 修复（2026-09-03）：按 level 路由——
      // info = 还在退避重试中（attempt<4），大概率是平台 link 列收敛
      //   延迟（实测 attempt=2/3s 退避即可过），不打 console.warn 刷屏；
      // warn = 末次重试仍 missing，下一步会抛错——透出作为最终预警。
      if (event.level === 'warn') {
        warnings.push(event.message)
        console.warn(`[setChapterOutline] 第 ${chapterNo} 章:`, event.message)
      } else {
        // debug-only：调用方需要排查平台行为时可显式开启
        if (process.env['UNWR_DEBUG_SELFHEAL'] === '1') {
          console.log(`[setChapterOutline] 第 ${chapterNo} 章:`, event.message)
        }
      }
    },
  )
  if (warnings.length > 0) {
    console.warn(`[setChapterOutline] 第 ${chapterNo} 章自动建章警告:`, warnings.join('；'))
  }
  // 种写后缓存：紧随其后的二次写纲/起草要能立刻找到这章
  rememberChapterRecordId(baseToken, chapterNo, newRecordId)
  return { recordId: newRecordId, chapterNo, created: true }
}

/** 按卷名查找卷记录 id；不存在时创建同名卷壳（待 upsert_volume 充实）。 */
async function ensureVolumeRecord(
  baseToken: string,
  volumeName: string,
  signal?: AbortSignal,
): Promise<string> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.VOLUME, {
      fieldIds: [VOLUME_F.NAME],
      filter: { logic: 'and', conditions: [[VOLUME_F.NAME, '==', volumeName]] },
      limit: 1,
    }, signal),
  )
  const existing = rows[0]?.['__recordId']
  if (typeof existing === 'string') return existing
  const ids = await createRecordsWithSelfHeal(
    baseToken, TABLE.VOLUME,
    [{ [VOLUME_F.NAME]: volumeName }], signal, () => {},
  )
  const id = ids[0]
  if (id === undefined) throw new Error(`卷「${volumeName}」创建失败：未返回 record_id`)
  // 等卷记录在 listRecords 可查询命中后再返回——
  // setChapterOutline 创建章节后立即用此 id 写 link，回填 link
  // 的目标若还不可见，飞书 link 列虽返回 ok:true 但**实际不落库**
  // （memory 52080412 第③条：刚创建的记录回填 link 可能被服务端
  // 静默丢弃）。等到 listRecords 能命中=平台侧完全就绪，再交给
  // 调用方去做 link 写入，绝大多数情况下 attempt=1 即可落库。
  await awaitVisible(
    async () => {
      const r = base.matrixToObjects(
        await base.listRecords(baseToken, TABLE.VOLUME, {
          fieldIds: [VOLUME_F.NAME],
          filter: { logic: 'and', conditions: [[VOLUME_F.NAME, '==', volumeName]] },
          limit: 1,
        }, signal),
      )
      return r[0]?.['__recordId'] === id
    },
    signal,
    () => {}, // 兜底超时：调用方拿到 id 后由 selfheal 的 verifyLinkBackfill
              // 兜底，attempt=2/3s 退避可救回。**不抛错、不 console.warn**，
              // 避免在 E 修复前再次刷出"卷记录迟迟不可见"的伪警报。
    /* timeoutMs */ 3000,
  )
  return id
}

/**
 * 写入章节的张力评分（1-5 星）。
 *
 * 写入时机：
 *   - 章节状态由草稿→修订/定稿时由评审官或主编排官调用
 *   - 张力评分会进入 L0 上下文，用于「上一章张力曲线是否在本章延续」的判定
 *
 * 边界：
 *   - `score` 必须为 1-5 整数；越界会被钳制并写入警告
 *   - 章节不存在时抛错（要求建模前先建章节）
 */
export async function setChapterTension(
  baseToken: string,
  chapterNo: number,
  score: number,
  signal?: AbortSignal,
): Promise<{ recordId: string; chapterNo: number; score: number; warnings: string[] }> {
  const recordId = await findChapterRecordId(baseToken, chapterNo, signal)
  if (recordId === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法写入张力评分。请先用 novel_write_chapter 创建。`)
  }
  const clamped = Math.max(1, Math.min(5, Math.round(score)))
  const warnings: string[] = []
  if (clamped !== score) warnings.push(`张力评分已从 ${score} 钳制到 ${clamped}（合法范围 1-5）`)
  await base.updateRecords(baseToken, TABLE.CHAPTER, { [recordId]: { [CHAPTER_F.TENSION]: clamped } }, signal)
  return { recordId, chapterNo, score: clamped, warnings }
}

/**
 * 把覆盖某章区间的记忆条目批量置为「已过期」。
 *
 * 触发时机（05 文档 4.1 表第 2 行）：
 *   - 章节正文被改动后，主编排官调度此工具 → 区间内所有 MEMORY 记录 STALE=true
 *   - 之后重新生成章节摘要（覆盖 G6 流程）
 *
 * 选区规则：
 *   - LEVEL=章节：from<=to 且 to>=fromChapter 且 from<=toChapter 的都受影响
 *     （即与被改章节区间有交集）
 *   - LEVEL=卷：from<=fromChapter 的所有卷级摘要（粗粒度，卷级重写代价低）
 *   - LEVEL=全书：全部（全书级摘要一定依赖被改章节）
 *
 * @returns 受影响记录数 + 警告（无记录时为 warning）
 */
export async function markMemoriesStaleForChapter(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<{ affected: number; warnings: string[] }> {
  const warnings: string[] = []
  // 实测坑（2026-09-02 工具体检抓到）：lark-cli record-list 的 --limit
  // 上限是 200，传 500 直接 invalid arguments。超长作品记忆条目可能
  // 超过 200 条，届时需改分页拉取；当前先在满页时告警。
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.MEMORY, {
      fieldIds: [MEMORY_F.LEVEL, MEMORY_F.FROM_CHAPTER, MEMORY_F.TO_CHAPTER, MEMORY_F.STALE],
      limit: 200,
    }, signal),
  )
  if (rows.length >= 200) {
    warnings.push(`记忆表已满一页（${rows.length} 条），本次扫描可能不完整——请人工核对或改为分页拉取。`)
  }
  const updates: Record<string, { [MEMORY_F.STALE]: true }> = {}
  for (const row of rows) {
    const lvl = String(row[MEMORY_F.LEVEL] ?? '')
    const id = row['__recordId']
    if (typeof id !== 'string') continue
    const from = typeof row[MEMORY_F.FROM_CHAPTER] === 'number' ? row[MEMORY_F.FROM_CHAPTER] as number : null
    const to = typeof row[MEMORY_F.TO_CHAPTER] === 'number' ? row[MEMORY_F.TO_CHAPTER] as number : null
    let hit = false
    if (lvl === MEMORY_LEVEL.BOOK) {
      hit = true
    } else if (lvl === MEMORY_LEVEL.VOLUME) {
      hit = from === null || from <= chapterNo
    } else {
      // CHAPTER 级别：区间与 chapterNo 有交集
      hit = from !== null && to !== null && from <= chapterNo && chapterNo <= to
    }
    if (hit && row[MEMORY_F.STALE] !== true) {
      updates[id] = { [MEMORY_F.STALE]: true }
    }
  }
  if (Object.keys(updates).length === 0) {
    return { affected: 0, warnings: ['无记忆需要标记为过期。'] }
  }
  await base.updateRecords(baseToken, TABLE.MEMORY, updates, signal)
  return { affected: Object.keys(updates).length, warnings }
}

/** 按章节号取章节记录 ID。 */
/**
 * 章节号 → record ID。带写后缓存（见 organize.ts——create+update 两段式
 * 写入后列表索引有 ~6s 延迟，无缓存时写后立即查会扑空）。
 */
export async function findChapterRecordId(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return findChapterRecordIdCached(
    baseToken, chapterNo,
    (bt, no, sig) => findBy(bt, TABLE.CHAPTER, CHAPTER_F.NO, no, sig),
    signal,
  )
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
  /** 埋设章节号；章节还不存在时告警并跳过关联 */
  plantChapter?: number
  /** 计划回收章节号（回收窗口的截止点，供逾期检查） */
  planPayoffChapter?: number
  /** 实际回收章节号（回收时填） */
  actualPayoffChapter?: number
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

  // 章节关联：章节号 → 章节记录 id。章节还不存在（未建章纲壳）时不阻塞
  // 伏笔建档，但必须告警——否则「埋设章节」静默留空，伏笔逾期检查
  // （consistency H3）与待回收列表都会漏掉它。
  const preWarnings: string[] = []
  const links: Record<string, string[]> = {}
  const chapterLink = async (
    no: number | undefined,
    field: string,
    label: string,
  ): Promise<void> => {
    if (no === undefined) return
    const rid = await findChapterRecordId(baseToken, no, signal)
    if (rid === undefined) {
      preWarnings.push(
        `第 ${no} 章不存在，「${label}」未关联。可先用 novel_manage_outline 建章后重新 upsert 补上。`,
      )
      return
    }
    links[field] = [rid]
  }
  await chapterLink(input.plantChapter, FORESHADOW_F.PLANT_CHAPTER, '埋设章节')
  await chapterLink(input.planPayoffChapter, FORESHADOW_F.PLAN_PAYOFF_CHAPTER, '计划回收章节')
  await chapterLink(input.actualPayoffChapter, FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER, '实际回收章节')

  const r = await upsert(baseToken, TABLE.FORESHADOW, FORESHADOW_F.CONTENT, input.content, fields, signal, links)
  return { ...r, warnings: [...preWarnings, ...r.warnings] }
}

/** 章节表 recordId → 章节号 映射（供 link 单元格反解章节号）。 */
async function chapterNoByRecordId(
  baseToken: string,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.NO],
      limit: 200,
    }, signal),
  )
  const m = new Map<string, number>()
  for (const r of rows) {
    const id = r['__recordId']
    const no = r[CHAPTER_F.NO]
    if (typeof id === 'string' && typeof no === 'number') m.set(id, no)
  }
  return m
}

/** link 单元格 → 首个 recordId（空/异形单元格返回 undefined）。 */
function firstLinkId(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v
  if (first === undefined || first === null) return undefined
  if (typeof first === 'object' && 'id' in first) {
    const id = (first as { id: unknown }).id
    return typeof id === 'string' ? id : undefined
  }
  return typeof first === 'string' && first !== '' ? first : undefined
}

/**
 * 把可能 undefined 的字段展开到对象里——undefined/null 时**不写入键**。
 *
 * 解决 DSH `value is not lossless JSON` 错（实机 2026-09-03）：
 *   - DSH 的 `@deepseek-ai/dsh-tools/snapshotJsonValue` 会逐属性 visit 对象值；
 *     遇 undefined 视为不可序列化，**整对象拒收**。
 *   - 但 `JSON.stringify` 在这种场景下会**丢弃** undefined 键——dev/本地调试
 *     看不出来，到 DSH 那就炸。这就是「看得见的对，DSH 拒」的不一致。
 *   - 实机踩坑：`novel_manage_foreshadow {action:"query"}` 在 link
 *     字段不可解章节号时（章节记录不存在 / link 是空数组 / noMap 为空），
 *     `chapterNoOf()` 返回 undefined 直接进对象，DSH 拒。
 *
 * 用法（必须 spread 嵌入字面量，return 容器需再包一层）：
 *   return {
 *     content: str(...),
 *     type: firstStr(...),
 *     ...presentSparse('plantChapter', chapterNoOf(...)),
 *     ...presentSparse('planPayoffChapter', chapterNoOf(...)),
 *   }
 * 而不是 `{ plantChapter: chapterNoOf(...) }`。
 *
 * 模式一致的 4 个 query 都要走这条路：`queryForeshadows`
 * / `queryBookSummaries` 等产 optional 章节号/章节列表的位置。
 */
function presentSparse<K extends string, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  return (value === null || value === undefined
    ? {}
    : ({ [key]: value } as { [P in K]: V }))
}

/** link 单元格 → 全部 recordId。 */
function allLinkIds(v: unknown): string[] {
  if (!Array.isArray(v)) {
    const one = firstLinkId(v)
    return one === undefined ? [] : [one]
  }
  return v.map((item) => firstLinkId(item)).filter((id): id is string => id !== undefined)
}

/** 查询伏笔。status 为空返回全部。章节号由 link 反解。 */
export async function queryForeshadows(
  baseToken: string,
  options: { status?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{
  content: string; type: string; status: string; importance: number
  plantChapter?: number; planPayoffChapter?: number; actualPayoffChapter?: number
}[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.FORESHADOW, {
      fieldIds: [
        FORESHADOW_F.CONTENT, FORESHADOW_F.TYPE,
        FORESHADOW_F.STATUS, FORESHADOW_F.IMPORTANCE,
        FORESHADOW_F.PLANT_CHAPTER, FORESHADOW_F.PLAN_PAYOFF_CHAPTER,
        FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER,
      ],
      limit: Math.min(options.limit ?? 200, 200),
    }, signal),
  )
  // 只有存在带章节的伏笔时才需要章节映射（省一次章节表查询）
  const noMap = new Map<string, number>()
  const chapterNoOf = (v: unknown): number | undefined => {
    const id = firstLinkId(v)
    if (id === undefined) return undefined
    if (noMap.size === 0) return undefined
    return noMap.get(id)
  }
  const needsMap = rows.some((r) =>
    firstLinkId(r[FORESHADOW_F.PLANT_CHAPTER]) !== undefined
    || firstLinkId(r[FORESHADOW_F.PLAN_PAYOFF_CHAPTER]) !== undefined
    || firstLinkId(r[FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER]) !== undefined)
  if (needsMap) {
    for (const [id, no] of await chapterNoByRecordId(baseToken, signal)) noMap.set(id, no)
  }

  return rows
    .map((r) => ({
      content: str(r[FORESHADOW_F.CONTENT]),
      type: firstStr(r[FORESHADOW_F.TYPE]),
      status: firstStr(r[FORESHADOW_F.STATUS]),
      importance: num(r[FORESHADOW_F.IMPORTANCE]),
      // 章节号是 link 反解字段——章节记录不存在时 chapterNoOf() 回 undefined，
      // 必须用 presentSparse 跳过该键，否则 DSH 会拒整个对象（lossless JSON）。
      ...presentSparse('plantChapter', chapterNoOf(r[FORESHADOW_F.PLANT_CHAPTER])),
      ...presentSparse('planPayoffChapter', chapterNoOf(r[FORESHADOW_F.PLAN_PAYOFF_CHAPTER])),
      ...presentSparse('actualPayoffChapter', chapterNoOf(r[FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER])),
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
  /**
   * 剧情线覆盖的章节号列表（整体替换语义：每次 upsert 传全量）。
   * breakthrough 用它判断「本章是否触发该剧情线」——不填则该线永远不激活。
   */
  chapterNos?: number[]
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

  const preWarnings: string[] = []
  const links: Record<string, string[]> = {}
  if (input.chapterNos !== undefined) {
    const ids: string[] = []
    for (const no of input.chapterNos) {
      const rid = await findChapterRecordId(baseToken, no, signal)
      if (rid === undefined) {
        preWarnings.push(
          `第 ${no} 章不存在，未关联到剧情线「${input.name}」。`
            + `可先建章后重新 upsert（chapterNos 需传全量）。`,
        )
        continue
      }
      ids.push(rid)
    }
    // 整体替换语义：即使部分章节缺失也要写回已解析的部分，
    // 否则一次手误就要永远带着错误的全量列表
    links[PLOTLINE_F.CHAPTERS] = ids
  }

  const r = await upsert(baseToken, TABLE.PLOTLINE, PLOTLINE_F.NAME, input.name, fields, signal, links)
  return { ...r, warnings: [...preWarnings, ...r.warnings] }
}

/** 查询剧情线。 */
export async function queryPlotlines(
  baseToken: string,
  options: { type?: string } = {},
  signal?: AbortSignal,
): Promise<{ name: string; type: string; status: string; description: string; chapters?: number[] }[]> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.PLOTLINE, {
      fieldIds: [
        PLOTLINE_F.NAME, PLOTLINE_F.TYPE,
        PLOTLINE_F.STATUS, PLOTLINE_F.DESCRIPTION, PLOTLINE_F.CHAPTERS,
      ],
      limit: 200,
    }, signal),
  )
  const needsMap = rows.some((r) => allLinkIds(r[PLOTLINE_F.CHAPTERS]).length > 0)
  const noMap = needsMap ? await chapterNoByRecordId(baseToken, signal) : new Map<string, number>()
  return rows
    .map((r) => {
      const chapterIds = allLinkIds(r[PLOTLINE_F.CHAPTERS])
      const chapters = chapterIds
        .map((id) => noMap.get(id))
        .filter((no): no is number => no !== undefined)
        .sort((a, b) => a - b)
      return {
        name: str(r[PLOTLINE_F.NAME]),
        type: firstStr(r[PLOTLINE_F.TYPE]),
        status: firstStr(r[PLOTLINE_F.STATUS]),
        description: str(r[PLOTLINE_F.DESCRIPTION]),
        ...(chapterIds.length === 0 ? {} : { chapters }),
      }
    })
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

/**
 * 关系去重缓存（写后即记，TTL 60s）。
 *
 * 为什么需要：关系记录走「create 标量 + update 回填 link」两段式，写入后
 * 列表索引有 ~6s 延迟（实机 2026-09-02：awaitVisible 等 6.1s 仍查不到）。
 * 期间同对人物的再次 upsert 走 findRelation（列表读）查不到 → 重复建档。
 * 缓存命中时按 record ID 直读（getRecords，无列表索引延迟）校验软删除戳，
 * 完全绕开列表延迟窗口。
 *
 * 局限：仅进程内有效。人物官是唯一写方且单委托内串行调用，实际足够。
 */
const relationCache = new Map<string, { recordId: string; at: number }>()
const RELATION_CACHE_TTL = 60_000
const RELATION_CACHE_MAX = 200

const relationCacheKey = (a: string, b: string, type: string): string => `${a}|${b}|${type}`

function relationCacheGet(key: string): string | undefined {
  const entry = relationCache.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > RELATION_CACHE_TTL) {
    relationCache.delete(key)
    return undefined
  }
  return entry.recordId
}

function relationCacheSet(key: string, recordId: string): void {
  if (relationCache.size >= RELATION_CACHE_MAX) {
    // 淘汰最早写入的一条
    const oldest = [...relationCache.entries()]
      .sort((x, y) => x[1].at - y[1].at)[0]
    if (oldest !== undefined) relationCache.delete(oldest[0])
  }
  relationCache.set(key, { recordId, at: Date.now() })
}

/** 测试钩子：清空去重缓存（relation-dedup.spec 每个用例间隔离用）。 */
export function clearRelationCacheForTests(): void {
  relationCache.clear()
}

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
 * 从 link 字段单元格提取 record ID 列表。
 * 飞书 link 字段读出来是 [{id}] 数组（旧数据/部分接口可能是裸字符串数组）。
 */
function linkIds(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v !== '' ? [v] : []
  return v.map((x) =>
    typeof x === 'object' && x !== null && 'id' in x
      ? String((x as { id: unknown }).id)
      : String(x),
  ).filter((s) => s !== '')
}

/**
 * 批量解析人物姓名 → record ID。
 *
 * 为什么必须转 ID：RELATION_F.A/B 是**双向关联字段**（link 到 CHARACTER 表），
 * 飞书 link 字段只接受 record ID（写入格式 [{id}]）。直接写姓名字符串会报
 * not_found——实机踩坑 2026-09-02：人物官连续 12 次 upsertRelation 全部
 * not_found，就是因为验证过姓名存在后仍把姓名写进了 link 字段。
 */
async function resolveCharacterIdMap(
  baseToken: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [CHARACTER_F.NAME],
    }, signal),
  )
  const map = new Map<string, string>()
  for (const r of rows) {
    const name = str(r[CHARACTER_F.NAME])
    const rid = str(r['__recordId'])
    if (name !== '' && rid !== '') map.set(name, rid)
  }
  const missing = [...new Set(names)].filter((n) => !map.has(n))
  if (missing.length > 0) {
    throw new Error(
      `人物「${missing.join('」「')}」在 CHARACTER 表中不存在。`
      + `请先用 novel_manage_character(action=upsert) 建档。`,
    )
  }
  return map
}

/**
 * 按 record ID 直读关系描述与状态（软删除戳检测的缓存路径）。
 *
 * getRecords 按ID读取不经过列表索引，无 ~6s 写入延迟；
 * 记录不存在时返回 undefined（调用方据此失效缓存）。
 */
async function readRelationMetaById(
  baseToken: string,
  recordId: string,
  signal?: AbortSignal,
): Promise<{ description: string; status: string } | undefined> {
  const rows = base.matrixToObjects(
    await base.getRecords(baseToken, TABLE.RELATION, [recordId], signal),
  )
  const row = rows.find((r) => str(r['__recordId']) === recordId)
  if (row === undefined) return undefined
  return {
    description: str(row[RELATION_F.DESCRIPTION]),
    status: firstStr(row[RELATION_F.STATUS]),
  }
}

/**
 * 读取关系现有描述与状态（用于软删除戳检测）。aId/bId 是 CHARACTER record ID。
 */
async function readRelationMeta(
  baseToken: string,
  aId: string,
  bId: string,
  type: string,
  signal?: AbortSignal,
): Promise<{ description: string; status: string } | undefined> {
  const rows = base.matrixToObjects(
    // 不传 fieldIds：CLI 对 link 字段名的 --field-id 投影会静默 ignore
    // （实机 2026-09-02：--field-id 人物A 被丢弃，link 列缺失）。
    // 关系表是窄表，全字段拉取代价可忽略。
    await base.listAllRecords(baseToken, TABLE.RELATION, {}, signal),
  )
  const row = rows.find((r) => {
    const ra = linkIds(r[RELATION_F.A])[0]
    const rb = linkIds(r[RELATION_F.B])[0]
    return ra === aId && rb === bId && firstStr(r[RELATION_F.TYPE]) === type
  })
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

  // 解析姓名 → record ID（顺带验证人物存在，避免关系指向幽灵角色）。
  const ids = await resolveCharacterIdMap(
    baseToken, [input.characterA, input.characterB], signal,
  )
  const idA = ids.get(input.characterA) as string
  const idB = ids.get(input.characterB) as string

  // 归一：按 record ID 字典序排序后再查，避免「A→B」与「B→A」重复入库
  //（用 ID 而非姓名做去重 key，人物改名不会产生重复关系）。
  const sortedPair: string[] = [idA, idB].sort((x, y) => x.localeCompare(y))
  const a: string = sortedPair[0] ?? idA
  const b: string = sortedPair[1] ?? idB

  // 去重三级查找：进程内缓存（无延迟）→ 按ID校验 → 列表 findRelation（有 ~6s 窗口）
  const cacheKey = relationCacheKey(a, b, input.type)
  let existing: string | undefined
  let existingMeta: { description: string; status: string } | undefined

  const cached = relationCacheGet(cacheKey)
  if (cached !== undefined) {
    existingMeta = await readRelationMetaById(baseToken, cached, signal)
    if (existingMeta !== undefined) {
      existing = cached
    } else {
      // 缓存指向的记录已不存在（被物理删除/外部清库）→ 失效并回退列表查找
      relationCache.delete(cacheKey)
    }
  }
  if (existing === undefined) {
    existing = await findRelation(baseToken, a, b, input.type, signal)
    if (existing !== undefined) {
      existingMeta = await readRelationMeta(baseToken, a, b, input.type, signal)
    }
  }

  const wasDeleted = existingMeta !== undefined
    && (hasDeleteStamp(existingMeta.description) || existingMeta.status === '已破裂')
  const skipPreserve = wasDeleted && input.force !== true

  // START_CHAPTER 也是 link 字段（→ 章节表）：章节号解析为 record id，
  // 章节不存在时降级为 warning（关系本身仍入库）。
  const warnings: string[] = []
  let startChapterId: string | undefined
  if (input.startChapter !== undefined && input.startChapter > 0) {
    startChapterId = await findChapterRecordId(baseToken, input.startChapter, signal)
    if (startChapterId === undefined) {
      warnings.push(`起始章节第 ${input.startChapter} 章不存在，START_CHAPTER 关联未写入。`)
    }
  }

  // 标量字段（create 用）；A/B/START_CHAPTER 是 link，走回填
  const scalarFields: Fields = {
    [RELATION_F.TYPE]: [input.type],
  }
  if (input.description !== undefined && input.description !== '') {
    // 软删除戳保护：保留 [已删除] 戳不被常规 upsert 抹平
    if (!skipPreserve) {
      scalarFields[RELATION_F.DESCRIPTION] = input.description
    }
  }
  if (input.status !== undefined && input.status !== '') {
    if (!skipPreserve) {
      scalarFields[RELATION_F.STATUS] = [input.status]
    }
  }
  const linkFields: Record<string, string[]> = {
    [RELATION_F.A]: [a],
    [RELATION_F.B]: [b],
    ...(startChapterId === undefined ? {} : { [RELATION_F.START_CHAPTER]: [startChapterId] }),
  }

  const preservedWarning = skipPreserve
    ? ['关系已被软删除，status/description 字段未覆盖（需传 force=true 强行更新）。']
    : []

  if (existing !== undefined) {
    // update 可以直接写 link（实证 OK），与 create 的两段式不同
    const patch: Fields = {
      [RELATION_F.A]: [{ id: a }],
      [RELATION_F.B]: [{ id: b }],
      ...(startChapterId === undefined ? {} : { [RELATION_F.START_CHAPTER]: [{ id: startChapterId }] }),
      ...scalarFields,
    }
    // 含 link 字段（A/B/START_CHAPTER）→ 必须走自愈版：新库 link 字段
    // 收敛期会报 800030201（实机 2026-09-02：裸调用在反向 upsert 时炸）
    await updateRecordsWithSelfHeal(baseToken, TABLE.RELATION, { [existing]: patch }, signal, (event) => {
      if (event.level === 'warn') warnings.push(event.message)
    })
    relationCacheSet(cacheKey, existing)
    return { recordId: existing, updated: true, warnings: [...preservedWarning, ...warnings] }
  }

  const recordId = await createRecordWithLinks(
    baseToken, TABLE.RELATION, scalarFields, linkFields, signal,
    (event) => { if (event.level === 'warn') warnings.push(event.message) },
  )
  relationCacheSet(cacheKey, recordId)

  await awaitVisible(
    async () => (await findRelation(baseToken, a, b, input.type, signal)) === recordId,
    signal,
    (msg) => { warnings.push(msg) },
  )

  return { recordId, updated: false, warnings }
}

/**
 * 按（归一后的 A,B,type）查找关系记录 ID。aId/bId 是 CHARACTER record ID。
 * 查不到返回 undefined。
 *
 * 为什么本地过滤而不下推 filter：飞书 bitable 的 **link 字段不支持
 * `==` 值过滤**（实机报 800030201 not_found，2026-09-02）——即便值是
 * record ID 也不行。关系表量级很小（数十条），全量拉取后本地比对，
 * 顺带绕开 select 字段过滤在 list 层的各种怪癖。
 */
async function findRelation(
  baseToken: string,
  aId: string,
  bId: string,
  type: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    // 不传 fieldIds：link 字段名的投影会被 CLI 静默 ignore（见 readRelationMeta）
    await base.listAllRecords(baseToken, TABLE.RELATION, {}, signal),
  )
  const hit = rows.find((r) => {
    const ra = linkIds(r[RELATION_F.A])[0]
    const rb = linkIds(r[RELATION_F.B])[0]
    return ra === aId && rb === bId && firstStr(r[RELATION_F.TYPE]) === type
  })
  const id = hit?.['__recordId']
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
    // 不传 fieldIds：link 字段名的投影会被 CLI 静默 ignore（见 readRelationMeta）
    await base.listAllRecords(baseToken, TABLE.RELATION, {}, signal),
  )

  // A/B 是 link 字段（存 record ID）→ 反解为姓名输出。
  const idToName = await characterNameMap(baseToken, signal)
  const nameOf = (v: unknown): string => {
    const first = linkIds(v)[0]
    return first !== undefined ? (idToName.get(first) ?? first) : ''
  }

  // START_CHAPTER 也是 link（→ 章节表）：读回只有 record id，
  // 必须映射回章节号——旧代码 num() 作用在 link 单元格上恒 0。
  const chapterNoByRecordId = new Map<string, number>(
    base.matrixToObjects(
      await base.listAllRecords(baseToken, TABLE.CHAPTER, { fieldIds: [CHAPTER_F.NO] }, signal),
    ).map((r) => [str(r['__recordId']), num(r[CHAPTER_F.NO])]),
  )

  return rows
    .map((r) => ({
      a: nameOf(r[RELATION_F.A]),
      b: nameOf(r[RELATION_F.B]),
      type: firstStr(r[RELATION_F.TYPE]),
      status: firstStr(r[RELATION_F.STATUS]),
      description: str(r[RELATION_F.DESCRIPTION]),
      startChapter: linkIds(r[RELATION_F.START_CHAPTER])[0] !== undefined
        ? chapterNoByRecordId.get(linkIds(r[RELATION_F.START_CHAPTER])[0] as string) ?? 0
        : 0,
    }))
    .filter((rel) => rel.a !== '' && rel.b !== '')
    .filter((rel) => options.character === undefined || rel.a === options.character || rel.b === options.character)
    .filter((rel) => options.type === undefined || rel.type === options.type)
    .filter((rel) => options.status === undefined || rel.status === options.status)
    .sort((x, y) => x.a.localeCompare(y.a, 'zh-Hans-CN') || x.b.localeCompare(y.b, 'zh-Hans-CN'))
}

/** CHARACTER record ID → 姓名 映射（queryRelations 反解 link 字段用）。 */
async function characterNameMap(
  baseToken: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [CHARACTER_F.NAME],
    }, signal),
  )
  const map = new Map<string, string>()
  for (const r of rows) {
    const name = str(r[CHARACTER_F.NAME])
    const rid = str(r['__recordId'])
    if (name !== '' && rid !== '') map.set(rid, name)
  }
  return map
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
  const ids = await resolveCharacterIdMap(
    baseToken, [characterA, characterB], signal,
  )
  const sortedPair: string[] = [ids.get(characterA) ?? '', ids.get(characterB) ?? '']
    .sort((x, y) => x.localeCompare(y))
  const a: string = sortedPair[0] ?? ''
  const b: string = sortedPair[1] ?? ''
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
