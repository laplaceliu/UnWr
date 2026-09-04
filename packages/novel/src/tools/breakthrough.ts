/**
 * 卡文救援（J2）：针对「写到这里写不下去」的章节，组装一份结构化诊断包，
 * 把卡点定位到具体维度（人设/动机/节奏/事件/伏笔/设定冲突），并把相关材料
 * （出场人物档案 + 事件时间线 + 未回收伏笔 + 相关设定）一并喂给模型。
 *
 * 模型拿到这份包后，按六维逐项诊断并产出 3–5 个破局方向（tool 输出）。
 *
 * **与 novel_build_context 的边界**：
 *   - `build_context` 是「动笔前」全量上下文，单次 11 次飞书调用，目的是"知道要写什么"。
 *   - `breakthrough_planning` 是「卡住后」专项上下文，**复用** build_context 的核心能力，
 *     但额外叠加「最近 N 章梗概 + 卡点上下文 + 待回收伏笔」，目的是"知道为什么写不下去"。
 *
 * @module @unwr/novel/tools/breakthrough
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  CHARACTER_F, CHAPTER_F, FORESHADOW_F, FORESHADOW_STATUS, PLOTLINE_F, RELATION_F, SETTING_F,
  TABLE, VOLUME_F,
} from '@unwr/schema'
import { base } from '@unwr/feishu'
import { withWorkToken } from './defaults.ts'

/* ------------------------------------------------------------------ */
/* 域层封装（与 domain/memory.ts 的 buildContext 共享底子）                */
/* ------------------------------------------------------------------ */

/** 该章已有大纲摘要。volume = 卷序（VOLUME.ORDER），未关联卷时 0。 */
interface ChapterOutline {
  chapterNo: number
  title: string
  outline: string
  volume: number
}

/**
 * 章节/卷的 id 映射，一次加载多处复用。
 *
 * 为什么必须先建映射（实机审查 2026-09-03）：CHAPTER.VOLUME、
 * PLOTLINE.CHAPTERS、FORESHADOW.PLANT_CHAPTER 全是 **link 字段**，
 * 读回形态是 [{id}]——直接 Number()/num() 恒为 NaN/0，旧代码的
 * volume、plantedChapter 因此永远是 0，剧情线关联判断恒 false。
 * 正确范式见 domain/consistency.ts 的 linkFirstNo + recordIdToChapterNo。
 */
interface ChapterMaps {
  chapters: { no: number; title: string; outline: string; summary: string; volumeId?: string }[]
  recordIdToChapterNo: Map<string, number>
  volumeIdToOrder: Map<string, number>
}

/** 从 link 单元格取第一个 record id（兼容 [{id}] 与裸字符串两种形态）。 */
function firstLinkId(v: unknown): string | undefined {
  const first = Array.isArray(v) ? v[0] : v
  if (first === undefined || first === null) return undefined
  if (typeof first === 'object' && 'id' in first) return String((first as { id: unknown }).id)
  return typeof first === 'string' && first !== '' ? first : undefined
}

async function loadChapterMaps(
  baseToken: string,
  signal?: AbortSignal,
): Promise<ChapterMaps> {
  const [chapterRows, volumeRows] = await Promise.all([
    base.listAllRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.NO, CHAPTER_F.TITLE, CHAPTER_F.OUTLINE, CHAPTER_F.SUMMARY, CHAPTER_F.VOLUME],
    }, signal),
    base.listAllRecords(baseToken, TABLE.VOLUME, {
      fieldIds: [VOLUME_F.ORDER],
    }, signal),
  ])
  const recordIdToChapterNo = new Map<string, number>()
  const chapters: ChapterMaps['chapters'] = []
  for (const r of base.matrixToObjects(chapterRows)) {
    const rid = str(r['__recordId'])
    const no = num(r[CHAPTER_F.NO])
    if (rid !== '') recordIdToChapterNo.set(rid, no)
    chapters.push({
      no,
      title: str(r[CHAPTER_F.TITLE]),
      outline: str(r[CHAPTER_F.OUTLINE]),
      summary: str(r[CHAPTER_F.SUMMARY]),
      ...firstLinkId(r[CHAPTER_F.VOLUME]) === undefined ? {} : { volumeId: firstLinkId(r[CHAPTER_F.VOLUME]) },
    })
  }
  const volumeIdToOrder = new Map<string, number>()
  for (const v of base.matrixToObjects(volumeRows)) {
    const rid = str(v['__recordId'])
    if (rid !== '') volumeIdToOrder.set(rid, num(v[VOLUME_F.ORDER]))
  }
  return { chapters, recordIdToChapterNo, volumeIdToOrder }
}

