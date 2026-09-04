/**
 * 设定 / 人物 / 大纲 / 伏笔 / 剧情线 / 候选分支 / 关系网 的管理工具。
 *
 * **工具粒度说明**：这些工具都用 `action`（query / upsert）区分读写，
 * 而不是拆成 12 个独立工具。原因：模型在 20+ 工具里做选择时，
 * 「选对工具」本身就成为失败来源；把同类 CRUD 收敛到一个工具、
 * 用 action 区分，可以显著减少选错的概率。
 *
 * 这一组是设定官 / 人物官 / 大纲官 / 救援官的落库能力。
 *
 * @module @unwr/novel/tools/entity
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  queryBranches, queryCharacters, queryForeshadows, queryOutline,
  queryPlotlines, queryRelations, querySettings, setChapterOutline, upsertBranch,
  upsertCharacter, upsertForeshadow, upsertPlotline, upsertRelation, upsertSetting, upsertVolume,
  deleteRelation, deleteChapterOutline,
} from '../domain/entity.ts'
import { consumeLastResolveInfo, resolveInfoToWarning, withWorkToken } from './defaults.ts'

/** 注册实体管理工具。 */
export function registerEntityTools(ctx: Context): void {
  registerSetting(ctx)
  registerCharacter(ctx)
  registerOutline(ctx)
  registerForeshadow(ctx)
  registerPlotline(ctx)
  registerBranch(ctx)
  registerRelation(ctx)
}

/* ------------------------------------------------------------------ */

function registerSetting(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_setting',
    description: 'Query or write worldbuilding entries (geography, factions, rules, history, '
      + 'items, techniques). action="query" lists entries; action="upsert" creates one or '
      + 'updates the entry with the same term. Keep entries consistent — they are injected '
      + 'into drafting context and checked for conflicts.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      // 不加 schema required：query 不需要它；upsert 缺失由 execute 的运行时
      // 守卫报动作级错误。schema 级 required 会在校验阶段拦死 query 调用
      // （实机踩坑 2026-09-02：novel_manage_foreshadow {"action":"query"}
      // 报 missing required property "content"）。
      term: { type: 'string', description: 'Entry name. REQUIRED for upsert; optional filter for query.' },
      definition: { type: 'string', description: 'Entry definition (upsert).' },
      category: {
        type: 'array', items: { type: 'string' },
        description: 'Categories: 地理 / 势力 / 规则 / 历史 / 物品 / 功法 (upsert).',
      },
      importance: { type: 'number', description: 'Importance 1-5 (upsert).' },
      status: { type: 'string', enum: ['生效', '已废弃', '待定'], description: 'Status (upsert).' },
      keyword: { type: 'string', description: 'Filter by keyword in term or definition (query).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { term: { type: 'string', required: true }, category: { type: 'array', items: { type: 'string' } }, definition: { type: 'string' }, importance: { type: 'number' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => querySettings(token, {
          ...args.keyword === undefined ? {} : { keyword: args.keyword },
          ...args.category === undefined ? {} : { category: String(args.category[0] ?? '') },
        }, signal), exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.term === undefined || args.term === '') {
        throw new Error('upsert 必须提供 term（词条名）。')
      }
      // 提取常量：闭包内 TS 不保留对 args 属性的 narrowing
      const term = args.term
      const r = await withWorkToken(args, (token, signal) => upsertSetting(token, {
        term,
        ...args.definition === undefined ? {} : { definition: args.definition },
        ...args.category === undefined ? {} : { category: args.category },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.status === undefined ? {} : { status: args.status },
      }, signal), exec.signal)
      return {
        action: 'upsert', total: 1, items: [],
        recordId: r.recordId, updated: r.updated,
      }
    },
  }))
}

