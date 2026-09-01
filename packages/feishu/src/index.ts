/**
 * UnWr 飞书适配层入口。
 *
 * 本层职责：屏蔽 lark-cli 的全部参数陷阱，向上提供 typed 领域 API。
 * 上层代码不应感知 lark-cli 的存在。
 * @module @unwr/feishu
 */

export * from './cli.ts'
export * from './errors.ts'
export * from './file-bridge.ts'
export * as base from './apis/base.ts'
export * as docs from './apis/docs.ts'
export * as wiki from './apis/wiki.ts'
export * as drive from './apis/drive.ts'

export type { Identity, RunOptions } from './cli.ts'
export type { CellValue, FieldSchema, FilterJson, RecordFields, SortJson } from './types.ts'
