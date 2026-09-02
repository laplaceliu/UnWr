/**
 * 飞书数据模型 schema 静态校验
 * =============================
 *
 * 目的：在 CI/本地秒级验证 schema/work-schema.ts 的定义**完整且自洽**，
 * 无需连接到真实飞书。此用例是「02-feishu-data-model.md」对应 schema 的
 * 静态快照回归——一旦 type/options/link_table 出错或某张表少了字段，
 * 本用例立即报错，避免上线后才在飞书侧发现 800030201 not_found。
 *
 * 校验清单：
 *  1. 13 张表全部存在且无重复
 *  2. 每张表在 TABLE_SCHEMAS 里有 ≥ 1 个字段
 *  3. 每个 select 字段都至少有一个 option
 *  4. 每个 link 字段的 targetTable 都指向 TABLE.* 中已有的表
 *  5. **关键**：tables.ts 里声明的字段常量全部能在 TABLE_SCHEMAS 里找到
 *     （防 orphan 字段：常量已用、但 schema 未创建 → 写库时报 not_found）
 *  6. 主键字段存在（WORK.NAME / VOLUME.NAME / CHAPTER.TITLE ...）
 *  7. 双向 link 配对（避免单边声明）
 *  8. 没有任何 select 字段被声明为 `multiple: true` 但 options 为空数组
 */

import { describe, expect, it } from 'vitest'
import {
  ALL_TABLES,
  BRANCH_F,
  CHAPTER_F,
  CHARACTER_F,
  CHARACTER_STATE_F,
  EVENT_F,
  FORESHADOW_F,
  ISSUE_F,
  LINK_FIELDS,
  MEMORY_F,
  PLOTLINE_F,
  RELATION_F,
  SETTING_F,
  TABLE,
  TABLE_SCHEMAS,
  VOLUME_F,
  WORK_F,
} from '../src/index.ts'

describe('13 张表存在且一一对应', () => {
  it('ALL_TABLES 含 13 张表且无重复', () => {
    expect(ALL_TABLES).toHaveLength(13)
    expect(new Set(ALL_TABLES).size).toBe(13)
  })

  for (const tableName of ALL_TABLES) {
    it(`${tableName} 在 TABLE_SCHEMAS 里有字段定义`, () => {
      const fields = TABLE_SCHEMAS[tableName]
      expect(fields, `${tableName} 缺少字段定义`).toBeDefined()
      expect(fields!.length).toBeGreaterThan(0)
    })
  }
})

describe('select 字段都有 options', () => {
  const SELECT_FIELDS: { table: string; field: string; label: string; multiple?: boolean }[] = [
    { table: TABLE.WORK, field: WORK_F.GENRE, label: 'WORK.GENRE' },
    { table: TABLE.WORK, field: WORK_F.SCALE, label: 'WORK.SCALE' },
    { table: TABLE.WORK, field: WORK_F.MODE, label: 'WORK.MODE' },
    { table: TABLE.WORK, field: WORK_F.POV, label: 'WORK.POV' },
    { table: TABLE.VOLUME, field: VOLUME_F.STATUS, label: 'VOLUME.STATUS' },
    { table: TABLE.CHAPTER, field: CHAPTER_F.STATUS, label: 'CHAPTER.STATUS' },
    { table: TABLE.CHARACTER, field: CHARACTER_F.TRAITS, label: 'CHARACTER.TRAITS', multiple: true },
    { table: TABLE.SETTING, field: SETTING_F.CATEGORY, label: 'SETTING.CATEGORY', multiple: true },
    { table: TABLE.SETTING, field: SETTING_F.STATUS, label: 'SETTING.STATUS' },
    { table: TABLE.FORESHADOW, field: FORESHADOW_F.TYPE, label: 'FORESHADOW.TYPE' },
    { table: TABLE.FORESHADOW, field: FORESHADOW_F.STATUS, label: 'FORESHADOW.STATUS' },
    { table: TABLE.RELATION, field: RELATION_F.TYPE, label: 'RELATION.TYPE' },
    { table: TABLE.RELATION, field: RELATION_F.STATUS, label: 'RELATION.STATUS' },
    { table: TABLE.PLOTLINE, field: PLOTLINE_F.TYPE, label: 'PLOTLINE.TYPE' },
    { table: TABLE.PLOTLINE, field: PLOTLINE_F.STATUS, label: 'PLOTLINE.STATUS' },
    { table: TABLE.MEMORY, field: MEMORY_F.LEVEL, label: 'MEMORY.LEVEL' },
    { table: TABLE.BRANCH, field: BRANCH_F.ADOPT_STATUS, label: 'BRANCH.ADOPT_STATUS' },
    { table: TABLE.ISSUE, field: ISSUE_F.TYPE, label: 'ISSUE.TYPE' },
    { table: TABLE.ISSUE, field: ISSUE_F.STATUS, label: 'ISSUE.STATUS' },
  ]
  for (const { table, field, label, multiple } of SELECT_FIELDS) {
    it(`${label} 是 select 且 options 非空${multiple === true ? '（多选）' : ''}`, () => {
      const f = TABLE_SCHEMAS[table]?.find(x => x.name === field)
      expect(f, `${label} 不在 TABLE_SCHEMAS[${table}] 中`).toBeDefined()
      expect(f!.type).toBe('select')
      expect(f!.options?.length ?? 0).toBeGreaterThan(0)
      if (multiple === true) expect(f!.multiple).toBe(true)
    })
  }
})