function loadOutlineFor(maps: ChapterMaps, chapterNo: number): ChapterOutline | undefined {
  const row = maps.chapters.find((c) => c.no === chapterNo)
  if (row === undefined) return undefined
  return {
    chapterNo: row.no,
    title: row.title,
    outline: row.outline,
    volume: row.volumeId !== undefined ? maps.volumeIdToOrder.get(row.volumeId) ?? 0 : 0,
  }
}

/** 取最近 N 章的梗概（CHAPTER_F.SUMMARY）作为「剧情惯性」参考。 */
function loadRecentSummaries(
  maps: ChapterMaps,
  before: number,
  count: number,
): Array<{ chapterNo: number, title: string, summary: string }> {
  return maps.chapters
    .filter((c) => c.no < before && c.summary !== '')
    .sort((a, b) => b.no - a.no)
    .slice(0, count)
    .map((c) => ({ chapterNo: c.no, title: c.title, summary: c.summary }))
}

/** 待回收伏笔（状态=已埋设），按埋设章节升序。 */
async function loadPendingForeshadows(
  baseToken: string,
  maps: ChapterMaps,
  signal?: AbortSignal,
): Promise<Array<{ title: string, plantedChapter: number, description: string }>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.FORESHADOW, {
      fieldIds: [FORESHADOW_F.CONTENT, FORESHADOW_F.STATUS, FORESHADOW_F.PLANT_CHAPTER, FORESHADOW_F.NOTE],
    }, signal),
  )
  return rows
    .filter((r) => {
      const s = Array.isArray(r[FORESHADOW_F.STATUS]) ? (r[FORESHADOW_F.STATUS] as unknown[])[0] : r[FORESHADOW_F.STATUS]
      // 实测坑：状态枚举是 已埋设/已回收/已作废——「未回收」不是合法选项，
      // 旧代码按它过滤导致待回收列表恒空。
      return s === FORESHADOW_STATUS.PLANTED
    })
    .map((r) => ({
      title: str(r[FORESHADOW_F.CONTENT]),
      plantedChapter: firstLinkId(r[FORESHADOW_F.PLANT_CHAPTER]) !== undefined
        ? maps.recordIdToChapterNo.get(firstLinkId(r[FORESHADOW_F.PLANT_CHAPTER]) as string) ?? 0
        : 0,
      description: str(r[FORESHADOW_F.NOTE]),
    }))
    .sort((a, b) => a.plantedChapter - b.plantedChapter)
}

/** 涉及的活跃人物（出现在最近 5 章 summary 中的角色名）。 */
async function loadActiveCharacters(baseToken: string, characterNames: string[], signal?: AbortSignal): Promise<Array<{ name: string, kind: string, traits: string[], arc: string }>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.CHARACTER, {
      fieldIds: [CHARACTER_F.NAME, CHARACTER_F.ROLE, CHARACTER_F.TRAITS, CHARACTER_F.ARC_STAGE],
    }, signal),
  )
  return rows
    .filter((r) => characterNames.includes(str(r[CHARACTER_F.NAME])))
    .map((r) => ({
      name: str(r[CHARACTER_F.NAME]),
      kind: str(r[CHARACTER_F.ROLE]),
      traits: Array.isArray(r[CHARACTER_F.TRAITS]) ? (r[CHARACTER_F.TRAITS] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      arc: str(r[CHARACTER_F.ARC_STAGE]),
    }))
}

/** 涉及人物的关系网（精简版：只取 A/B/type/status）。 */
async function loadActiveRelations(baseToken: string, characterNames: string[], signal?: AbortSignal): Promise<Array<{ a: string, b: string, type: string, status: string }>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.RELATION, {
      fieldIds: [RELATION_F.A, RELATION_F.B, RELATION_F.TYPE, RELATION_F.STATUS],
    }, signal),
  )
  return rows
    .map((r) => ({
      a: str(r[RELATION_F.A]),
      b: str(r[RELATION_F.B]),
      type: Array.isArray(r[RELATION_F.TYPE]) ? str((r[RELATION_F.TYPE] as unknown[])[0]) : '',
      status: Array.isArray(r[RELATION_F.STATUS]) ? str((r[RELATION_F.STATUS] as unknown[])[0]) : '',
    }))
    .filter((rel) => rel.a !== '' && rel.b !== '')
    .filter((rel) => characterNames.includes(rel.a) || characterNames.includes(rel.b))
}

