/**
 * 飞书 API 的通用类型。
 * @module @unwr/feishu/types
 */

/** 单元格值。不同字段类型形状不同，见下方注释。 */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Array<{ id: string }>

/** 一条记录的字段映射。 */
export type RecordFields = Readonly<Record<string, CellValue>>

/** 字段 JSON 定义（与 lark-cli field-create 的 --json 形状一致）。 */
export interface FieldSchema {
  name: string
  /** 见 docs/requirements/02 中已验证的类型清单 */
  type: 'text' | 'number' | 'select' | 'datetime' | 'checkbox'
    | 'link' | 'formula' | 'lookup' | 'auto_number'
    | 'attachment' | 'location' | 'user' | 'group_chat'
    | 'created_at' | 'updated_at' | 'created_by' | 'updated_by' | 'button'
  description?: string
  multiple?: boolean
  options?: { name: string; hue?: string; lightness?: string }[]
  style?: Record<string, unknown>
  /** 仅 link */
  link_table?: string
  bidirectional?: boolean
  bidirectional_link_field_name?: string
  /** 仅 formula */
  expression?: string
}

/** 筛选条件：[字段名, 操作符, 值] */
export type Condition = [string, string, unknown]

/** 筛选 JSON。 */
export interface FilterJson {
  logic: 'and' | 'or'
  conditions: Condition[]
}

/** 排序项。 */
export interface SortJson {
  field: string
  desc?: boolean
}
