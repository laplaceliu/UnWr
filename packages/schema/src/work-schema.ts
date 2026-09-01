/**
 * 一部作品的表结构定义 —— **全项目的单一真源**。
 *
 * 为什么放在 schema 包而不是脚本里：
 *   1. `packages/schema/scripts/init-work.ts` 用它建库
 *   2. `@unwr/novel` 的 novel_manage_work create 动作也要用它建库
 *   3. `sync-fields.ts` 用它补齐字段
 * 三者必须严格一致，否则写入时报 `800030201 not_found`
 * （字段名不属于该表），而该错误静默、极难排查。
 *
 * 表结构说明见 docs/requirements/02-feishu-data-model.md
 * @module @unwr/schema/work-schema
 */


/** 字段 JSON 定义（与 lark-cli field-create 的 --json 形状一致）。 */
export interface FieldSchema {
  name: string
  type: 'text' | 'number' | 'select' | 'datetime' | 'checkbox'
    | 'link' | 'formula' | 'lookup' | 'auto_number'
    | 'attachment' | 'location' | 'user' | 'group_chat'
    | 'created_at' | 'updated_at' | 'created_by' | 'updated_by' | 'button'
  description?: string
  multiple?: boolean
  options?: { name: string; hue?: string; lightness?: string }[]
  style?: Record<string, unknown>
  /** 仅 link：目标表的 **table_id** */
  link_table?: string
  bidirectional?: boolean
  bidirectional_link_field_name?: string
  /** 仅 formula */
  expression?: string
}

import {
  BRANCH_F, CHARACTER_F, CHARACTER_STATE_F, CHAPTER_F, EVENT_F, FORESHADOW_F,
  ISSUE_F, MEMORY_F, PLOTLINE_F, RELATION_F, SETTING_F, TABLE, VOLUME_F, WORK_F,
} from './tables.ts'