function registerCharacter(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_character',
    description: 'Query or write character profiles. Character traits, catchphrases and '
      + 'motives are injected into drafting context and used to detect out-of-character '
      + 'writing, so keep them accurate. action="upsert" matches on the name.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      name: { type: 'string', description: 'Character name. REQUIRED for upsert; optional filter for query.' },
      alias: { type: 'string', description: 'Aliases / forms of address, comma-separated (upsert).' },
      role: { type: 'string', description: 'Role or identity (upsert).' },
      traits: {
        type: 'array', items: { type: 'string' },
        description: 'Personality tags, e.g. ["外冷内热","隐忍"] (upsert).',
      },
      catchphrase: { type: 'string', description: 'Verbal tic (upsert).' },
      motive: { type: 'string', description: 'Core motivation (upsert).' },
      appearance: { type: 'string', description: 'Appearance (upsert).' },
      arcStage: { type: 'string', description: 'Character arc stage (upsert).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, alias: { type: 'string' }, role: { type: 'string' }, traits: { type: 'array', items: { type: 'string' } }, catchphrase: { type: 'string' }, motive: { type: 'string' }, arcStage: { type: 'string' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => queryCharacters(token, {
          ...args.name === undefined ? {} : { name: args.name },
        }, signal), exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.name === undefined || args.name === '') {
        throw new Error('upsert 必须提供 name（人物姓名）。')
      }
      const name = args.name
      const r = await withWorkToken(args, (token, signal) => upsertCharacter(token, {
        name,
        ...args.alias === undefined ? {} : { alias: args.alias },
        ...args.role === undefined ? {} : { role: args.role },
        ...args.traits === undefined ? {} : { traits: args.traits },
        ...args.catchphrase === undefined ? {} : { catchphrase: args.catchphrase },
        ...args.motive === undefined ? {} : { motive: args.motive },
        ...args.appearance === undefined ? {} : { appearance: args.appearance },
        ...args.arcStage === undefined ? {} : { arcStage: args.arcStage },
      }, signal), exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}

