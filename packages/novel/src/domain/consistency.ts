/**
 * 一致性检查（规则型）。
 *
 * 按 docs/requirements/05 的设计，检查项分两类：
 *
 *   **规则型** —— 查表即可判定，不需要模型。成本低、结果确定、无幻觉。
 *       H3 伏笔未回收、H4 时间线矛盾、H5 人物方位/状态矛盾、H6 称谓一致性
 *
 *   **语义型** —— 需要模型判断（H1 设定冲突、H2 人设崩坏、H7 前后文矛盾）。
 *       本模块**不做**语义型，而是生成供模型审阅的「检查清单」，
 *       由模型在会话中结合自己的判断给出结论。
 *
 * 为什么这样切分：规则型确定且零成本，应优先做；语义型交给模型，
 * 避免在工具里塞一个二次模型调用（贵、慢、且难以验证）。
 *
 * @module @unwr/novel/domain/consistency
 */

import { base } from '@unwr/feishu'
import {
  CHARACTER_F, CHAPTER_F, EVENT_F, FORESHADOW_F, ISSUE_F,
  TABLE,
} from '@unwr/schema'
import type { ChapterRef } from '../context/builder.ts'
import { createRecordsWithSelfHeal } from './selfheal.ts'

/** 问题类型（与检查问题表「问题类型」选项对应）。 */
export const ISSUE_TYPE = {
  SETTING_CONFLICT: '设定冲突',
  CHARACTER_BREAK: '人设崩坏',
  FORESHADOW: '伏笔未回收',
  TIMELINE: '时间线矛盾',
  PRESENCE: '方位矛盾',
  ADDRESS: '称谓不一致',
} as const

/** 处理状态。 */
export const ISSUE_STATUS = {
  OPEN: '待处理',
  FIXED: '已修复',
  IGNORED: '已忽略',
} as const

/** 一条检查结果。 */
export interface Issue {
  /** 问题类型 */
  type: string
  /** 严重度 1-5 */
  severity: number
  /** 问题标题 */
  title: string
  /** 定位描述（章节号、记录、关键词等） */
  location: string
  /** 关联章节号（若有） */
  chapterNo?: number
  /** 关联人物名（若有） */
  character?: string
  /** 置信度：1.0 = 规则确定；<1.0 = 需人工/模型确认 */
  confidence: number
}

/** 检查入参。 */
export interface CheckInput {
  /** 当前最新章节号（作为"现在"的基准） */
  currentChapterNo?: number
  /** 伏笔回收容差（章），默认 3 */
  payoffTolerance?: number
  /** 时间线检查是否启用（依赖故事内时间的填写质量） */
  checkTimeline?: boolean
}

/**
 * 运行全部规则型检查。
 *
 * 单张表查询失败时降级为空，不阻断其他检查项。
 */
