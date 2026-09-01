/**
 * 记忆沉淀工具：novel_update_summary / novel_record_character_state /
 * novel_record_event / novel_upsert_book_summary
 *
 * 这一组工具是「分层记忆」的写入侧。没有它们，下一章起草时无法回忆起
 * 前面写了什么——分层记忆会退化成空谈。
 *
 * @module @unwr/novel/tools/memory
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  recordCharacterState, recordEvent, updateChapterSummary, upsertBookSummary,
} from '../domain/memory.ts'

/** 注册记忆相关工具。 */
export function registerMemoryTools(ctx: Context): void {
  registerUpdateSummary(ctx)
  registerCharacterState(ctx)
  registerRecordEvent(ctx)
  registerBookSummary(ctx)
}

function registerUpdateSummary(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_update_summary',
    description: 'Write or update the structured summary of a chapter. '
      + 'CALL THIS AFTER FINISHING A CHAPTER — without it, later chapters cannot recall '
      + 'what happened here. Fill as many structured fields as you can.',
    parameters: {
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
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
      newInfo: {
        type: 'array', items: { type: 'string' },
        description: 'New information revealed.',
      },
      newForeshadows: {
        type: 'array', items: { type: 'string' },
        description: 'New foreshadowing planted in this chapter.',
      },
      endState: { type: 'string', description: 'Situation and open questions at chapter end.' },
      freeform: { type: 'string', description: 'Anything else worth remembering.' },
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
      const r = await updateChapterSummary(
        args.workToken,
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
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      character: { type: 'string', required: true, description: 'Character name' },
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
        args.workToken,
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
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      chapterNo: { type: 'number', required: true, description: 'Chapter number' },
      name: { type: 'string', required: true, description: 'Event name' },
      summary: { type: 'string', description: 'What happened.' },
      location: { type: 'string', description: 'Where it happened.' },
      storyTime: { type: 'string', description: 'In-story time, e.g. "三年后 秋".' },
      impact: { type: 'string', description: 'How it affects later events.' },
      isTurningPoint: { type: 'boolean', description: 'Is this a turning point?' },
      participants: {
        type: 'array', items: { type: 'string' },
        description: 'Character names involved.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return recordEvent(
        args.workToken,
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
    description: 'Write or update a volume-level or book-level summary. '
      + 'These are the compressed long-term memory: they keep the context cost flat '
      + 'as the story grows to hundreds of chapters.',
    parameters: {
      workToken: { type: 'string', required: true, description: 'Feishu base_token of the work' },
      level: { type: 'string', enum: ['卷', '全书'], required: true, description: 'Summary level' },
      title: { type: 'string', required: true, description: 'Summary title, e.g. "第一卷 旧剑"' },
      content: { type: 'string', required: true, description: 'Summary text' },
      fromChapter: { type: 'number', description: 'First chapter covered.' },
      toChapter: { type: 'number', description: 'Last chapter covered.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      return upsertBookSummary(
        args.workToken,
        args.level,
        args.title,
        args.content,
        {
          ...args.fromChapter === undefined ? {} : { fromChapter: args.fromChapter },
          ...args.toChapter === undefined ? {} : { toChapter: args.toChapter },
        },
        exec.signal,
      )
    },
  }))
}
