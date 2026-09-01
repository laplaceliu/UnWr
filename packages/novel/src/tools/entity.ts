/**
 * 设定 / 人物 / 大纲 / 伏笔 / 剧情线 / 候选分支 的管理工具。
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
  queryPlotlines, querySettings, setChapterOutline, upsertBranch,
  upsertCharacter, upsertForeshadow, upsertPlotline, upsertSetting, upsertVolume,
} from '../domain/entity.ts'

/** 注册实体管理工具。 */
export function registerEntityTools(ctx: Context): void {
  registerSetting(ctx)
  registerCharacter(ctx)
  registerOutline(ctx)
  registerForeshadow(ctx)
  registerPlotline(ctx)
  registerBranch(ctx)
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
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      term: { type: 'string', description: 'Entry name. REQUIRED for upsert.' },
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
        const items = await querySettings(args.workToken, {
          ...args.keyword === undefined ? {} : { keyword: args.keyword },
          ...args.category === undefined ? {} : { category: String(args.category[0] ?? '') },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.term === undefined || args.term === '') {
        throw new Error('upsert 必须提供 term（词条名）。')
      }
      const r = await upsertSetting(args.workToken, {
        term: args.term,
        ...args.definition === undefined ? {} : { definition: args.definition },
        ...args.category === undefined ? {} : { category: args.category },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.status === undefined ? {} : { status: args.status },
      }, exec.signal)
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
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      name: { type: 'string', description: 'Character name. REQUIRED for upsert; filters results for query.' },
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
        const items = await queryCharacters(args.workToken, {
          ...args.name === undefined ? {} : { name: args.name },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.name === undefined || args.name === '') {
        throw new Error('upsert 必须提供 name（人物姓名）。')
      }
      const r = await upsertCharacter(args.workToken, {
        name: args.name,
        ...args.alias === undefined ? {} : { alias: args.alias },
        ...args.role === undefined ? {} : { role: args.role },
        ...args.traits === undefined ? {} : { traits: args.traits },
        ...args.catchphrase === undefined ? {} : { catchphrase: args.catchphrase },
        ...args.motive === undefined ? {} : { motive: args.motive },
        ...args.appearance === undefined ? {} : { appearance: args.appearance },
        ...args.arcStage === undefined ? {} : { arcStage: args.arcStage },
      }, exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}

function registerOutline(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_outline',
    description: 'Manage the outline: list chapter outlines, write an outline for a chapter, '
      + 'or create/update a volume. Use this to plan before drafting — a chapter with an '
      + 'outline drafts much better than one without.',
    parameters: {
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: {
        type: 'string',
        enum: ['query', 'set_chapter_outline', 'upsert_volume'],
        required: true,
      },
      chapterNo: { type: 'number', description: 'Chapter number (set_chapter_outline; optionally filters query).' },
      outline: { type: 'string', description: 'Outline notes for the chapter (set_chapter_outline).' },
      volume: { type: 'string', description: 'Volume name (set_chapter_outline / upsert_volume).' },
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
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await queryOutline(args.workToken, {
          ...args.fromChapter === undefined ? {} : { fromChapter: args.fromChapter },
          ...args.toChapter === undefined ? {} : { toChapter: args.toChapter },
        }, exec.signal)
        // 章节号过滤在 query 时也支持（便于"只看某一章"）
        const filtered = args.chapterNo === undefined
          ? items
          : items.filter((i) => i.no === args.chapterNo)
        return { action: 'query', total: filtered.length, items: filtered }
      }

      if (args.action === 'set_chapter_outline') {
        if (args.chapterNo === undefined) throw new Error('set_chapter_outline 需要 chapterNo。')
        if (args.outline === undefined || args.outline === '') {
          throw new Error('set_chapter_outline 需要 outline。')
        }
        const r = await setChapterOutline(args.workToken, args.chapterNo, args.outline, {
          ...args.volume === undefined ? {} : { volume: args.volume },
          ...args.storyTime === undefined ? {} : { storyTime: args.storyTime },
        }, exec.signal)
        return { action: args.action, total: 1, items: [], recordId: r.recordId }
      }

      if (args.volume === undefined || args.volume === '') {
        throw new Error('upsert_volume 需要 volume（卷名）。')
      }
      const r = await upsertVolume(args.workToken, {
        name: args.volume,
        ...args.order === undefined ? {} : { order: args.order },
        ...args.theme === undefined ? {} : { theme: args.theme },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.summary === undefined ? {} : { summary: args.summary },
      }, exec.signal)
      return { action: args.action, total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}

function registerForeshadow(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_foreshadow',
    description: 'Manage foreshadowing / clues: plant new ones, mark them as paid off, or list '
      + 'what is still open. For genre fiction (mystery, thriller) this is the backbone of '
      + 'a fair puzzle — plant clues early and pay them off within the promised window.',
    parameters: {
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      content: { type: 'string', description: 'What the foreshadowing is. REQUIRED for upsert.' },
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
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { content: { type: 'string', required: true }, type: { type: 'string' }, status: { type: 'string' }, importance: { type: 'number' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await queryForeshadows(args.workToken, {
          ...args.status === undefined ? {} : { status: args.status },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.content === undefined || args.content === '') {
        throw new Error('upsert 必须提供 content（伏笔内容）。')
      }
      const r = await upsertForeshadow(args.workToken, {
        content: args.content,
        ...args.type === undefined ? {} : { type: args.type },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.importance === undefined ? {} : { importance: args.importance },
        ...args.note === undefined ? {} : { note: args.note },
      }, exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}

function registerPlotline(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_plotline',
    description: 'Manage main and sub plotlines: their type, current stage and description. '
      + 'Useful for tracking whether a subplot has been left hanging.',
    parameters: {
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      name: { type: 'string', description: 'Plotline name. REQUIRED for upsert.' },
      type: { type: 'string', enum: ['主线', '支线'], description: 'Type (upsert); filters query.' },
      status: {
        type: 'string', enum: ['铺垫', '推进', '高潮', '收束', '完结'],
        description: 'Stage (upsert).',
      },
      description: { type: 'string', description: 'Description (upsert).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, type: { type: 'string' }, status: { type: 'string' }, description: { type: 'string' } } } },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await queryPlotlines(args.workToken, {
          ...args.type === undefined ? {} : { type: args.type },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.name === undefined || args.name === '') {
        throw new Error('upsert 必须提供 name（剧情线名）。')
      }
      const r = await upsertPlotline(args.workToken, {
        name: args.name,
        ...args.type === undefined ? {} : { type: args.type },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.description === undefined ? {} : { description: args.description },
      }, exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
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
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      action: { type: 'string', enum: ['query', 'upsert'], required: true },
      title: { type: 'string', description: 'Branch title. REQUIRED for upsert.' },
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
        const items = await queryBranches(args.workToken, {
          ...args.adoptStatus === undefined ? {} : { adoptStatus: args.adoptStatus },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.title === undefined || args.title === '') {
        throw new Error('upsert 必须提供 title（分支标题）。')
      }
      const r = await upsertBranch(args.workToken, {
        title: args.title,
        ...args.description === undefined ? {} : { description: args.description },
        ...args.adoptStatus === undefined ? {} : { adoptStatus: args.adoptStatus },
        ...args.note === undefined ? {} : { note: args.note },
      }, exec.signal)
      return { action: 'upsert', total: 1, items: [], recordId: r.recordId, updated: r.updated }
    },
  }))
}