export async function runRuleChecks(
  baseToken: string,
  input: CheckInput = {},
  signal?: AbortSignal,
): Promise<{ issues: Issue[]; checkedTables: string[]; skipped: string[] }> {
  const checkedTables: string[] = []
  const skipped: string[] = []
  const issues: Issue[] = []

  const tolerance = input.payoffTolerance ?? 3

  // 并行拉取所需的全部数据
  const [chapterRows, foreshadowRows, stateRows, eventRows, characterRows] = await Promise.all([
    safeList(baseToken, TABLE.CHAPTER, [
      CHAPTER_F.TITLE, CHAPTER_F.NO, CHAPTER_F.STATUS, CHAPTER_F.DOC_URL,
    ], signal, checkedTables, skipped, { sort: [{ field: CHAPTER_F.NO, desc: false }] }),
    safeList(baseToken, TABLE.FORESHADOW, [
      FORESHADOW_F.CONTENT, FORESHADOW_F.STATUS, FORESHADOW_F.IMPORTANCE,
      FORESHADOW_F.PLANT_CHAPTER, FORESHADOW_F.PLAN_PAYOFF_CHAPTER,
      FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER,
    ], signal, checkedTables, skipped),
    safeList(baseToken, TABLE.CHARACTER_STATE, [
      '人物', '章节', '所在位置', '身体状况', '情绪状态', '持有物品', '状态摘要',
    ], signal, checkedTables, skipped),
    safeList(baseToken, TABLE.EVENT, [
      EVENT_F.NAME, EVENT_F.CHAPTER, EVENT_F.STORY_TIME, EVENT_F.LOCATION, EVENT_F.SUMMARY,
    ], signal, checkedTables, skipped),
    safeList(baseToken, TABLE.CHARACTER, [
      CHARACTER_F.NAME, CHARACTER_F.ALIAS,
    ], signal, checkedTables, skipped),
  ])

  const chapters: ChapterRef[] = chapterRows.map((r) => ({
    recordId: str(r['__recordId']),
    no: num(r[CHAPTER_F.NO]),
    title: str(r[CHAPTER_F.TITLE]),
  }))
  const chapterNoToTitle = new Map(chapters.map((c) => [c.no, c.title]))
  /**
   * link 字段读回时**只有 record id**（形如 `[{id: 'recXX'}]`），
   * 不含章节号。要判断"计划第几章回收"，必须先把 record id 映射回章节号。
   */
  const recordIdToChapterNo = new Map(
    chapters.filter((c) => c.recordId !== '').map((c) => [c.recordId, c.no]),
  )

  // 当前进度：未指定时取最大章节号
  const currentNo = input.currentChapterNo
    ?? chapters.reduce((max, c) => (c.no > max ? c.no : max), 0)

  issues.push(...checkForeshadows(
    foreshadowRows, chapterNoToTitle, recordIdToChapterNo, currentNo, tolerance,
  ))
  issues.push(...checkPresence(stateRows, chapterNoToTitle, recordIdToChapterNo))

  if (input.checkTimeline === true) {
    issues.push(...checkTimeline(eventRows, chapterNoToTitle, recordIdToChapterNo))
  }

  return { issues, checkedTables, skipped }
}

/* ------------------------------------------------------------------ */
/* H3 伏笔未回收                                                        */
/* ------------------------------------------------------------------ */

/**
 * 已埋设但超出计划回收窗口的伏笔。
 *
 * 判定：`状态 = 已埋设` 且 `当前章节号 > 计划回收章节号 + 容差`。
 * 严重度由伏笔重要度直接映射——重要度 5 的主线伏笔逾期最严重。
 */
export function checkForeshadows(
  rows: Record<string, unknown>[],
  chapterNoToTitle: ReadonlyMap<number, string>,
  recordIdToChapterNo: ReadonlyMap<string, number>,
  currentNo: number,
  tolerance: number,
): Issue[] {
  const issues: Issue[] = []

  for (const r of rows) {
    const status = firstStr(r[FORESHADOW_F.STATUS])
    if (status !== '已埋设') continue

    const content = str(r[FORESHADOW_F.CONTENT])
    if (content === '') continue

    const importance = num(r[FORESHADOW_F.IMPORTANCE]) || 3
    const planNo = linkFirstNo(
      r[FORESHADOW_F.PLAN_PAYOFF_CHAPTER], chapterNoToTitle, recordIdToChapterNo,
    )
    const plantNo = linkFirstNo(
      r[FORESHADOW_F.PLANT_CHAPTER], chapterNoToTitle, recordIdToChapterNo,
    )

    // 无计划回收章节：按已埋设章节 + 一个默认窗口（20 章）估算
    const deadline = planNo ?? (plantNo === undefined ? undefined : plantNo + 20)
    if (deadline === undefined) continue
    if (currentNo <= deadline + tolerance) continue

    const overdue = currentNo - deadline
    issues.push({
      type: ISSUE_TYPE.FORESHADOW,
      // 重要度 1-5 直接作为严重度，再按逾期程度加 1
      severity: Math.min(5, importance + (overdue > 10 ? 1 : 0)),
      title: `伏笔逾期未回收：${content}`,
      location: `计划第 ${deadline} 章回收，当前已到第 ${currentNo} 章（逾期 ${overdue} 章）`,
      ...plantNo === undefined ? {} : { chapterNo: plantNo },
      confidence: 1,
    })
  }

  // 严重度降序，重要的问题排前面
  return issues.sort((a, b) => b.severity - a.severity)
}