function registerOutline(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_outline',
    description: 'Manage the outline: list chapter outlines, write an outline for a chapter, '
      + 'create/update a volume, or **delete a chapter shell** (action=delete_chapter_outline). '
      + 'Use this to plan before drafting — a chapter with an outline drafts much better than one without. '
      + 'For deleting a chapter that already has prose, you must first delete the chapter docx via '
      + 'novel_revise_chapter — delete_chapter_outline refuses to orphan docx documents unless force=true.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: {
        type: 'string',
        enum: ['query', 'set_chapter_outline', 'upsert_volume', 'delete_chapter_outline'],
        required: true,
      },
      chapterNo: {
        type: 'number',
        description: 'Chapter number. REQUIRED for set_chapter_outline and delete_chapter_outline; optional filter for query.',
      },
      outline: { type: 'string', description: 'Outline notes for the chapter (set_chapter_outline).' },
      volume: { type: 'string', description: 'Volume name. REQUIRED for upsert_volume; optional for set_chapter_outline.' },
      storyTime: { type: 'string', description: 'In-story time (set_chapter_outline).' },
      order: { type: 'number', description: 'Volume order (upsert_volume).' },
      theme: { type: 'string', description: 'Volume theme (upsert_volume).' },
      status: {
        type: 'string', enum: ['待写', '进行中', '已完成'],
        description: 'Volume status (upsert_volume).',
      },
      summary: { type: 'string', description: 'Volume summary (upsert_volume).' },
      fromChapter: { type: 'number', description: 'Only chapters >= this (query).' },
      toChapter: { type: 'number', description: 'Only chapters <= this (query).' },
      force: {
        type: 'boolean',
        description: 'delete_chapter_outline only. Set true to forcibly delete a chapter that already has prose — '
          + 'this will ORPHAN the associated docx document, so use only when you know the docx is also being cleaned up.',
      },
      reason: {
        type: 'string',
        description: 'delete_chapter_outline only. Free-form reason (logged in warnings for traceability).',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { no: { type: 'number', required: true }, title: { type: 'string', required: true }, status: { type: 'string' }, outline: { type: 'string' }, words: { type: 'number' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
          created: { type: 'boolean', description: 'true = the chapter shell was auto-created by set_chapter_outline.' },
          deleted: { type: 'boolean', description: 'delete_chapter_outline only. true = the chapter record was removed from the table.' },
          blockedByContent: { type: 'boolean', description: 'delete_chapter_outline only. true = refused because the chapter has prose and force was not set.' },
          warnings: { type: 'array', items: { type: 'string' }, description: 'Human-readable warnings (e.g. "used default work fallback", "force-delete will orphan docx").' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      // 共用 helper：把 resolveInfo 转成的警告追加到结果。
      // 显式传入 workToken 时 resolveInfo.source === 'explicit'，warning 是空串，不会噪音。
      const withResolveWarning = <T extends Record<string, unknown>>(result: T): T & { warnings?: string[] } => {
        const info = consumeLastResolveInfo()
        if (info === undefined) return result
        const w = resolveInfoToWarning(info)
        if (w === '') return result
        const merged: string[] = Array.isArray(result['warnings'])
          ? [...result['warnings'] as string[], w]
          : [w]
        return { ...result, warnings: merged }
      }

      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => queryOutline(token, {
          ...args.fromChapter === undefined ? {} : { fromChapter: args.fromChapter },
          ...args.toChapter === undefined ? {} : { toChapter: args.toChapter },
        }, signal), exec.signal)
        // 章节号过滤在 query 时也支持（便于"只看某一章"）
        const filtered = args.chapterNo === undefined
          ? items
          : items.filter((i) => i.no === args.chapterNo)
        return withResolveWarning({ action: 'query', total: filtered.length, items: filtered })
      }

      if (args.action === 'set_chapter_outline') {
        if (args.chapterNo === undefined) throw new Error('set_chapter_outline 需要 chapterNo。')
        if (args.outline === undefined || args.outline === '') {
          throw new Error('set_chapter_outline 需要 outline。')
        }
        const chapterNo = args.chapterNo
        const outline = args.outline
        const r = await withWorkToken(args, (token, signal) => setChapterOutline(token, chapterNo, outline, {
          ...args.volume === undefined ? {} : { volume: args.volume },
          ...args.storyTime === undefined ? {} : { storyTime: args.storyTime },
        }, signal), exec.signal)
        return withResolveWarning({
          action: args.action,
          total: 1,
          items: [],
          recordId: r.recordId,
          created: r.created,
        })
      }

      if (args.action === 'delete_chapter_outline') {
        if (args.chapterNo === undefined) throw new Error('delete_chapter_outline 需要 chapterNo。')
        const chapterNo = args.chapterNo
        const r = await withWorkToken(args, (token, signal) => deleteChapterOutline(token, chapterNo, {
          ...args.force === undefined ? {} : { force: args.force },
          ...args.reason === undefined ? {} : { reason: args.reason },
        }, signal), exec.signal)
        return withResolveWarning({
          action: args.action,
          total: r.deleted ? 1 : 0,
          items: [],
          recordId: r.recordId,
          deleted: r.deleted,
          blockedByContent: r.blockedByContent,
          warnings: r.warnings,
        })
      }

      if (args.volume === undefined || args.volume === '') {
        throw new Error('upsert_volume 需要 volume（卷名）。')
      }
      const volume = args.volume
      const r = await withWorkToken(args, (token, signal) => upsertVolume(token, {
        name: volume,
        ...args.order === undefined ? {} : { order: args.order },
        ...args.theme === undefined ? {} : { theme: args.theme },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.summary === undefined ? {} : { summary: args.summary },
      }, signal), exec.signal)
      return withResolveWarning({
        action: args.action,
        total: 1,
        items: [],
        recordId: r.recordId,
        updated: r.updated,
      })
    },
  }))
}

