/**
 * 为一部作品建齐全部表。
 *
 * 分两个阶段：
 *   1. 建表 + 普通字段（TABLE_SCHEMAS）
 *   2. 建关联字段（LINK_FIELDS）—— 因为 `link` 字段需要目标表的 **table_id**，
 *      而 table_id 只有在表创建后才拿得到，所以无法在阶段 1 内联创建。
 *
 * 表结构定义见 docs/requirements/02-feishu-data-model.md。
 *
 * 用法：
 *   tsx packages/schema/scripts/init-work.ts <base_token>           # 建缺失的表
 *   tsx packages/schema/scripts/init-work.ts <base_token> --sync-fields   # 补字段
 * @module
 */

import { base } from '../../feishu/src/index.ts'
import {
  BRANCH_F, CHARACTER_F, CHARACTER_STATE_F, CHAPTER_F, EVENT_F, FORESHADOW_F,
  ISSUE_F, MEMORY_F, PLOTLINE_F, RELATION_F, SETTING_F, TABLE, VOLUME_F, WORK_F,
} from '../src/tables.ts'
import type { FieldSchema } from '../../feishu/src/types.ts'

/**
 * 阶段 1：表与**非关联**字段。
 * 关联字段一律放 LINK_FIELDS，否则会因缺少 table_id 而失败。
 */
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

/** 建齐缺失的表与字段。已存在的跳过。 */
export async function initWork(
  baseToken: string,
  options: { syncFields?: boolean } = {},
): Promise<{ createdTables: string[]; createdFields: number }> {
  const tables = (await base.listTables(baseToken)).tables
  const tableIdByName = new Map(tables.map((t) => [t.name, t.id]))
  const createdTables: string[] = []
  let createdFields = 0

  // 阶段 1：建表 + 普通字段
  for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
    if (tableIdByName.has(name)) continue
    const info = await base.createTable(baseToken, name, fields)
    tableIdByName.set(name, info.id)
    createdTables.push(name)
    createdFields += fields.length
  }

  // 阶段 2：建关联字段（需 table_id）
  for (const [sourceTable, links] of Object.entries(LINK_FIELDS)) {
    const sourceId = tableIdByName.get(sourceTable)
    if (sourceId === undefined) continue

    const existing = new Set((await listFieldNames(baseToken, sourceId)))
    for (const { field, targetTable } of links) {
      if (existing.has(field.name)) continue
      const targetId = tableIdByName.get(targetTable)
      if (targetId === undefined) continue
      try {
        await createLinkField(baseToken, sourceId, field, targetId)
        createdFields++
      } catch (e) {
        // 关联字段创建失败不应阻断整体流程，但必须显式报告
        console.error(`  ! ${sourceTable}.${field.name} 创建失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 阶段 3（可选）：为已存在的表补齐后续新增的普通字段
  if (options.syncFields === true) {
    for (const [name, fields] of Object.entries(TABLE_SCHEMAS)) {
      const tableId = tableIdByName.get(name)
      if (tableId === undefined) continue
      const existing = new Set(await listFieldNames(baseToken, tableId))
      const missing = fields.filter((f) => !existing.has(f.name))
      if (missing.length === 0) continue
      await base.createFields(baseToken, tableId, missing)
      createdFields += missing.length
      console.log(`  + ${name}: 补 ${missing.length} 个字段 → ${missing.map((f) => f.name).join(', ')}`)
    }
  }

  return { createdTables, createdFields }
}

/**
 * 创建关联字段，带重试。
 *
 * 实测：link 字段创建偶发瞬时失败（API 限流或表刚建好尚未就绪），
 * 直接重跑一次往往就成功。这里做有限重试，避免每次都要手动补跑。
 */
async function createLinkField(
  baseToken: string,
  sourceId: string,
  field: FieldSchema,
  targetId: string,
  maxAttempts = 3,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await base.createFields(baseToken, sourceId, [{ ...field, link_table: targetId }])
      return
    } catch (e) {
      lastError = e
      if (attempt < maxAttempts) {
        // 退避：1s, 2s
        await new Promise((r) => setTimeout(r, attempt * 1000))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 列出一张表的所有字段名。 */
async function listFieldNames(baseToken: string, tableId: string): Promise<string[]> {
  const { runCli } = await import('../../feishu/src/cli.ts')
  const res = await runCli<{ fields: { name: string }[] }>(
    ['base', '+field-list', '--base-token', baseToken, '--table-id', tableId],
  )
  return (res.fields ?? []).map((f) => f.name)
}

/** CLI 入口。 */
async function main(): Promise<void> {
  const token = process.argv[2]
  if (token === undefined) {
    console.error('用法: tsx init-work.ts <base_token> [--sync-fields]')
    process.exit(1)
  }
  const r = await initWork(token, { syncFields: process.argv.includes('--sync-fields') })
  console.log('新建表:', r.createdTables.join(', ') || '(无)')
  console.log('新建字段数:', r.createdFields)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
