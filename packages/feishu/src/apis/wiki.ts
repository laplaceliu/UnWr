/**
 * 知识空间 API（作品目录树）。
 *
 * 需求阶段已验证：作品 → 卷 → 章 三级节点树可正常创建。
 * Q3 决策：一个知识空间放多部作品，即 空间 → 作品 → 卷 → 章 四级。
 *
 * 安全策略：删除类命令（node-delete / delete-space）一律不暴露。
 *
 * @module @unwr/feishu/apis/wiki
 */

import { runCli } from '../cli.ts'

/** 节点对象类型。 */
export type ObjType = 'sheet' | 'mindnote' | 'bitable' | 'file' | 'docx' | 'slides'

export interface WikiNode {
  node_token: string
  obj_token: string
  obj_type: ObjType
  title: string
  node_type?: 'origin' | 'shortcut'
  parent_node_token?: string
  has_child?: boolean
  space_id?: string
  url?: string
}

export interface Space {
  space_id: string
  name: string
  description?: string
  space_type?: string
  visibility?: string
}

/** 列出可访问的知识空间。 */
export function listSpaces(signal?: AbortSignal): Promise<{ spaces: Space[] }> {
  return runCli(['wiki', '+space-list'], { signal })
}

/**
 * 创建节点。
 *
 * 省略 `--space-id` 与 `--parent-node-token` 时落到个人文档库，
 * 因此调用方应至少提供其一。
 */
export function createNode(
  title: string,
  options: {
    spaceId?: string
    parentNodeToken?: string
    objType?: ObjType
  } = {},
  signal?: AbortSignal,
): Promise<WikiNode> {
  const args = ['wiki', '+node-create', '--title', title, '--obj-type', options.objType ?? 'docx']
  if (options.spaceId !== undefined) args.push('--space-id', options.spaceId)
  if (options.parentNodeToken !== undefined) args.push('--parent-node-token', options.parentNodeToken)
  return runCli<WikiNode>(args, { signal })
}

/** 列出空间内或某节点下的子节点。 */
export function listNodes(
  options: { spaceId?: string; parentNodeToken?: string } = {},
  signal?: AbortSignal,
): Promise<{ items: WikiNode[] }> {
  const args = ['wiki', '+node-list']
  if (options.spaceId !== undefined) args.push('--space-id', options.spaceId)
  if (options.parentNodeToken !== undefined) args.push('--parent-node-token', options.parentNodeToken)
  return runCli(args, { signal })
}

/** 获取节点详情。 */
export function getNode(
  nodeToken: string,
  signal?: AbortSignal,
): Promise<{ node: WikiNode }> {
  return runCli(['wiki', '+node-get', '--token', nodeToken], { signal })
}
