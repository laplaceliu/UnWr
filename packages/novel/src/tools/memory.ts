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
 * 一次性给出 newInfo 在工具历史里被传错的所有形态，便于
 * execute 入口识别模型"把别的字段塞进 newInfo 对象"这一最常见
 * 失误（实机 2026-09-03 第 10 章：模型把
 * `{item, newForeshadows, endState, freeform}` 整个当成 newInfo 传），
 * 抛一条自纠正的报错让模型下一轮自己改对。
 */
const NEW_INFO_MISTAKE_KEYS = new Set([
  'item',
  'newForeshadows',
  'endState',
  'freeform',
  'foreshadows',
  'info',
  'new_info',
])

/** 自纠正：newInfo 传成对象时给模型的"正确 JSON 示例"提示。 */
const SHAPE_HINT = `newInfo 必须是字符串数组（每条一句本章揭示的新信息）。
你是不是把 newForeshadows / endState / freeform 嵌进了 newInfo 对象里？它们都是
与 newInfo 平级的"顶层字段"，请按下面的扁平结构传参：

{
  "chapterNo": 10,
  "scene": "景和十一年 仲春 十四 夜，齐王府门前、洗骨司明堂。",
  "events": ["..."],
  "characterChanges": ["..."],
  "newInfo": ["新信息 1", "新信息 2"],
  "newForeshadows": ["新伏笔 1", "新伏笔 2"],
  "endState": "章末状态：…",
  "freeform": "其它值得记住的"
}

参考：docs/requirements/05-memory-and-consistency.md 第 2 节「分层记忆结构」
与 packages/novel/src/domain/memory.ts 的 chapterSummaryRecord 形状。`

function registerUpdateSummary(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_update_summary',
    description: 'Write or update the structured summary of a chapter. '
      + 'CALL THIS AFTER FINISHING A CHAPTER — without it, later chapters cannot recall '
      + 'what happened here. Fill as many structured fields as you can. '
      + 'All structured fields below are flat top-level keys on the parameters object — '
      + 'do NOT nest newForeshadows / endState / freeform inside newInfo. '
      + 'Correct shape example: '
      + '{"chapterNo":1, "scene":"...", "events":["..."], "characterChanges":["..."], '
      + '"newInfo":["..."], "newForeshadows":["..."], "endState":"...", "freeform":"..."}.',
    parameters: {
      workToken: { type: 'string', description: 'Feishu base_token of the work. Optional: defaults to the last work used in this session.' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      scene: { type: 'string', description: 'When and where this chapter takes place.' },
      events: {
        type: 'array', items: { type: 'string' },
        description: 'What happened, in order (3-5 items).',
      },
      characterChanges: {
        type: 'array', items: { type: 'string' },
        description: 'How each character changed in this chapter.',
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
      newForeshadows: {
        type: 'array', items: { type: 'string' },
        description: 'New foreshadowing planted in this chapter. 顶层字段，不要嵌进 newInfo。',
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
      // 实机 2026-09-03：模型曾传 `newInfo: {item, newForeshadows, endState, freeform}`
      // ——把别的字段塞进了 newInfo 对象。schema 放宽后这里专门防这种失误：
      // 命中 NEW_INFO_MISTAKE_KEYS 里的任意一个键 → 抛自纠正错误并给完整
      // 正确 JSON 示例，让模型下一轮能自己改对。命中非空但不含错形态键
      // 的对象（比如未来的演化字段）→ 走"不是数组"通用路径。
      if (args.newInfo !== undefined && args.newInfo !== null) {
        if (Array.isArray(args.newInfo)) {
          // 正常分支
        } else if (typeof args.newInfo === 'object') {
          const obj = args.newInfo as Record<string, unknown>
          const keys = Object.keys(obj)
          const mistakeHit = keys.some((k) => NEW_INFO_MISTAKE_KEYS.has(k))
          // 即使没命中已知键，凡是 object 形态的 newInfo 都是模型对
          // schema 形态的误读，统一给自纠正示例，避免"对象能传但悄悄落空"
          // 这种比"立刻报错"更难排查的隐性失败。
          if (mistakeHit || keys.length > 0) {
            throw new Error(SHAPE_HINT)
          }
          throw new Error(`newInfo 收到空对象 ${JSON.stringify(obj)}：` + SHAPE_HINT)
        } else {
          throw new Error(`newInfo 必须是字符串数组，实际收到 ${typeof args.newInfo}。` + SHAPE_HINT)
        }
      }
      const r = await updateChapterSummary(
        resolveWorkToken(args),
        args.chapterNo,
        {
          ...args.scene === undefined ? {} : { scene: args.scene },
          ...args.events === undefined ? {} : { events: args.events },
          ...args.characterChanges === undefined ? {} : { characterChanges: args.characterChanges },
          ...args.newInfo === undefined ? {} : { newInfo: args.newInfo },
          ...args.newForeshadows === undefined ? {} : { newForeshadows: args.newForeshadows },
          ...args.endState === undefined ? {} : { endState: args.endState },
          ...args.freeform === undefined ? {} : { freeform: args.freeform },
        },
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