/* ------------------------------------------------------------------ */
/* H5 人物方位 / 状态矛盾                                               */
/* ------------------------------------------------------------------ */

/**
 * 人物状态快照之间的矛盾。
 *
 * 检查两类：
 *   H5-a 分身：相邻两章的位置不同，但中间没有任何"移动"类事件可解释
 *   H5-b 状态跳变：身体状况/持有物品在相邻快照间发生无解释的突变
 *
 * 这是**启发式**检查：位置变化很可能有正当理由（剧情中移动了），
 * 因此 confidence 设为 0.6，提示"值得看看"而非"一定是错"。
 */
export function checkPresence(
  rows: Record<string, unknown>[],
  chapterNoToTitle: ReadonlyMap<number, string>,
  recordIdToChapterNo: ReadonlyMap<string, number> = new Map(),
): Issue[] {
  const issues: Issue[] = []

  // 按人物分组，每个取按章节排序的快照序列
  const byCharacter = new Map<string, {
    chapterNo: number; location: string; physical: string; belongings: string
  }[]>()

  for (const r of rows) {
    const name = str(r['人物']) || '(未关联人物)'
    const chapterNo = linkFirstNo(r['章节'], chapterNoToTitle, recordIdToChapterNo)
    if (chapterNo === undefined) continue
    const list = byCharacter.get(name) ?? []
    list.push({
      chapterNo,
      location: str(r['所在位置']),
      physical: str(r['身体状况']),
      belongings: str(r['持有物品']),
    })
    byCharacter.set(name, list)
  }

  for (const [name, snapshots] of byCharacter) {
    snapshots.sort((a, b) => a.chapterNo - b.chapterNo)

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]
      const cur = snapshots[i]
      if (prev === undefined || cur === undefined) continue

      // H5-a：相邻两章位置不同 —— 可能是正常移动，仅提示
      if (
        prev.location !== '' && cur.location !== ''
        && prev.location !== cur.location
      ) {
        issues.push({
          type: ISSUE_TYPE.PRESENCE,
          severity: 2,
          title: `${name} 的位置在第 ${prev.chapterNo}→${cur.chapterNo} 章之间发生变化`,
          location: `「${prev.location}」→「${cur.location}」，请确认剧情中是否交代了移动`,
          chapterNo: cur.chapterNo,
          character: name === '(未关联人物)' ? undefined : name,
          confidence: 0.6,
        })
      }

      // H5-b：伤势消失无交代 —— 从"受伤"变"无恙"值得注意
      if (
        prev.physical !== '' && cur.physical !== ''
        && /伤|痛|虚弱|中毒|昏迷/.test(prev.physical)
        && !/伤|痛|虚弱|中毒|昏迷/.test(cur.physical)
        && cur.chapterNo - prev.chapterNo <= 3
      ) {
        issues.push({
          type: ISSUE_TYPE.PRESENCE,
          severity: 3,
          title: `${name} 的伤势在第 ${prev.chapterNo}→${cur.chapterNo} 章之间消失`,
          location: `「${prev.physical}」→「${cur.physical}」，短时间内恢复是否缺交代`,
          chapterNo: cur.chapterNo,
          character: name === '(未关联人物)' ? undefined : name,
          confidence: 0.6,
        })
      }
    }
  }

  return issues
}

/* ------------------------------------------------------------------ */
/* H4 时间线矛盾                                                        */
/* ------------------------------------------------------------------ */

/**
 * 事件时序矛盾。
 *
 * 「故事内时间」是自由文本（如"三年后 秋"），无法可靠解析为绝对时间点，
 * 因此只能做**顺序一致性**检查：若事件 A 在章节上早于 B，
 * 但 A 的故事内时间文本在 B 之后，则提示矛盾。
 *
 * 局限：依赖文本排序，中文纪年（元年/三年后/十年后）排序结果未必正确，
 * 故 confidence 只有 0.5，仅作提醒。
 */