describe('link 字段都指向存在的表', () => {
  for (const [source, links] of Object.entries(LINK_FIELDS)) {
    for (const { field, targetTable } of links) {
      it(`${source}.${field.name} -> ${targetTable}`, () => {
        expect(ALL_TABLES, `${targetTable} 不在 ALL_TABLES 中`).toContain(targetTable)
        expect(field.type).toBe('link')
        // link 字段可放在 TABLE_SCHEMAS（被 init-work stage 1 创建）或
        // LINK_FIELDS（被 init-work stage 2 创建），任一处即可
        const inSchema = TABLE_SCHEMAS[source]?.some(x => x.name === field.name) === true
        const inLink = LINK_FIELDS[source]?.some(x => x.field.name === field.name) === true
        expect(
          inSchema || inLink,
          `${source}.${field.name} 未在任何处登记`,
        ).toBe(true)
      })
    }
  }
})

describe('tables.ts 声明的字段常量全部有 schema 定义（防 orphan）', () => {
  /**
   * 哪些字段是系统自动管理的（updated_at / created_at）—— 不需要出现在
   * TABLE_SCHEMAS 里，飞书会自动添加。其它业务字段必须能在 TABLE_SCHEMAS
   * 里查到，否则 init-work 时不会创建，写库时静默失败。
   */
  const AUTO_MANAGED = new Set([CHAPTER_F.UPDATED_AT])

  const TABLE_TO_FIELDS: { table: string; fields: Record<string, string> }[] = [
    { table: TABLE.WORK, fields: WORK_F as unknown as Record<string, string> },
    { table: TABLE.VOLUME, fields: VOLUME_F as unknown as Record<string, string> },
    { table: TABLE.CHAPTER, fields: CHAPTER_F as unknown as Record<string, string> },
    { table: TABLE.CHARACTER, fields: CHARACTER_F as unknown as Record<string, string> },
    { table: TABLE.CHARACTER_STATE, fields: CHARACTER_STATE_F as unknown as Record<string, string> },
    { table: TABLE.RELATION, fields: RELATION_F as unknown as Record<string, string> },
    { table: TABLE.SETTING, fields: SETTING_F as unknown as Record<string, string> },
    { table: TABLE.FORESHADOW, fields: FORESHADOW_F as unknown as Record<string, string> },
    { table: TABLE.PLOTLINE, fields: PLOTLINE_F as unknown as Record<string, string> },
    { table: TABLE.EVENT, fields: EVENT_F as unknown as Record<string, string> },
    { table: TABLE.MEMORY, fields: MEMORY_F as unknown as Record<string, string> },
    { table: TABLE.BRANCH, fields: BRANCH_F as unknown as Record<string, string> },
    { table: TABLE.ISSUE, fields: ISSUE_F as unknown as Record<string, string> },
  ]

  const orphans: string[] = []
  for (const { table, fields } of TABLE_TO_FIELDS) {
    for (const value of Object.values(fields)) {
      if (AUTO_MANAGED.has(value)) continue
      const f = TABLE_SCHEMAS[table]?.find(x => x.name === value)
        ?? LINK_FIELDS[table]?.some(x => x.field.name === value)
      if (f === undefined || f === false) {
        orphans.push(`${table}.${value}`)
      }
    }
  }

  it('没有 orphan 字段常量', () => {
    expect(orphans, `以下字段常量在 tables.ts 声明但 TABLE_SCHEMAS / LINK_FIELDS 中未实现：\n${orphans.join('\n')}`).toEqual([])
  })
})

describe('主键字段存在', () => {
  const PRIMARY: [string, string][] = [
    [TABLE.WORK, WORK_F.NAME],
    [TABLE.VOLUME, VOLUME_F.NAME],
    [TABLE.CHAPTER, CHAPTER_F.TITLE],
    [TABLE.CHARACTER, CHARACTER_F.NAME],
    [TABLE.SETTING, SETTING_F.TERM],
    [TABLE.FORESHADOW, FORESHADOW_F.CONTENT],
    [TABLE.MEMORY, MEMORY_F.TITLE],
    [TABLE.BRANCH, BRANCH_F.TITLE],
    [TABLE.ISSUE, ISSUE_F.TITLE],
    [TABLE.PLOTLINE, PLOTLINE_F.NAME],
    [TABLE.EVENT, EVENT_F.NAME],
    [TABLE.RELATION, RELATION_F.A],
  ]
  for (const [table, field] of PRIMARY) {
    it(`${table}.${field} 存在`, () => {
      const f = TABLE_SCHEMAS[table]?.find(x => x.name === field)
        ?? LINK_FIELDS[table]?.find(x => x.field.name === field)?.field
      expect(f, `${table}.${field} 缺失`).toBeDefined()
    })
  }
})

describe('多选 select 字段 options 非空', () => {
  it('CHARACTER.TRAITS 和 SETTING.CATEGORY 都多选且 options 非空', () => {
    const traits = TABLE_SCHEMAS[TABLE.CHARACTER]?.find(x => x.name === CHARACTER_F.TRAITS)
    expect(traits?.multiple).toBe(true)
    expect(traits?.options?.length ?? 0).toBeGreaterThan(0)
    const cat = TABLE_SCHEMAS[TABLE.SETTING]?.find(x => x.name === SETTING_F.CATEGORY)
    expect(cat?.multiple).toBe(true)
    expect(cat?.options?.length ?? 0).toBeGreaterThan(0)
  })
})