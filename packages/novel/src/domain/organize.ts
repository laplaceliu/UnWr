/**
 * 作品资源组织：多本小说在云盘中的隔离与归位（文件夹方案）。
 *
 * 结构（用户决策，替代原 wiki 树方案——wiki 放不下 Base，且收敛慢）：
 *
 * ```
 * 我的文档/
 * └── 《作品A》/                 ← 根文件夹，作品表「文档目录」记录
 *     ├── 作品A.base             ← 数据库也在里面（wiki 方案做不到）
 *     ├── 第一章 雨夜叩门.docx    ← 未指明卷：直接放根文件夹
 *     └── 第一卷 旧剑/            ← 指明卷：自动创建卷子文件夹
 *         └── 第三章.docx
 * ```
 *
 * 归位规则（writeChapter 每次执行）：
 *   1. 作品表有「文档目录」→ 继续；没有 → 正文落「我的文档」根 + 提示补挂
 *   2. 未指明卷 → 根文件夹
 *   3. 指明卷 → 卷表有「文档目录」则用之；没有则 create-folder 并回填卷表
 *      （创建场景直接用 createFolder 返回值，规避写入可见性延迟）
 *
 * @module @unwr/novel/domain/organize
 */

import { base, drive } from '@unwr/feishu'
import type { CellValue } from '@unwr/feishu'
import { VOLUME_F, WORK_F } from '@unwr/schema'

/** 写章时解析出的挂载点。 */
export interface ChapterMount {
  /** 正文文档的父文件夹 token；undefined = 落「我的文档」根目录 */
  parentToken?: string
  /**
   * 卷表记录 ID（章节表「所属卷」link 字段写入用）。
   * link 字段值必须是 `[{id}]` 关联格式——传字符串报 800030201。
   * 创建场景直接用 createRecords 返回值，规避可见性延迟。
   */
  volumeRecordId?: string
  warnings: string[]
}

/** 取作品根文件夹 token。未挂目录时返回 undefined。 */
export async function getWorkRootFolder(
  baseToken: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const rows = base.matrixToObjects(
      await base.listRecords(baseToken, '作品表', {
        fieldIds: [WORK_F.FOLDER_URL],
        limit: 1,
      }, signal),
    )
    return drive.extractFolderToken(str(rows[0]?.[WORK_F.FOLDER_URL]))
  } catch {
    return undefined
  }
}

/** 取某卷的卷文件夹 token；无记录或未记录时返回 undefined。 */
export async function getVolumeFolder(
  baseToken: string,
  volumeName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const rows = base.matrixToObjects(
      await base.listRecords(baseToken, '卷表', {
        fieldIds: [VOLUME_F.NAME, VOLUME_F.FOLDER_URL],
        filter: { logic: 'and', conditions: [[VOLUME_F.NAME, '==', volumeName]] },
        limit: 1,
      }, signal),
    )
    return drive.extractFolderToken(str(rows[0]?.[VOLUME_F.FOLDER_URL]))
  } catch {
    return undefined
  }
}

