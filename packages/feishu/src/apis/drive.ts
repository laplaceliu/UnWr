/**
 * 云盘文件夹 API（作品目录组织）。
 *
 * 文件夹方案（用户决策，替代原 wiki 树方案）的理由：
 *   - **Base 可以放进文件夹**（wiki 树做不到）——一本小说的数据库与
 *     全部正文因此能真正「在一个目录下」
 *   - `create-folder` 是老 API，无 wiki 节点的分钟级收敛问题
 *   - 每本小说一个文件夹，多本作品天然隔离
 *
 * @module @unwr/feishu/apis/drive
 */

import { runCli } from '../cli.ts'

export interface CreatedFolder {
  folder_token: string
  name: string
  url: string
}

/**
 * 创建文件夹。
 *
 * @param parentFolderToken 省略时创建在用户云盘根目录
 */
export async function createFolder(
  name: string,
  options: { parentFolderToken?: string } = {},
  signal?: AbortSignal,
): Promise<CreatedFolder> {
  const args = ['drive', '+create-folder', '--name', name]
  if (options.parentFolderToken !== undefined && options.parentFolderToken !== '') {
    args.push('--folder-token', options.parentFolderToken)
  }
  const res = await runCli<CreatedFolder>(args, { signal })
  return res
}

/** 从云盘 URL 提取 folder token（形如 /drive/folder/<token>）。 */
export function extractFolderToken(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  const m = /\/(?:drive\/)?folder\/([A-Za-z0-9]+)/.exec(url)
  return m?.[1]
}