/** 该章的相关剧情线（PLOTLINE.CHAPTERS link 含本章）。 */
async function loadActivePlotlines(
  baseToken: string,
  maps: ChapterMaps,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<Array<{ name: string, status: string, description: string }>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.PLOTLINE, {
      fieldIds: [PLOTLINE_F.NAME, PLOTLINE_F.STATUS, PLOTLINE_F.DESCRIPTION],
    }, signal),
  )
  return rows
    .filter((r) => {
      const link = r[PLOTLINE_F.CHAPTERS]
      if (!Array.isArray(link)) return false
      // link 读回是 [{id}]（record id），必须经映射转章节号——
      // 旧代码 Number(c) === chapterNo 恒 false
      return link.some((c) => {
        const id = typeof c === 'object' && c !== null && 'id' in c
          ? String((c as { id: unknown }).id)
          : String(c)
        return maps.recordIdToChapterNo.get(id) === chapterNo
      })
    })
    .map((r) => ({
      name: str(r[PLOTLINE_F.NAME]),
      status: Array.isArray(r[PLOTLINE_F.STATUS]) ? str((r[PLOTLINE_F.STATUS] as unknown[])[0]) : '',
      description: str(r[PLOTLINE_F.DESCRIPTION]),
    }))
}

/** 与卡点相关的设定条目（按 characterNames 关键词在设定定义里做命中）。 */
async function loadRelevantSettings(baseToken: string, characterNames: string[], signal?: AbortSignal): Promise<Array<{ term: string, definition: string }>> {
  const rows = base.matrixToObjects(
    await base.listAllRecords(baseToken, TABLE.SETTING, {
      fieldIds: [SETTING_F.TERM, SETTING_F.DEFINITION],
    }, signal),
  )
  return rows
    .filter((r) => {
      const term = str(r[SETTING_F.TERM])
      const def = str(r[SETTING_F.DEFINITION])
      return characterNames.some((n) => term.includes(n) || def.includes(n))
    })
    .slice(0, 6) // 上限 6 条
    .map((r) => ({
      term: str(r[SETTING_F.TERM]),
      definition: str(r[SETTING_F.DEFINITION]),
    }))
}

/* ------------------------------------------------------------------ */
/* 工具主体                                                                */
/* ------------------------------------------------------------------ */

/**
 * 卡点上下文快照：模型拿到后按维度做诊断。
 *
 * 六维诊断模型：
 *   1. **人设一致性** — 角色动机、性格标签、口癖是否与已建档案冲突
 *   2. **情节逻辑** — 上一章结尾→这一章起点的因果链是否断裂
 *   3. **节奏曲线** — 该章在大纲里的张力定位（铺垫 / 冲突 / 高潮 / 收束）是否需要兑现
 *   4. **伏笔触发** — 待回收伏笔是否可以借这一章顺手兑一部分
 *   5. **事件时间** — EVENT 表中是否有事件必须发生在本章前后
 *   6. **设定约束** — 地理/规则/势力是否有未预见的冲突
 */
export interface BreakthroughPack {
  /** 目标章节号。 */
  chapterNo: number
  /** 该章大纲（如果已建）。 */
  outline: { title: string, outline: string, volume: number } | undefined
  /** 卡点片段（用户原文，可包含写不下去的那段正文）。 */
  stuckSnippet: string
  /** 最近 N 章梗概（剧情惯性参考）。 */
  recentSummaries: Array<{ chapterNo: number, title: string, summary: string }>
  /** 涉及的活跃人物档案。 */
  activeCharacters: Array<{ name: string, kind: string, traits: string[], arc: string }>
  /** 涉及人物的关系网（精简）。 */
  activeRelations: Array<{ a: string, b: string, type: string, status: string }>
  /** 该章触发的剧情线。 */
  activePlotlines: Array<{ name: string, status: string, description: string }>
  /** 待回收伏笔（按距离升序）。 */
  pendingForeshadows: Array<{ title: string, plantedChapter: number, description: string }>
  /** 与卡点相关的设定条目。 */
  relevantSettings: Array<{ term: string, definition: string }>
  /** 六维诊断提示词（直接喂给模型即可）。 */
  diagnosticPrompts: string[]
}

const DIAGNOSTIC_PROMPTS = [
  '【人设一致性】卡点片段中的人物动机、决策、口癖是否与档案（CHARACTER 表）一致？是否出现"突然黑化"、"无理由反水"这类崩坏？',
  '【情节逻辑】上一章结尾留下的因果链——伏笔/承诺/危机——在本章是否被回应？还是被遗忘？',
  '【节奏曲线】本章在大纲里的张力定位是什么？如果大纲里写的是"高潮"，但你卡在"日常"，需要拉回冲突；反之亦然。',
  '【伏笔触发】最近未回收的伏笔中，是否有任何一个能借本章顺手回收一部分（哪怕只回收 30%）？',
  '【事件时间】EVENT 表里有没有事件必须发生在本章前后（婚礼/决斗/祭祀）？是否错过窗口期？',
  '【设定约束】地理距离、势力关系、功法规则是否与本章情节冲突？比如「千里之外一日赶到」违反预设。',
]

/**
 * 从「最近 N 章摘要」里简单提取人物名（中文 2–4 字姓名启发式）。
 * 不做 NER，命中率不完美但够用：误召回会在 activeCharacters 里被过滤。
 */