function registerForeshadow(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_foreshadow',
    description: 'Manage foreshadowing / clues: plant new ones, mark them as paid off, or list '
      + 'what is still open. For genre fiction (mystery, thriller) this is the backbone of '
      + 'a fair puzzle — plant clues early and pay them off within the promised window. '
      + 'ALWAYS pass plantChapter when planting and planPayoffChapter (the promised payoff '
      + 'deadline); without them the overdue-check cannot track this foreshadow.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      content: { type: 'string', description: 'What the foreshadowing is. REQUIRED for upsert; not needed for query.' },
      type: {
        type: 'string', enum: ['主线', '支线', '人物', '物品'],
        description: 'Type (upsert).',
      },
      status: {
        type: 'string', enum: ['已埋设', '已回收', '已作废'],
        description: 'Status (upsert); for query, filters by status.',
      },
      importance: { type: 'number', description: 'Importance 1-5 (upsert).' },
      note: { type: 'string', description: 'Note (upsert).' },
      plantChapter: {
        type: 'number',
        description: 'Chapter number where the foreshadow is planted (upsert). '
          + 'Links the foreshadow to the chapter — REQUIRED workflow-wise for new plants.',
      },
      planPayoffChapter: {
        type: 'number',
        description: 'Chapter number by which the foreshadow should pay off (upsert). '
          + 'The overdue check compares the current chapter against this window.',
      },
      actualPayoffChapter: {
        type: 'number',
        description: 'Chapter number where it actually paid off — set when marking 已回收 (upsert).',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true }, type: { type: 'string' }, status: { type: 'string' }, importance: { type: 'number' }, plantChapter: { type: 'number' }, planPayoffChapter: { type: 'number' }, actualPayoffChapter: { type: 'number' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => queryForeshadows(token, {
          ...args.status === undefined ? {} : { status: args.status },
        }, signal), exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.content === undefined || args.content === '') {
        throw new Error('upsert 必须提供 content（伏笔内容）。')
      }
      const content = args.content
      const r = await withWorkToken(args, (token, signal) => upsertForeshadow(token, {
        content,
        ...args.type === undefined ? {} : { type: args.type },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.note === undefined ? {} : { note: args.note },
        ...args.plantChapter === undefined ? {} : { plantChapter: args.plantChapter },
        ...args.planPayoffChapter === undefined ? {} : { planPayoffChapter: args.planPayoffChapter },
        ...args.actualPayoffChapter === undefined ? {} : { actualPayoffChapter: args.actualPayoffChapter },
      }, signal), exec.signal)
      return {
        action: 'upsert', total: 1, items: [],
        recordId: r.recordId, updated: r.updated,
        ...(r.warnings.length === 0 ? {} : { warnings: r.warnings }),
      }
    },
  }))
}

function registerPlotline(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_plotline',
    description: 'Manage main and sub plotlines: their type, current stage and description. '
      + 'Useful for tracking whether a subplot has been left hanging. '
      + 'Pass chapterNos so the drafting context can activate the plotline '
      + 'when drafting those chapters — without it the line never triggers.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      name: { type: 'string', description: 'Plotline name. REQUIRED for upsert; not needed for query.' },
      type: { type: 'string', enum: ['主线', '支线'], description: 'Type (upsert); filters query.' },
      status: {
        type: 'string', enum: ['铺垫', '推进', '高潮', '收束', '完结'],
        description: 'Stage (upsert).',
      },
      description: { type: 'string', description: 'Description (upsert).' },
      chapterNos: {
        type: 'array', items: { type: 'number' },
        description: 'Chapter numbers this plotline spans (upsert). REPLACE semantics: '
          + 'pass the FULL list every time. Chapters that do not exist yet are skipped '
          + 'with a warning.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, type: { type: 'string' }, status: { type: 'string' }, description: { type: 'string' }, chapters: { type: 'array', items: { type: 'number' } } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => queryPlotlines(token, {
          ...args.type === undefined ? {} : { type: args.type },
        }, signal), exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.name === undefined || args.name === '') {
        throw new Error('upsert 必须提供 name（剧情线名）。')
      }
      const name = args.name
      const r = await withWorkToken(args, (token, signal) => upsertPlotline(token, {
        name,
        ...args.type === undefined ? {} : { type: args.type },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.description === undefined ? {} : { description: args.description },
        ...args.chapterNos === undefined ? {} : { chapterNos: args.chapterNos },
      }, signal), exec.signal)
      return {
        action: 'upsert', total: 1, items: [],
        recordId: r.recordId, updated: r.updated,
        ...(r.warnings.length === 0 ? {} : { warnings: r.warnings }),
      }
    },
  }))
}

