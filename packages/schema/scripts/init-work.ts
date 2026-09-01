/**
 * 为一部作品建齐 13 张表。
 *
 * 表结构定义见 docs/requirements/02-feishu-data-model.md。
 * 用法：tsx packages/schema/scripts/init-work.ts <base_token>
 */

import {
  base,
} from '../../feishu/src/index.ts'
import {
  CHARACTER_F, CHAPTER_F, EVENT_F, FORESHADOW_F, ISSUE_F, MEMORY_F,
  PLOTLINE_F, SETTING_F, TABLE, VOLUME_F, WORK_F,
} from '../src/tables.ts'
import type { FieldSchema } from '../../feishu/src/types.ts'

/** 全部表的字段定义。 */
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
  ],
  [TABLE.VOLUME]: [
    { name: VOLUME_F.NAME, type: 'text' },
    { name: VOLUME_F.ORDER, type: 'number' },
    { name: VOLUME_F.THEME, type: 'text' },
    { name: VOLUME_F.CHAPTER_RANGE, type: 'text' },
    { name: VOLUME_F.STATUS, type: 'select', multiple: false, options: [{ name: '待写' }, { name: '进行中' }, { name: '已完成' }] },
    { name: VOLUME_F.SUMMARY, type: 'text' },
    { name: VOLUME_F.WIKI_URL, type: 'text', style: { type: 'url' } },
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
    { name: CHAPTER_F.WIKI_URL, type: 'text', style: { type: 'url' } },
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
  [TABLE.PLOTLINE]: [
    { name: PLOTLINE_F.NAME, type: 'text' },
    { name: PLOTLINE_F.TYPE, type: 'select', multiple: false, options: [{ name: '主线' }, { name: '支线' }] },
    { name: PLOTLINE_F.STATUS, type: 'select', multiple: false, options: [{ name: '铺垫' }, { name: '推进' }, { name: '高潮' }, { name: '收束' }, { name: '完结' }] },
    { name: PLOTLINE_F.DESCRIPTION, type: 'text' },
  ],
  [TABLE.ISSUE]: [
    { name: ISSUE_F.TITLE, type: 'text' },
    { name: ISSUE_F.TYPE, type: 'select', multiple: false, options: [{ name: '设定冲突' }, { name: '人设崩坏' }, { name: '伏笔未回收' }, { name: '时间线矛盾' }, { name: '方位矛盾' }, { name: '称谓不一致' }] },
    { name: ISSUE_F.SEVERITY, type: 'number', style: { type: 'rating', icon: 'star', min: 1, max: 5 } },
    { name: ISSUE_F.LOCATION, type: 'text' },
    { name: ISSUE_F.STATUS, type: 'select', multiple: false, options: [{ name: '待处理' }, { name: '已修复' }, { name: '已忽略' }] },
  ],
}

/** 建齐缺失的表（已存在的跳过）。 */
export async function initWork(baseToken: string): Promise<{
  created: string[]
  existing: string[]
}> {
  const existingTables = (await base.listTables(baseToken)).tables.map((t) => t.name)
  const created: string[] = []
  const existing: string[] = []

  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (existingTables.includes(name)) {
      existing.push(name)
      continue
    }
    await base.createTable(baseToken, name, fields)
    created.push(name)
  }
  return { created, existing }
}

/** CLI 入口。 */
async function main(): Promise<void> {
  const token = process.argv[2]
  if (token === undefined) {
    console.error('用法: tsx init-work.ts <base_token>')
    process.exit(1)
  }
  const r = await initWork(token)
  console.log('新建:', r.created.join(', ') || '(无)')
  console.log('已存在:', r.existing.join(', ') || '(无)')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
