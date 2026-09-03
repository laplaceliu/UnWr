/**
 * matrixToObjects 的重名字段合并语义（实机事故 2026-09-03）。
 *
 * 场景：历史遗留的同名字段在同一张表里各占一列
 * （实测事件表 `章节`×2：91 条记录中 A 独占 12、B 独占 43、都有 36）。
 * 按名建键时若不合并，后一列直接覆盖前一列：
 *   - 读：12 条只有 A 有值的记录，章节关联凭空消失（上下文静默缺失）
 *   - 验证：verifyLinkBackfill 读到空列 → 误判"回填未生效" → 3 轮退避后报错
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { matrixToObjects } from '../src/apis/base.ts'
import type { RecordMatrix } from '../src/apis/base.ts'

function mk(fields: string[], field_id_list: string[], data: unknown[][], record_id_list?: string[]): RecordMatrix {
  return {
    fields,
    field_id_list,
    field_type_list: field_id_list.map(() => 'link'),
    data,
    ...(record_id_list === undefined ? {} : { record_id_list }),
  }
}

describe('matrixToObjects 重名合并', () => {
  it('唯一字段名：行为与旧实现完全一致（回归保护）', () => {
    const rows = matrixToObjects(mk(
      ['章节号', '标题'],
      ['fldN', 'fldT'],
      [[1, '第一章'], [2, '第二章']],
      ['rec1', 'rec2'],
    ))
    expect(rows).toEqual([
      { 章节号: 1, 标题: '第一章', __recordId: 'rec1' },
      { 章节号: 2, 标题: '第二章', __recordId: 'rec2' },
    ])
  })

  it('重名 link 列：两边有值 → 并集去重', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[[{ id: 'c1' }], [{ id: 'c1' }, { id: 'c2' }]]],
    ))
    expect(rows[0]!['章节']).toEqual([{ id: 'c1' }, { id: 'c2' }])
  })

  it('重名 link 列：只有第一列有值 → 不再被第二列空值覆盖（事故主路径）', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[[{ id: 'c1' }], null]],
    ))
    expect(rows[0]!['章节']).toEqual([{ id: 'c1' }])
  })

  it('重名 link 列：只有第二列有值 → 同样能读到（43 条记录的形态）', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[null, [{ id: 'c2' }]]],
    ))
    expect(rows[0]!['章节']).toEqual([{ id: 'c2' }])
  })

  it('重复元素去重保序，首次出现位置优先', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]],
    ))
    expect(rows[0]!['章节']).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })

  it('重名标量列：首个非空值优先', () => {
    const rows = matrixToObjects(mk(
      ['名称', '名称', '名称'],
      ['f1', 'f2', 'f3'],
      [[null, '来自第二列', 'ignored']],
    ))
    expect(rows[0]!['名称']).toBe('来自第二列')
  })

  it('重名标量列：第一个非空在前则保持不变', () => {
    const rows = matrixToObjects(mk(
      ['名称', '名称'],
      ['f1', 'f2'],
      [['原始', '更新的']],
    ))
    expect(rows[0]!['名称']).toBe('原始')
  })

  it('空数组不算有值（不阻断取后列）', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[[], [{ id: 'c2' }]]],
    ))
    expect(rows[0]!['章节']).toEqual([{ id: 'c2' }])
  })

  it('__recordId 在合并后依然保留', () => {
    const rows = matrixToObjects(mk(
      ['章节', '章节'],
      ['fldA', 'fldB'],
      [[[{ id: 'c1' }], null]],
      ['recX'],
    ))
    expect(rows[0]!['__recordId']).toBe('recX')
  })
})