function extractCharacterNames(summaries: Array<{ summary: string }>): string[] {
  const text = summaries.map((s) => s.summary).join('\n')
  // 简单中文人名正则：姓 + 名（1–2 字名），实际中作品人名多为 2–3 字
  const candidates = text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? []
  // 词频统计 → 出现 ≥ 2 次视为活跃人物
  const freq = new Map<string, number>()
  for (const c of candidates) {
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .map(([name]) => name)
}

function registerBreakthrough(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_breakthrough_planning',
    description: '卡文救援：当模型在某章写不下去时调用，组装一份六维诊断包——'
      + '含该章大纲、最近梗概、涉及人物档案、人物关系网、相关剧情线、待回收伏笔、相关设定——'
      + '并附六个维度的诊断提示词（人设一致性 / 情节逻辑 / 节奏曲线 / 伏笔触发 / 事件时间 / 设定约束）。'
      + '模型拿到后**不要直接输出新正文**，而是按六维逐项给出 3–5 个破局方向（每个方向附触发材料 + 预期张力）。'
      + '调用前置：必须有该章的 CHAPTER 记录（用 novel_manage_work 选定作品即可）。'
      + '**不要每章都调**——只在「卡住」时调用，避免重复拉数据。',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: '卡住的章节号。' },
      stuckSnippet: { type: 'string', required: true, description: '卡点原文——包括写不下去的那段正文 + 你的犹豫/困惑（最多 4000 字）。' },
      recentWindow: { type: 'number', description: '拉取最近 N 章梗概作为剧情惯性参考，默认 5。' },
      explicitCharacters: {
        type: 'array', items: { type: 'string' },
        description: '本章必然出场的角色名（用户显式告知，跳过自动抽取）。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          outline: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              outline: { type: 'string', required: true },
              volume: { type: 'number', required: true },
            },
          },
          stuckSnippet: { type: 'string', required: true },
          recentSummaries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                chapterNo: { type: 'number', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
          activeCharacters: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                traits: { type: 'array', items: { type: 'string' } },
                arc: { type: 'string' },
              },
            },
          },
          activeRelations: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
          activePlotlines: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          pendingForeshadows: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                plantedChapter: { type: 'number', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          relevantSettings: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                term: { type: 'string', required: true },
                definition: { type: 'string', required: true },
              },
            },
          },
          diagnosticPrompts: {
            type: 'array', required: true,
            items: { type: 'string' },
            description: '六维诊断提示词——模型按此逐项诊断。',
          },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return withWorkToken(args, async (baseToken, signal) => {
        const chapterNo = args.chapterNo
        const recentWindow = args.recentWindow ?? 5

        // 第一批：章节/卷映射（互不依赖）
        const maps = await loadChapterMaps(baseToken, signal)
        const outline = loadOutlineFor(maps, chapterNo)
        const recent = loadRecentSummaries(maps, chapterNo, recentWindow)

        // 第二批并行：待回收伏笔 / 相关剧情线（依赖映射）+ 无关的独立查询
        const [foreshadows, plotlines] = await Promise.all([
          loadPendingForeshadows(baseToken, maps, signal),
          loadActivePlotlines(baseToken, maps, chapterNo, signal),
        ])

        // 人物抽取：用户显式 > 自动抽取（按 recent 摘要）
        const autoNames = extractCharacterNames(recent)
        const characterNames = args.explicitCharacters !== undefined && args.explicitCharacters.length > 0
          ? args.explicitCharacters
          : autoNames.slice(0, 8) // 上限 8 个，避免关系网拉爆

        // 第二批并行：人物档案 + 关系网 + 相关设定
        const [characters, relations, settings] = await Promise.all([
          loadActiveCharacters(baseToken, characterNames, signal),
          loadActiveRelations(baseToken, characterNames, signal),
          loadRelevantSettings(baseToken, characterNames, signal),
        ])

        const pack: BreakthroughPack = {
          chapterNo,
          outline: outline === undefined
            ? undefined
            : { title: outline.title, outline: outline.outline, volume: outline.volume },
          stuckSnippet: args.stuckSnippet,
          recentSummaries: recent,
          activeCharacters: characters,
          activeRelations: relations,
          activePlotlines: plotlines,
          pendingForeshadows: foreshadows,
          relevantSettings: settings,
          diagnosticPrompts: DIAGNOSTIC_PROMPTS,
        }
        return pack
      }, exec.signal)
    },
  }))
}

/** 注册全部卡文救援工具。 */
export function registerBreakthroughTools(ctx: Context): void {
  registerBreakthrough(ctx)
}

/* ------------------------------------------------------------------ */
/* 单元格归一化：与 domain/entity.ts 同形，保证类型推导清晰。                 */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}