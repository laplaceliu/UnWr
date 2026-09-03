/**
 * 记忆沉淀工具：novel_update_summary / novel_record_character_state /
 * novel_record_event / novel_upsert_book_summary
 *
 * 这一组工具是「分层记忆」的写入侧。没有它们，下一章起草时无法回忆起
 * 前面写了什么——分层记忆会退化成空谈。
 *
 * 其中 novel_upsert_book_summary 是 query/upsert 合一的（与 novel_manage_*
 * 同款 action 守门员形态）：L2 摘要按**标题**去重，模型不先查就写会堆出
 * 重复行，所以它必须自带读口。
 *
 * @module @unwr/novel/tools/memory
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  queryBookSummaries, recordCharacterState, recordEvent, updateChapterSummary, upsertBookSummary,
  type ChapterSummaryInput,
} from '../domain/memory.ts'
import { resolveWorkToken } from './defaults.ts'

/** 注册记忆相关工具。 */
export function registerMemoryTools(ctx: Context): void {
  registerUpdateSummary(ctx)
  registerCharacterState(ctx)
  registerRecordEvent(ctx)
  registerBookSummary(ctx)
}

/**
 * 一次性给出 string-array 字段在工具历史里被传成"对象"的所有已知错形态键，
 * 便于 execute 入口识别模型"把别的字段塞进这个字段"这一最常见
 * 失误（实机 2026-09-03 第 10 章：模型把
 * `{item, newForeshadows, endState, freeform}` 整个当成 newInfo 传；
 * 实机 2026-09-03 第 11 章：模型同样把整套平级字段塞进 characterChanges，
 * 还嵌套一层 `characterChanges: {...}`）。
 *
 * 注意：**任何 string-array 字段名都列入错键集**——模型只要把平级字段误装进
 * 另一个 string-array 字段，被误装的那个字段本身在对象里出现，就是错形态。
 */
const STRING_ARRAY_MISTAKE_KEYS = new Set([
  'item',
  'newForeshadows',
  'newInfo',
  'endState',
  'freeform',
  'foreshadows',
  'info',
  'new_info',
  'characterChanges',
  'events',
  'scene',
])

/**
 * 通用自纠正：任意 string-array 字段被传成对象时给模型的"正确 JSON 示例"提示。
 * 通过 validateShape(field, value) 集中识别+抛错，避免每个字段各写一段。
 *
 * 实机 2026-09-03 第 11 章：模型把
 * `characterChanges: { item: ..., characterChanges: { newInfo, newForeshadows, endState, freeform } }`
 * 整个对象当成 characterChanges。DSH 顶层 type:'array' 校验直接拒，
 * 模型完全看不到正确示例——盲试改错。修复：放宽 schema + 加对象形态自纠正。
 */
const SHAPE_HINT_BODY = `你是不是把 newInfo / newForeshadows / endState / freeform /
characterChanges / events 这些平级顶层字段塞进了这个字段的对象里？所有字段
（scene / events / characterChanges / newInfo / newForeshadows / endState /
freeform）都是顶层扁平，不要嵌套——尤其不要把同名字段再嵌一层。

正确示例（请**逐字段**核对哪些键该在哪里）：
{
  "chapterNo": 11,
  "scene": "开元四十一年 三月十三 晨,西市杂号柜坊门口、账房。",
  "events": ["第 1 件", "第 2 件"],
  "characterChanges": ["甲:状态 A→B", "乙:状态 C→D"],
  "newInfo": ["新信息 1", "新信息 2"],
  "newForeshadows": ["新伏笔 1", "新伏笔 2"],
  "endState": "章末状态:…",
  "freeform": "其它值得记住的"
}

参考：docs/requirements/05-memory-and-consistency.md 第 2 节「分层记忆结构」
与 packages/novel/src/domain/memory.ts 的 chapterSummaryRecord 形状。`

/**
 * 校验 string-array 字段实际形态。命中已知错形态键 → 抛含 SHAPE_HINT_BODY
 * 的自纠正错误，把"字段名"放前面让模型精确定位错的字段。
 */