/** 回填卷表「文档目录」。返回卷记录 ID。 */
async function saveVolumeFolder(
  baseToken: string,
  volumeName: string,
  url: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, '卷表', {
      fieldIds: [VOLUME_F.NAME],
      filter: { logic: 'and', conditions: [[VOLUME_F.NAME, '==', volumeName]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  const fields: Record<string, CellValue> = { [VOLUME_F.FOLDER_URL]: url }
  if (typeof id === 'string') {
    await base.updateRecords(baseToken, '卷表', { [id]: fields }, signal)
    return id
  }
  // 卷表还没有该卷：建一条，保证下次直接命中
  const ids = await base.createRecords(
    baseToken,
    '卷表',
    [{ [VOLUME_F.NAME]: volumeName, [VOLUME_F.FOLDER_URL]: url }],
    signal,
  )
  return ids[0]
}

/** 查卷表记录 ID（章节表 link 写入用）。 */
export async function findVolumeRecordId(
  baseToken: string,
  volumeName: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, '卷表', {
      fieldIds: [VOLUME_F.NAME],
      filter: { logic: 'and', conditions: [[VOLUME_F.NAME, '==', volumeName]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/**
 * 解析写章时的父文件夹。
 *
 * **尽力而为**：任何一步失败都降级为根目录 + 提示，
 * 绝不让「组织结构问题」阻断「写作本身」。
 */
export async function resolveChapterMount(
  baseToken: string,
  context: { volume?: string },
  signal?: AbortSignal,
): Promise<ChapterMount> {
  const warnings: string[] = []

  const workRoot = await getWorkRootFolder(baseToken, signal)
  if (workRoot === undefined) {
    return { warnings }
  }

  // 未指明卷：直接放根文件夹
  const volumeName = context.volume
  if (volumeName === undefined || volumeName === '') {
    return { parentToken: workRoot, warnings }
  }

  // 已有卷文件夹 → 直接用
  const existing = await getVolumeFolder(baseToken, volumeName, signal)
  if (existing !== undefined) {
    const volumeRecordId = await findVolumeRecordId(baseToken, volumeName, signal)
    return {
      parentToken: existing,
      ...volumeRecordId === undefined ? {} : { volumeRecordId },
      warnings,
    }
  }

  // 卷文件夹缺失 → 在作品根文件夹下创建（卷名即文件夹名）
  try {
    const folder = await drive.createFolder(volumeName, { parentFolderToken: workRoot }, signal)
    const volumeRecordId = await saveVolumeFolder(baseToken, volumeName, folder.url, signal)
    warnings.push(`已为「${volumeName}」创建卷文件夹，后续该卷章节自动归位。`)
    return {
      parentToken: folder.folder_token,
      ...volumeRecordId === undefined ? {} : { volumeRecordId },
      warnings,
    }
  } catch (e) {
    warnings.push(
      `卷文件夹创建失败（正文将放作品根文件夹下）：${e instanceof Error ? e.message : String(e)}`,
    )
    return { parentToken: workRoot, warnings }
  }
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)

/* ------------------------------------------------------------------ */
/* 章节号 → record ID 写后缓存                                            */
/* ------------------------------------------------------------------ */

/**
 * 章节记录的「读自己的写」缓存（TTL 60s，容量 200）。
 *
 * 为什么需要：create+update 两段式写入后，飞书 Base 的列表索引有 ~6s
 * 延迟（实机 2026-09-02：awaitVisible 等 6.1s 仍查不到）。期间按章节号
 * 列表查找会扑空，导致 set_chapter_outline 重复建章壳、write_chapter
 * 误判章不存在、revise/append 报"章不存在"。
 *
 * 写入方（writeChapter / setChapterOutline 自动建章）在 create 成功后
 * 调用 rememberChapterRecordId 种缓存；读取方 findChapterRecordIdCached
 * 命中即绕开列表延迟。放在本模块（而非 entity/chapter）以避免两者循环导入。
 *
 * 局限：仅进程内有效。跨进程的写后立即读仍有延迟窗口，由 awaitVisible
 * 的等待与警告兜底。
 */
const chapterIdCache = new Map<string, { recordId: string; at: number }>()
const CHAPTER_ID_CACHE_TTL = 60_000
const CHAPTER_ID_CACHE_MAX = 200

/** 写入方在章节记录 create 成功后种缓存。 */
export function rememberChapterRecordId(
  baseToken: string,
  chapterNo: number,
  recordId: string,
): void {
  if (chapterIdCache.size >= CHAPTER_ID_CACHE_MAX) chapterIdCache.clear()
  chapterIdCache.set(`${baseToken}|${chapterNo}`, { recordId, at: Date.now() })
}

/** 删除章节后必须调本函数清缓存——否则同一会话内再创建同号章节会被旧 recordId 命中。 */
export function forgetChapterRecordId(
  baseToken: string,
  chapterNo: number,
): void {
  chapterIdCache.delete(`${baseToken}|${chapterNo}`)
}

/**
 * 带缓存的章节号查找：命中缓存直接返回（无列表延迟）；
 * 未命中走列表查找，查到后回种缓存。
 */
export async function findChapterRecordIdCached(
  baseToken: string,
  chapterNo: number,
  lookup: (baseToken: string, chapterNo: number, signal?: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const key = `${baseToken}|${chapterNo}`
  const hit = chapterIdCache.get(key)
  if (hit !== undefined) {
    if (Date.now() - hit.at <= CHAPTER_ID_CACHE_TTL) return hit.recordId
    chapterIdCache.delete(key)
  }
  const id = await lookup(baseToken, chapterNo, signal)
  if (id !== undefined) {
    chapterIdCache.set(key, { recordId: id, at: Date.now() })
  }
  return id
}

/** 测试钩子：清空章节缓存（跨用例隔离）。 */
export function clearChapterIdCacheForTests(): void {
  chapterIdCache.clear()
}
