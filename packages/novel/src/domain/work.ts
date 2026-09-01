/**
 * 作品级操作：发现 / 创建 / 读取配置。
 *
 * 一部作品 = 一个飞书多维表格（Base）。
 * 「作品表」是该 Base 内的第一张表，存元信息与题材配置。
 *
 * @module @unwr/novel/domain/work
 */

import { base } from '@unwr/feishu'
import { runCli } from '@unwr/feishu'
import { WORK_F } from '@unwr/schema'
import type { CellValue } from '@unwr/feishu'
import type { GenrePreset } from '@unwr/schema'
import { getPreset } from '../genre/presets.ts'
import { createRecordsWithSelfHeal } from './selfheal.ts'
import { awaitVisible } from './chapter.ts'

/** 一部作品的摘要信息。 */
export interface WorkSummary {
  baseToken: string
  name: string
  url?: string
  updatedAt?: string
}

/**
 * 列出可访问的作品库（多维表格）。
 *
 * 实测的 CLI 行为：
 *   - 分页参数是 `--page-size`（1-20），**没有 `--limit`**
 *   - 结果在 `data.results[]`，每条的字段在 `result_meta` 里
 *   - 标题在 `title_highlighted`，可能含高亮 HTML 标签，需剥离
 */
export async function listWorks(
  options: { pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<WorkSummary[]> {
  const size = Math.min(Math.max(1, options.pageSize ?? 20), 20)
  const res = await runCli<{
    results?: {
      entity_type?: string
      title_highlighted?: string
      result_meta?: {
        token?: string
        url?: string
        owner_name?: string
        update_time_iso?: string
        doc_types?: string
      }
    }[]
  }>(
    ['drive', '+search', '--doc-types', 'bitable', '--page-size', String(size)],
    { signal },
  )

  return (res.results ?? [])
    .map((r) => ({
      baseToken: r.result_meta?.token ?? '',
      // 剥离搜索高亮标记（如 <em>）
      name: stripHighlight(r.title_highlighted ?? ''),
      ...r.result_meta?.url === undefined ? {} : { url: r.result_meta.url },
      ...r.result_meta?.update_time_iso === undefined
        ? {}
        : { updatedAt: r.result_meta.update_time_iso },
    }))
    .filter((w) => w.baseToken !== '')
}

/** 剥离搜索结果中的高亮标签。 */
function stripHighlight(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/** 读取作品配置。缺表或缺记录时回落到默认值而非报错。 */
export interface WorkConfig {
  name: string
  genre: string
  subgenre: string
  scale: string
  targetWords: number
  mode: string
  pov: string
  currentChapter: number
  /** 本作品在知识空间的根节点 URL（未挂空间时为空） */
  /** 本作品的云盘根文件夹（《作品名》/）URL；未挂目录时为空 */
  folderUrl: string
  /** 解析后的题材预设；作品表未指定时按题材名回落 */
  preset: GenrePreset
}

export async function getWorkConfig(
  baseToken: string,
  signal?: AbortSignal,
): Promise<WorkConfig> {
  let row: Record<string, unknown> = {}
  try {
    const rows = base.matrixToObjects(
      await base.listRecords(baseToken, '作品表', {
        fieldIds: [
          WORK_F.NAME, WORK_F.GENRE, WORK_F.SUBGENRE, WORK_F.SCALE,
          WORK_F.TARGET_WORDS, WORK_F.MODE, WORK_F.POV, WORK_F.CURRENT_CHAPTER,
          WORK_F.FOLDER_URL,
        ],
        limit: 1,
      }, signal),
    )
    row = rows[0] ?? {}
  } catch {
    // 作品表不存在时按默认配置继续，不阻断
  }

  const genreText = firstStr(row[WORK_F.GENRE])
  const presetId = genreText.includes('网文') ? 'webnovel'
    : genreText.includes('纯文学') ? 'literary'
      : genreText.includes('类型') ? 'genre'
        : 'webnovel'

  return {
    name: str(row[WORK_F.NAME]),
    genre: genreText,
    subgenre: str(row[WORK_F.SUBGENRE]),
    scale: firstStr(row[WORK_F.SCALE]),
    targetWords: num(row[WORK_F.TARGET_WORDS]),
    mode: firstStr(row[WORK_F.MODE]),
    pov: firstStr(row[WORK_F.POV]),
    currentChapter: num(row[WORK_F.CURRENT_CHAPTER]),
    folderUrl: str(row[WORK_F.FOLDER_URL]),
    preset: getPreset(presetId),
  }
}

/**
 * 为作品创建云盘根文件夹（《作品名》/）。
 *
 * **只建文件夹，不写库**——调用方（novel_manage_work create/link_folder）
 * 负责把返回的 url 与其他元信息**一次性**写入作品表。
 * 此前在 wiki 方案里这里同步写库，与 meta 写入分两次查询记录，
 * 撞上写入可见性延迟会创建两条作品记录。
 */
export async function createWorkRootFolder(
  workName: string,
  signal?: AbortSignal,
): Promise<{ folderToken: string; url: string }> {
  const { drive } = await import('@unwr/feishu')
  const folder = await drive.createFolder(workName, {}, signal)
  return { folderToken: folder.folder_token, url: folder.url }
}

/** 更新作品配置（只写提供的字段）。 */
export async function updateWorkConfig(
  baseToken: string,
  patch: Partial<{
    name: string
    genre: string
    subgenre: string
    scale: string
    targetWords: number
    mode: string
    pov: string
    currentChapter: number
  }>,
  // 内部调用（如 createWorkWikiRoot 写根节点）直接传字段，绕过 patch 的类型收窄
  options: { extraFields?: Record<string, CellValue> } = {},
  signal?: AbortSignal,
): Promise<{ recordId: string; updated: boolean }> {
  const fields: Record<string, CellValue> = { ...options.extraFields }
  if (patch.name !== undefined) fields[WORK_F.NAME] = patch.name
  if (patch.subgenre !== undefined) fields[WORK_F.SUBGENRE] = patch.subgenre
  if (patch.targetWords !== undefined) fields[WORK_F.TARGET_WORDS] = patch.targetWords
  if (patch.currentChapter !== undefined) fields[WORK_F.CURRENT_CHAPTER] = patch.currentChapter
  // 单选字段要传数组
  if (patch.genre !== undefined) fields[WORK_F.GENRE] = [patch.genre]
  if (patch.scale !== undefined) fields[WORK_F.SCALE] = [patch.scale]
  if (patch.mode !== undefined) fields[WORK_F.MODE] = [patch.mode]
  if (patch.pov !== undefined) fields[WORK_F.POV] = [patch.pov]

  if (Object.keys(fields).length === 0) {
    throw new Error('没有需要更新的字段。')
  }

  let recordId: string | undefined
  try {
    const rows = base.matrixToObjects(
      await base.listRecords(baseToken, '作品表', { fieldIds: [WORK_F.NAME], limit: 1 }, signal),
    )
    const id = rows[0]?.['__recordId']
    recordId = typeof id === 'string' ? id : undefined
  } catch {
    recordId = undefined
  }

  if (recordId !== undefined) {
    await base.updateRecords(baseToken, '作品表', { [recordId]: fields }, signal)
    return { recordId, updated: true }
  }

  const ids = await createRecordsWithSelfHeal(baseToken, '作品表', [fields], signal, () => {})
  const created = ids[0]
  if (created === undefined) throw new Error('作品配置创建失败：未返回 record_id')
  // 首条作品配置必须「返回即可读」：get_config 紧随 create 是高频路径
  // （实测不等待会读到空记录，name/subgenre 全空）。按 NAME 轮询确认。
  await awaitVisible(
    async () => {
      try {
        const rows = base.matrixToObjects(
          await base.listRecords(baseToken, '作品表', {
            fieldIds: [WORK_F.NAME], limit: 1,
          }, signal),
        )
        return rows[0]?.[WORK_F.NAME] === fields[WORK_F.NAME]
      } catch {
        return false
      }
    },
    signal,
    () => {},
  )
  return { recordId: created, updated: false }
}

const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const firstStr = (v: unknown): string =>
  Array.isArray(v) && typeof v[0] === 'string' ? v[0] : str(v)