export function checkTimeline(
  rows: Record<string, unknown>[],
  chapterNoToTitle: ReadonlyMap<number, string>,
  recordIdToChapterNo: ReadonlyMap<string, number> = new Map(),
): Issue[] {
  const issues: Issue[] = []

  const events: { name: string; chapterNo: number; storyTime: string }[] = []
  for (const r of rows) {
    const storyTime = str(r[EVENT_F.STORY_TIME])
    if (storyTime === '') continue
    const chapterNo = linkFirstNo(r[EVENT_F.CHAPTER], chapterNoToTitle, recordIdToChapterNo)
    if (chapterNo === undefined) continue
    events.push({ name: str(r[EVENT_F.NAME]), chapterNo, storyTime })
  }
  events.sort((a, b) => a.chapterNo - b.chapterNo)

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]
    const cur = events[i]
    if (prev === undefined || cur === undefined) continue
    // 章节顺序递增，但故事内时间倒退 → 可疑
    if (prev.storyTime > cur.storyTime) {
      issues.push({
        type: ISSUE_TYPE.TIMELINE,
        severity: 2,
        title: `事件时序可疑：「${cur.name}」`,
        location: `第 ${prev.chapterNo} 章「${prev.storyTime}」之后，第 ${cur.chapterNo} 章却是「${cur.storyTime}」`,
        chapterNo: cur.chapterNo,
        confidence: 0.5,
      })
    }
  }

  return issues
}

/* ------------------------------------------------------------------ */
/* 语义型检查：生成供模型审阅的清单                                      */
/* ------------------------------------------------------------------ */

/**
 * 生成语义型检查的**上下文包**。
 *
 * 规则型工具无法判断"人设崩了吗"，但可以把判断所需的材料备齐，
 * 让模型在会话里直接审阅。这样既保留了模型的语义能力，
 * 又避免了在工具内二次调用模型。
 */