export const TABLE_SCHEMAS: Record<string, FieldSchema[]> = {
  [TABLE.WORK]: [
    { name: WORK_F.NAME, type: 'text' },
    { name: WORK_F.GENRE, type: 'select', multiple: false, options: [{ name: '中文网文' }, { name: '类型小说' }, { name: '纯文学' }] },
    { name: WORK_F.SUBGENRE, type: 'text' },
    { name: WORK_F.SCALE, type: 'select', multiple: false, options: [{ name: '短篇' }, { name: '中长篇' }, { name: '长篇连载' }] },
    { name: WORK_F.TARGET_WORDS, type: 'number' },
    { name: WORK_F.MODE, type: 'select', multiple: false, options: [{ name: '协作助手' }, { name: '全自动' }, { name: '教练评审' }, { name: '协作+自动' }] },
    { name: WORK_F.STYLE_PRESET, type: 'text' },
    { name: WORK_F.POV, type: 'select', multiple: false, options: [{ name: '第一人称' }, { name: '第三人称限知' }, { name: '第三人称全知' }] },
    { name: WORK_F.CURRENT_CHAPTER, type: 'number' },
    { name: WORK_F.FOLDER_URL, type: 'text', style: { type: 'url' } },
  ],
  [TABLE.VOLUME]: [
    { name: VOLUME_F.NAME, type: 'text' },
    { name: VOLUME_F.ORDER, type: 'number' },
    { name: VOLUME_F.THEME, type: 'text' },
    { name: VOLUME_F.CHAPTER_RANGE, type: 'text' },
    { name: VOLUME_F.STATUS, type: 'select', multiple: false, options: [{ name: '待写' }, { name: '进行中' }, { name: '已完成' }] },
    { name: VOLUME_F.SUMMARY, type: 'text' },
    { name: VOLUME_F.FOLDER_URL, type: 'text', style: { type: 'url' } },
  ],
  [TABLE.CHAPTER]: [
    { name: CHAPTER_F.TITLE, type: 'text' },
    { name: CHAPTER_F.NO, type: 'number' },
    { name: CHAPTER_F.WORDS, type: 'number' },
    { name: CHAPTER_F.STATUS, type: 'select', multiple: false, options: [{ name: '大纲' }, { name: '草稿' }, { name: '修订' }, { name: '定稿' }] },
    { name: CHAPTER_F.OUTLINE, type: 'text' },
    { name: CHAPTER_F.SUMMARY, type: 'text' },
    { name: CHAPTER_F.TENSION, type: 'number', style: { type: 'rating', icon: 'star', min: 1, max: 5 } },
    { name: CHAPTER_F.DOC_URL, type: 'text', style: { type: 'url' } },
    { name: CHAPTER_F.STORY_TIME, type: 'text' },
  ],
  [TABLE.CHARACTER]: [
    { name: CHARACTER_F.NAME, type: 'text' },
    { name: CHARACTER_F.ALIAS, type: 'text' },
    { name: CHARACTER_F.ROLE, type: 'text' },
    { name: CHARACTER_F.TRAITS, type: 'select', multiple: true },
    { name: CHARACTER_F.CATCHPHRASE, type: 'text' },
    { name: CHARACTER_F.MOTIVE, type: 'text' },
    { name: CHARACTER_F.APPEARANCE, type: 'text' },
    { name: CHARACTER_F.ARC_STAGE, type: 'text' },
    { name: CHARACTER_F.BIO_URL, type: 'text', style: { type: 'url' } },
  ],
  /** 人物状态快照：分层记忆 G3 的核心 */
  [TABLE.CHARACTER_STATE]: [
    { name: CHARACTER_STATE_F.LOCATION, type: 'text' },
    { name: CHARACTER_STATE_F.PHYSICAL, type: 'text' },
    { name: CHARACTER_STATE_F.EMOTION, type: 'text' },
    { name: CHARACTER_STATE_F.BELONGINGS, type: 'text' },
    { name: CHARACTER_STATE_F.RELATION_CHANGE, type: 'text' },
    { name: CHARACTER_STATE_F.SUMMARY, type: 'text' },
  ],
  [TABLE.RELATION]: [
    { name: RELATION_F.TYPE, type: 'select', multiple: false, options: [{ name: '师徒' }, { name: '血亲' }, { name: '敌对' }, { name: '爱慕' }, { name: '同盟' }, { name: '利用' }] },
    { name: RELATION_F.DESCRIPTION, type: 'text' },
    { name: RELATION_F.STATUS, type: 'select', multiple: false, options: [{ name: '存续' }, { name: '已破裂' }, { name: '已转化' }] },
  ],
  [TABLE.SETTING]: [
    { name: SETTING_F.TERM, type: 'text' },
    { name: SETTING_F.CATEGORY, type: 'select', multiple: true, options: [{ name: '地理' }, { name: '势力' }, { name: '规则' }, { name: '历史' }, { name: '物品' }, { name: '功法' }] },
    { name: SETTING_F.DEFINITION, type: 'text' },
    { name: SETTING_F.IMPORTANCE, type: 'number', style: { type: 'rating', icon: 'star', min: 1, max: 5 } },
    { name: SETTING_F.DOC_URL, type: 'text', style: { type: 'url' } },
    { name: SETTING_F.STATUS, type: 'select', multiple: false, options: [{ name: '生效' }, { name: '已废弃' }, { name: '待定' }] },
  ],
  [TABLE.FORESHADOW]: [
    { name: FORESHADOW_F.CONTENT, type: 'text' },
    { name: FORESHADOW_F.TYPE, type: 'select', multiple: false, options: [{ name: '主线' }, { name: '支线' }, { name: '人物' }, { name: '物品' }] },
    { name: FORESHADOW_F.STATUS, type: 'select', multiple: false, options: [{ name: '已埋设' }, { name: '已回收' }, { name: '已作废' }] },
    { name: FORESHADOW_F.IMPORTANCE, type: 'number', style: { type: 'rating', icon: 'star', min: 1, max: 5 } },
    { name: FORESHADOW_F.NOTE, type: 'text' },
  ],
  [TABLE.PLOTLINE]: [
    { name: PLOTLINE_F.NAME, type: 'text' },
    { name: PLOTLINE_F.TYPE, type: 'select', multiple: false, options: [{ name: '主线' }, { name: '支线' }] },
    { name: PLOTLINE_F.STATUS, type: 'select', multiple: false, options: [{ name: '铺垫' }, { name: '推进' }, { name: '高潮' }, { name: '收束' }, { name: '完结' }] },
    { name: PLOTLINE_F.DESCRIPTION, type: 'text' },
  ],
  [TABLE.EVENT]: [
    { name: EVENT_F.NAME, type: 'text' },
    { name: EVENT_F.STORY_TIME, type: 'text' },
    { name: EVENT_F.LOCATION, type: 'text' },
    { name: EVENT_F.SUMMARY, type: 'text' },
    { name: EVENT_F.IMPACT, type: 'text' },
    { name: EVENT_F.IS_TURNING_POINT, type: 'checkbox' },
  ],
  [TABLE.MEMORY]: [
    { name: MEMORY_F.TITLE, type: 'text' },
    { name: MEMORY_F.LEVEL, type: 'select', multiple: false, options: [{ name: '章节' }, { name: '卷' }, { name: '全书' }] },
    { name: MEMORY_F.FROM_CHAPTER, type: 'number' },
    { name: MEMORY_F.TO_CHAPTER, type: 'number' },
    { name: MEMORY_F.CONTENT, type: 'text' },
    { name: MEMORY_F.STALE, type: 'checkbox' },
  ],
  [TABLE.BRANCH]: [
    { name: BRANCH_F.TITLE, type: 'text' },
    { name: BRANCH_F.DESCRIPTION, type: 'text' },
    { name: BRANCH_F.ADOPT_STATUS, type: 'select', multiple: false, options: [{ name: '候选' }, { name: '已采用' }, { name: '已否决' }] },
    { name: BRANCH_F.NOTE, type: 'text' },
  ],
  [TABLE.ISSUE]: [
    { name: ISSUE_F.TITLE, type: 'text' },
    { name: ISSUE_F.TYPE, type: 'select', multiple: false, options: [{ name: '设定冲突' }, { name: '人设崩坏' }, { name: '伏笔未回收' }, { name: '时间线矛盾' }, { name: '方位矛盾' }, { name: '称谓不一致' }] },
    { name: ISSUE_F.SEVERITY, type: 'number', style: { type: 'rating', icon: 'star', min: 1, max: 5 } },
    { name: ISSUE_F.LOCATION, type: 'text' },
    { name: ISSUE_F.STATUS, type: 'select', multiple: false, options: [{ name: '待处理' }, { name: '已修复' }, { name: '已忽略' }] },
  ],
}