function validateShape(field: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) return
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const mistakeHit = keys.some((k) => STRING_ARRAY_MISTAKE_KEYS.has(k))
    if (mistakeHit || keys.length > 0) {
      throw new Error(
        `字段「${field}」必须是字符串数组（每条一句），你传成对象/嵌套结构了。
`
        + SHAPE_HINT_BODY,
      )
    }
    throw new Error(`字段「${field}」收到空对象 ${JSON.stringify(obj)}，必须是字符串数组。`)
  }
  throw new Error(
    `字段「${field}」必须是字符串数组，你传的是 ${typeof value} 而不是字符串数组。`,
  )
}

function registerUpdateSummary(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_update_summary',
    description: 'Write or update the structured summary of a chapter. '
      + 'CALL THIS AFTER FINISHING A CHAPTER — without it, later chapters cannot recall what happened here. '
      + 'Fill as many structured fields as you can. '
      + 'All structured fields below are FLAT TOP-LEVEL keys — '
      + 'characterChanges / events / newInfo / newForeshadows / endState / freeform are all SIBLING keys, '
      + 'not nested inside each other. If you find yourself writing '
      + '`field: { item, ... }`, stop — flatten it: `field: ["..."]` and put the rest on the same level. '
      + 'Correct shape example: '
      + '{"chapterNo":1, "scene":"...", "events":["..."], "characterChanges":["..."], '
      + '"newInfo":["..."], "newForeshadows":["..."], "endState":"...", "freeform":"..."}',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      scene: { type: 'string', description: 'When and where this chapter takes place.' },
      // 同 newInfo：放宽为 oneOf 让对象能进 execute 触发自纠正。
      // 实机 2026-09-03 第 11 章：模型把全套平级字段（item/characterChanges/newInfo/newForeshadows/endState/freeform）
      // 塞进 characterChanges 对象里，DSH 顶层 array 校验直接拒。
      characterChanges: {
        oneOf: [
          {
            type: 'array', items: { type: 'string' },
            description: '本章每个人的状态变化，每条一行的字符串数组',
          },
          {
            type: 'object', additionalProperties: true,
            description: '【错形态专用】execute 会拒并返回正确示例',
          },
        ],
        description: '每个人在本章里的状态变化（如 "甲:状态 A→B"）。必须是顶层扁平字符串数组，'
          + '**不要**把 newForeshadows / newInfo / endState / freeform 塞进 characterChanges 对象里。',
      },
      events: {
        oneOf: [
          {
            type: 'array', items: { type: 'string' },
            description: '本章发生事件 3-5 条，每条一行的字符串数组',
          },
          {
            type: 'object', additionalProperties: true,
            description: '【错形态专用】execute 会拒并返回正确示例',
          },
        ],
        description: '本章发生了什么（按顺序 3-5 条）。必须是顶层扁平字符串数组。',
      },
      newForeshadows: {
        oneOf: [
          {
            type: 'array', items: { type: 'string' },
            description: '本章新埋下的伏笔 0-N 条，每条一行的字符串数组',
          },
          {
            type: 'object', additionalProperties: true,
            description: '【错形态专用】execute 会拒并返回正确示例',
          },
        ],
        description: '本章新埋的伏笔。必须是顶层扁平字符串数组，不要嵌进 newInfo/characterChanges。',
      },
      // 实机 2026-09-03 第 10 章：模型曾把
      // `{item, newForeshadows, endState, freeform}` 整个当成 newInfo 传，
      // DSH schema 直接报 `"newInfo" must be an array`。这里放宽成 oneOf 让
      // 对象能进到 execute，由 execute 入口抛自纠正错误告诉模型该长什么样
      // ——比单纯 "must be an array" 信息密度高一个量级。正确调用永远命中
      // 分支 0（字符串数组），错误调用命中分支 1（object）→ 立即报错并
      // 把正确 JSON 示例回吐给模型，下一轮它能自己改对。
      newInfo: {
        oneOf: [
          {
            type: 'array', items: { type: 'string' },
            description: '新揭示信息，每条一句的字符串数组',
          },
          {
            type: 'object', additionalProperties: true,
            description: '【错形态专用】模型把别的字段塞进了 newInfo 对象——execute 会拒并返回正确示例',
          },
        ],
        description: '本章新揭示的信息（字符串数组，每条一句）。必须是顶层字段，不要把 newForeshadows / endState / freeform 塞进 newInfo 对象。',
      },

      endState: { type: 'string', description: 'Situation and open questions at chapter end. 顶层字段，不要嵌进 newInfo。' },
      freeform: { type: 'string', description: 'Anything else worth remembering. 顶层字段，不要嵌进 newInfo。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chapterNo: { type: 'number', required: true },
          recordId: { type: 'string', required: true },
          summaryText: { type: 'string', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      // 实机 2026-09-03：模型反复把"全套平级顶层字段"塞进
      // newInfo / characterChanges / events / newForeshadows 等任一字符串数组字段里。
      // schema 放宽 + 通用 validateShape 后，所有 string-array 字段共享同一守卫。
      validateShape('characterChanges', args.characterChanges)
      validateShape('events', args.events)
      validateShape('newInfo', args.newInfo)
      validateShape('newForeshadows', args.newForeshadows)
      // validateShape 已 throw 拒错形态——能到这里说明这 4 个字段都是 string[] | undefined。
      // DSH 对 schema oneOf 推出的 args 类型是 wide union，与 updateChapterSummary
      // 的 ChapterSummaryInput(string[] 形态) 不直接 assignable。call-site 的单 cast
      // 是这种 union→窄化的最简路径；要回归测试覆盖 all 4 fields 的"对象形态被 throw"。
      // DSH 对 oneOf 的 args 类型推 wide union 与 ChapterSummaryInput(string[]) 不直接
      // assignable，用 call-site cast 而非重写 schema 类型。
      // pick 出仅 7 个章节摘要字段（filter undefined），与原本的透传行为一致。
      // DSH 对 oneOf 推出 wide union，加 `as ChapterSummaryInput` 窄化。
      const summary: ChapterSummaryInput = {
        ...(args.scene !== undefined ? { scene: args.scene } : {}),
        ...(Array.isArray(args.events) ? { events: args.events } : {}),
        ...(Array.isArray(args.characterChanges) ? { characterChanges: args.characterChanges } : {}),
        ...(Array.isArray(args.newInfo) ? { newInfo: args.newInfo } : {}),
        ...(Array.isArray(args.newForeshadows) ? { newForeshadows: args.newForeshadows } : {}),
        ...(args.endState !== undefined ? { endState: args.endState } : {}),
        ...(args.freeform !== undefined ? { freeform: args.freeform } : {}),
      }
      const r = await updateChapterSummary(
        resolveWorkToken(args),
        args.chapterNo,
        summary,
        exec.signal,
      )
      return { chapterNo: args.chapterNo, ...r }
    },
  }))
}