export async function buildSemanticCheckPack(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<{
  characters: { name: string; traits: string[]; catchphrase: string; motive: string }[]
  settings: { term: string; definition: string }[]
  foreshadows: { content: string; importance: number }[]
  chapterSummaries: { no: number; title: string; summary: string }[]
}> {
  const [characterRows, settingRows, foreshadowRows, chapterRows] = await Promise.all([
    safeList(baseToken, TABLE.CHARACTER, [
      CHARACTER_F.NAME, CHARACTER_F.TRAITS,
      CHARACTER_F.CATCHPHRASE, CHARACTER_F.MOTIVE,
    ], signal),
    safeList(baseToken, TABLE.SETTING, ['词条名', '释义', '重要度'], signal),
    safeList(baseToken, TABLE.FORESHADOW, [
      FORESHADOW_F.CONTENT, FORESHADOW_F.STATUS, FORESHADOW_F.IMPORTANCE,
    ], signal),
    safeList(baseToken, TABLE.CHAPTER, [
      CHAPTER_F.NO, CHAPTER_F.TITLE, CHAPTER_F.SUMMARY,
    ], signal),
  ])

  return {
    characters: characterRows.map((r) => ({
      name: str(r[CHARACTER_F.NAME]),
      traits: Array.isArray(r[CHARACTER_F.TRAITS])
        ? (r[CHARACTER_F.TRAITS] as unknown[]).map((x) => String(x))
        : [],
      catchphrase: str(r[CHARACTER_F.CATCHPHRASE]),
      motive: str(r[CHARACTER_F.MOTIVE]),
    })).filter((c) => c.name !== ''),
    settings: settingRows.map((r) => ({
      term: str(r['词条名']),
      definition: str(r['释义']),
    })).filter((s) => s.term !== ''),
    foreshadows: foreshadowRows
      .filter((r) => firstStr(r[FORESHADOW_F.STATUS]) === '已埋设')
      .map((r) => ({
        content: str(r[FORESHADOW_F.CONTENT]),
        importance: num(r[FORESHADOW_F.IMPORTANCE]),
      }))
      .filter((f) => f.content !== '')
      .sort((a, b) => b.importance - a.importance),
    chapterSummaries: chapterRows
      .map((r) => ({
        no: num(r[CHAPTER_F.NO]),
        title: str(r[CHAPTER_F.TITLE]),
        summary: str(r[CHAPTER_F.SUMMARY]),
      }))
      .filter((c) => c.no < chapterNo && c.summary !== '')
      .sort((a, b) => b.no - a.no)
      .slice(0, 20),
  }
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

/** 把检查结果写入检查问题表。返回写入条数。 */
export async function persistIssues(
  baseToken: string,
  issues: readonly Issue[],
  signal?: AbortSignal,
): Promise<{ created: number; skipped: number }> {
  if (issues.length === 0) return { created: 0, skipped: 0 }

  // 先读已有问题，按标题去重（避免重复检查刷屏）
  const existing = new Set(
    (await safeList(baseToken, TABLE.ISSUE, [ISSUE_F.TITLE], signal))
      .map((r) => str(r[ISSUE_F.TITLE])),
  )

  const rows = issues
    .filter((i) => !existing.has(i.title))
    .map((i) => ({
      [ISSUE_F.TITLE]: i.title,
      [ISSUE_F.TYPE]: [i.type],
      [ISSUE_F.SEVERITY]: i.severity,
      [ISSUE_F.LOCATION]: i.location,
      [ISSUE_F.STATUS]: [ISSUE_STATUS.OPEN],
    }))

  if (rows.length === 0) return { created: 0, skipped: issues.length }

  // 批量上限 200；走自愈包装（旧库缺字段 / 收敛期的 not_found 自动补齐重试）
  for (let i = 0; i < rows.length; i += 200) {
    await createRecordsWithSelfHeal(
      baseToken, TABLE.ISSUE, rows.slice(i, i + 200), signal,
      (msg) => console.error(`[unwr] ${msg}`),
    )
  }
  return { created: rows.length, skipped: issues.length - rows.length }
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 安全查询：**仅当表不存在**时降级为空（可选表缺席是正常形态），
 * 其他错误（字段收敛中的 not_found、限流等）一律抛出。
 *
 * 曾用 `catch {}` 吞掉一切：一致性检查在伏笔表查询失败时静默返回空，
 * 「未回收伏笔」检查无声失效——与冲突检测失效同类事故。
 */
async function safeList(
  baseToken: string,
  tableName: string,
  fieldIds: string[],
  signal?: AbortSignal,
  checked?: string[],
  skipped?: string[],
  options: { sort?: { field: string; desc?: boolean }[] } = {},
): Promise<Record<string, unknown>[]> {
  try {
    const rows = base.matrixToObjects(
      await base.listAllRecords(baseToken, tableName, {
        fieldIds,
        ...options.sort === undefined ? {} : { sort: options.sort },
      }, signal),
    )
    checked?.push(tableName)
    return rows
  } catch (e) {
    // 「表/字段不存在」包括：表未建、新库字段收敛中的 not_found（message
    // 可能是 "field not found" 或裸 code 1254045）。这两种都属于
    // 可选表缺席，降级为空；其他错误（限流、认证）必须抛出。
    const msg = e instanceof Error ? e.message : String(e)
    const isTableMissing = /not.?found|1254045/i.test(msg)
    if (!isTableMissing) throw e
    skipped?.push(tableName)
    return []
  }
}

/**
 * 从 link 字段解析出关联章节号。
 *
 * link 字段的读回形态有两种：
 *   1. `[{ id: 'recXXXX' }]` —— 只有 record id（飞书默认，本项目实测如此）
 *   2. `['第一章 雨夜叩门']` —— 已展开的标题（若字段被配置为显示标题）
 *
 * 因此要两条路都走：先查 record id → 章节号映射，再退回标题匹配。
 */
function linkFirstNo(
  value: unknown,
  chapterNoToTitle: ReadonlyMap<number, string>,
  recordIdToChapterNo: ReadonlyMap<string, number> = new Map(),
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return undefined

  // 形态 1：{ id: 'recXXXX' }
  if (typeof raw === 'object' && raw !== null && 'id' in raw) {
    const id = String((raw as { id: unknown }).id)
    const no = recordIdToChapterNo.get(id)
    if (no !== undefined) return no
    return undefined
  }

  const text = String(raw)
  // 形态 2：标题文本
  for (const [no, title] of chapterNoToTitle) {
    if (title !== '' && text.includes(title)) return no
  }
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const firstStr = (v: unknown): string =>
  Array.isArray(v) && typeof v[0] === 'string' ? v[0] : str(v)
