/**
 * 临时文件桥接层。
 *
 * 破解 lark-cli 的两个硬约束（需求阶段实测）：
 *   1. `@file` 只接受**相对路径**，传绝对路径报 `unsafe file path`
 *   2. `--json` **不支持 stdin**（传 `-` 会报 JSON 解析错误）
 *
 * 唯一解法：把内容写入临时目录 → `cd` 到该目录 → 用相对路径调用 → 清理。
 * 本模块把这个流程封装为 `withTempFile`，上层永远传内容或绝对路径。
 *
 * 另外：章节正文**必须**走文件传参。shell 单引号里 `\n` 是字面量，
 * 内联传参会让整章变成一行，且 `#` 无法转成标题块（outline 为空）。
 *
 * @module @unwr/feishu/file-bridge
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 桥接产生的临时文件句柄：只需把 `relative` 传给 CLI。 */
export interface TempFile {
  /** 相对路径，直接用于 `--json @<relative>` 或 `--content @<relative>` */
  readonly relative: string
  /** 绝对路径，仅供诊断 */
  readonly absolute: string
}

/** 临时目录句柄：作为 spawn 的 cwd 传入。 */
export interface TempDir {
  /** 临时目录绝对路径，作为 spawn 的 cwd */
  readonly cwd: string
  /** 在该目录内写入文件并返回相对路径句柄 */
  write(name: string, content: string): Promise<TempFile>
  /** 清理整个目录（失败不抛，避免掩盖主错误） */
  cleanup(): Promise<void>
}

const PREFIX = 'unwr-'

/**
 * 创建临时目录。
 *
 * 调用方**必须**在 finally 中调用 `cleanup()`。
 */
export async function createTempDir(): Promise<TempDir> {
  const cwd = await mkdtemp(join(tmpdir(), PREFIX))

  const write = async (name: string, content: string): Promise<TempFile> => {
    // 防止路径穿越：拒绝任何含分隔符或 .. 的名字
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new Error(`invalid temp file name: ${name}`)
    }
    const absolute = join(cwd, name)
    await writeFile(absolute, content, 'utf8')
    return { relative: name, absolute }
  }

  const cleanup = async (): Promise<void> => {
    try {
      await rm(cwd, { recursive: true, force: true })
    } catch {
      // 清理失败不应掩盖主流程错误
    }
  }

  return { cwd, write, cleanup }
}

/**
 * 在临时目录内执行回调，结束后自动清理。
 *
 * @example
 * ```ts
 * const result = await withTempDir(async (dir) => {
 *   const f = await dir.write('fields.json', JSON.stringify(fields))
 *   return runCli(['base', '+table-create', '--fields', `@${f.relative}`], { cwd: dir.cwd })
 * })
 * ```
 */
export async function withTempDir<T>(fn: (dir: TempDir) => Promise<T>): Promise<T> {
  const dir = await createTempDir()
  try {
    return await fn(dir)
  } finally {
    await dir.cleanup()
  }
}