function registerCharacterState(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_record_character_state',
    description: 'Record a character\'s state snapshot at the END of a chapter '
      + '(location, injuries, mood, belongings). This is what lets later chapters know '
      + 'where the character is and what condition they are in.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      character: {
        type: 'string', required: true,
        description: 'Character name, exactly as in the character table. '
          + 'Do NOT append parenthetical notes like 陆铮（重伤） — put that in '
          + 'physical / emotion / location / summary instead.',
      },
      location: { type: 'string', description: 'Where they are at chapter end.' },
      physical: { type: 'string', description: 'Physical condition (injuries, fatigue).' },
      emotion: { type: 'string', description: 'Emotional state.' },
      belongings: { type: 'string', description: 'Items in their possession.' },
      relationChange: { type: 'string', description: 'Relationship changes in this chapter.' },
      summary: { type: 'string', description: 'One-line state summary.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string' },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const r = await recordCharacterState(
        resolveWorkToken(args),
        args.chapterNo,
        {
          character: args.character,
          ...args.location === undefined ? {} : { location: args.location },
          ...args.physical === undefined ? {} : { physical: args.physical },
          ...args.emotion === undefined ? {} : { emotion: args.emotion },
          ...args.belongings === undefined ? {} : { belongings: args.belongings },
          ...args.relationChange === undefined ? {} : { relationChange: args.relationChange },
          ...args.summary === undefined ? {} : { summary: args.summary },
        },
        exec.signal,
      )
      return r
    },
  }))
}