function registerBranch(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_branch',
    description: 'Save and list candidate plot branches. Use when the writer is stuck: '
      + 'generate several possible directions, save them with action="upsert", '
      + 'then let the writer pick. Saved branches are not lost even if unused.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      title: { type: 'string', description: 'Branch title. REQUIRED for upsert; not needed for query.' },
      description: { type: 'string', description: 'What happens in this branch (upsert).' },
      adoptStatus: {
        type: 'string', enum: ['候选', '已采用', '已否决'],
        description: 'Adoption status (upsert); filters query.',
      },
      note: { type: 'string', description: 'Evaluation note (upsert).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', required: true }, description: { type: 'string' }, adoptStatus: { type: 'string' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await withWorkToken(args, (token, signal) => queryBranches(token, {
          ...args.adoptStatus === undefined ? {} : { adoptStatus: args.adoptStatus },
        }, signal), exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.title === undefined || args.title === '') {
        throw new Error('upsert 必须提供 title（分支标题）。')
      }
      const title = args.title
      const r = await withWorkToken(args, (token, signal) => upsertBranch(token, {
        title,
        ...args.description === undefined ? {} : { description: args.description },
        ...args.adoptStatus === undefined ? {} : { adoptStatus: args.adoptStatus },
        ...args.note === undefined ? {} : { note: args.note },
      }, signal), exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}

/* ------------------------------------------------------------------ */
/* 关系网                                                                */
/* ------------------------------------------------------------------ */

function registerRelation(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_relation',
    description: '管理人物关系网（RELATION 表）：师徒 / 血亲 / 敌对 / 爱慕 / 同盟 / 利用。'
      + 'action="query" 查询某人物或整部作品的关系；action="upsert" 创建或更新一条关系；'
      + 'action="delete" 软删除（A+B+type 三元组定位，状态置"已破裂" + 描述打"已删除"戳）。'
      + '关系在动笔前注入上下文，模型能避免把"师徒"写成"敌对"这类崩坏。'
      + '一对角色同一类型只能有一条关系（A↔B 视为同一条，按字典序归一）；不同类型允许共存。',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      action: { type: 'string', enum: ['query', 'upsert', 'delete'], required: true },
      // query 维度
      character: { type: 'string', description: '查询某人物涉及的关系（query）。不传返回整部作品所有关系。' },
      type: {
        type: 'string', enum: ['师徒', '血亲', '敌对', '爱慕', '同盟', '利用'],
        description: '关系类型（upsert 必填 / query 可选过滤）。',
      },
      status: {
        type: 'string', enum: ['存续', '已破裂', '已转化'],
        description: '当前状态（upsert 可选 / query 可选过滤）。',
      },
      // upsert 三元组
      characterA: { type: 'string', description: '人物 A 姓名（upsert / delete 必填）。' },
      characterB: { type: 'string', description: '人物 B 姓名（upsert / delete 必填）。' },
      description: { type: 'string', description: '关系描述（upsert），如"养育之恩"、"亦敌亦友"。' },
      startChapter: { type: 'number', description: '关系起始章节号（upsert），如"师徒关系自第 3 章起"。' },
      force: {
        type: 'boolean',
        description: '仅 upsert 生效。当关系已被 delete 软删除时，传 true 强行覆盖 status/description 字段；'
          + '默认 false 保留 [已删除] 戳避免误抹历史。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                a: { type: 'string', required: true },
                b: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
                description: { type: 'string' },
                startChapter: { type: 'number' },
              },
            },
          },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return withWorkToken(args, async (baseToken, signal) => {
        if (args.action === 'query') {
          const rows = await queryRelations(baseToken, {
            character: args.character,
            type: args.type,
            status: args.status,
          }, signal)
          return { action: 'query', total: rows.length, items: rows, warnings: [] as string[] }
        }
        if (args.action === 'upsert') {
          if (args.characterA === undefined || args.characterA === ''
            || args.characterB === undefined || args.characterB === ''
            || args.type === undefined) {
            throw new Error('upsert 需要 characterA / characterB / type 三者齐全。')
          }
          const r = await upsertRelation(baseToken, {
            characterA: args.characterA,
            characterB: args.characterB,
            type: args.type,
            description: args.description,
            startChapter: args.startChapter,
            status: args.status,
            ...(args.force === undefined ? {} : { force: args.force }),
          }, signal)
          return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated, warnings: r.warnings }
        }
        // delete
        if (args.characterA === undefined || args.characterB === undefined || args.type === undefined) {
          throw new Error('delete 需要 characterA / characterB / type 三者齐全。')
        }
        const r = await deleteRelation(baseToken, args.characterA, args.characterB, args.type, signal)
        return {
          action: 'delete',
          total: r.recordId === null ? 0 : 1,
          items: [],
          recordId: r.recordId ?? undefined,
          updated: true,
          warnings: r.recordId === null ? ['关系不存在，无需删除'] : [],
        }
      }, exec.signal)
    },
  }))
}