/**
 * 阶段 2：关联字段。
 * key = 源表表名，value = [{ field, targetTable }]，targetTable 会被解析为 table_id。
 */
export const LINK_FIELDS: Record<string, { field: FieldSchema; targetTable: string }[]> = {
  [TABLE.CHAPTER]: [
    { field: { name: CHAPTER_F.VOLUME, type: 'link' }, targetTable: TABLE.VOLUME },
  ],
  [TABLE.CHARACTER]: [
    { field: { name: CHARACTER_F.APPEARANCES, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.CHARACTER_STATE]: [
    { field: { name: CHARACTER_STATE_F.CHARACTER, type: 'link' }, targetTable: TABLE.CHARACTER },
    { field: { name: CHARACTER_STATE_F.CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.RELATION]: [
    { field: { name: RELATION_F.A, type: 'link' }, targetTable: TABLE.CHARACTER },
    { field: { name: RELATION_F.B, type: 'link' }, targetTable: TABLE.CHARACTER },
    { field: { name: RELATION_F.START_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.SETTING]: [
    { field: { name: SETTING_F.FIRST_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: SETTING_F.RELATED, type: 'link' }, targetTable: TABLE.SETTING },
  ],
  [TABLE.FORESHADOW]: [
    { field: { name: FORESHADOW_F.PLANT_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: FORESHADOW_F.PLAN_PAYOFF_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.PLOTLINE]: [
    { field: { name: PLOTLINE_F.CHAPTERS, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: PLOTLINE_F.CHARACTERS, type: 'link' }, targetTable: TABLE.CHARACTER },
    { field: { name: PLOTLINE_F.FORESHADOWS, type: 'link' }, targetTable: TABLE.FORESHADOW },
  ],
  [TABLE.EVENT]: [
    { field: { name: EVENT_F.CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: EVENT_F.PARTICIPANTS, type: 'link' }, targetTable: TABLE.CHARACTER },
  ],
  [TABLE.MEMORY]: [
    { field: { name: MEMORY_F.CHAPTERS, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.BRANCH]: [
    { field: { name: BRANCH_F.STUCK_CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
  ],
  [TABLE.ISSUE]: [
    { field: { name: ISSUE_F.CHAPTER, type: 'link' }, targetTable: TABLE.CHAPTER },
    { field: { name: ISSUE_F.CHARACTER, type: 'link' }, targetTable: TABLE.CHARACTER },
  ],
}