function registerRecordEvent(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_record_event',
    description: 'Add an event to the story event index for a chapter. '
      + 'Events are the fine-grained memory that chapter summaries summarize; '
      + 'they also power timeline and presence consistency checks.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      name: { type: 'string', required: true, description: 'Event name' },
      summary: { type: 'string', description: 'What happened.' },
      location: { type: 'string', description: 'Where it happened.' },
      storyTime: { type: 'string', description: 'In-story time, e.g. "三年后 秋".' },
      impact: { type: 'string', description: 'How it affects later events.' },
      isTurningPoint: { type: 'boolean', description: 'Is this a turning point?' },
      participants: {
        type: 'array', items: { type: 'string' },
        description: 'Character names involved, exactly as in the character table. '
          + 'A trailing parenthetical note is split out automatically '
          + '(陆铮（不在场） → links 陆铮, stores 不在场 in the participant-notes field). '
          + 'Names not in the character table are skipped with a warning.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          participantNotes: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return recordEvent(
        resolveWorkToken(args),
        args.chapterNo,
        {
          name: args.name,
          ...args.summary === undefined ? {} : { summary: args.summary },
          ...args.location === undefined ? {} : { location: args.location },
          ...args.storyTime === undefined ? {} : { storyTime: args.storyTime },
          ...args.impact === undefined ? {} : { impact: args.impact },
          ...args.isTurningPoint === undefined ? {} : { isTurningPoint: args.isTurningPoint },
          ...args.participants === undefined ? {} : { participants: args.participants },
        },
        exec.signal,
      )
    },
  }))
}

function registerBookSummary(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_upsert_book_summary',
    description: 'Query or write the volume-level / book-level summaries — the compressed '
      + 'long-term memory that keeps context cost flat as the story grows. '
      + 'action="query" lists existing summaries (no arguments needed beyond an optional '
      + 'level filter). action="upsert" writes one. '
      + 'NOTE: matching is by exact title — query first and reuse the existing title, '
      + 'otherwise a slightly different title creates a duplicate summary row.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      // action 必填：与 novel_manage_* 同款（tool-schema.spec.ts 的不变量：
      // 凡 enum 含 query 的工具，编译后 required 必须恰好是 ['action']，
      // 否则 query 调用会在 DSH 校验阶段被拦死，永远到不了 execute）。
      action: {
        type: 'string', enum: ['query', 'upsert'], required: true,
        description: 'query = list existing volume/book summaries; upsert = write one.',
      },
      // 以下字段**不加 schema required**：query 不需要它们，schema 级 required
      // 会在校验阶段把 query 调用拦死。upsert 缺失由 execute 的动作级守卫报
      // 更明确的错误。与 novel_manage_* 同款形态（entity.ts 已踩过同一个坑）。
      // 实机 2026-09-03：模型按 manage_* 惯例传 {action:"query", level:"卷"}，
      // 被报 missing required property "title"; missing required property "content"。
      level: {
        type: 'string', enum: ['卷', '全书'],
        description: 'Summary level. REQUIRED for upsert; optional filter for query.',
      },
      title: {
        type: 'string',
        description: 'Summary title, e.g. "第一卷 旧剑". REQUIRED for upsert; '
          + 'for query it filters by substring in title or content.',
      },
      content: { type: 'string', description: 'Summary text. REQUIRED for upsert.' },
      fromChapter: { type: 'number', description: 'First chapter covered (upsert).' },
      toChapter: { type: 'number', description: 'Last chapter covered (upsert).' },
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
                level: { type: 'string', required: true },
                title: { type: 'string', required: true },
                content: { type: 'string', required: true },
                fromChapter: { type: 'number' },
                toChapter: { type: 'number' },
              },
            },
          },
          recordId: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      if (args.action === 'query') {
        const items = await queryBookSummaries(resolveWorkToken(args), {
          ...args.level === undefined ? {} : { level: args.level },
          ...args.title === undefined ? {} : { keyword: args.title },
        }, exec.signal)
        return { action: 'query', total: items.length, items }
      }
      if (args.level !== '卷' && args.level !== '全书') {
        throw new Error('upsert 必须提供 level（卷 / 全书）。')
      }
      if (args.title === undefined || args.title === '') {
        throw new Error('upsert 必须提供 title（摘要标题）。')
      }
      if (args.content === undefined || args.content === '') {
        throw new Error('upsert 必须提供 content（摘要正文）。')
      }
      const r = await upsertBookSummary(
        resolveWorkToken(args),
        args.level,
        args.title,
        args.content,
        {
          ...args.fromChapter === undefined ? {} : { fromChapter: args.fromChapter },
          ...args.toChapter === undefined ? {} : { toChapter: args.toChapter },
        },
        exec.signal,
      )
      return {
        action: 'upsert', total: 1, items: [],
        recordId: r.recordId, updated: r.updated,
      }
    },
  }))
}
