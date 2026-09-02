/**
 * 章节领域服务。
 *
 * 把「新建一章」这个业务动作编排为多次飞书调用：
 *   1. 校验章节号（查重 / 自动递增）
 *   2. 规范化正文（剥离 h1——章标题由文档标题承担）
 *   3. 创建正文文档
 *   4. 写入章节索引记录
 *   5. 可选：创建 Wiki 目录节点并回填 URL
 *
 * 与飞书 CLI 无关的业务规则都在这里，可单测、可 mock。
 *
 * @module @unwr/novel/domain/chapter
 */

import { base, docs, wiki } from '@unwr/feishu'
import {
  CHAPTER_F, CHAPTER_STATUS, TABLE,
} from '@unwr/schema'
import type { ChapterStatus } from '@unwr/schema'
import type { CellValue } from '@unwr/feishu'
import { extractDocToken } from '../context/builder.ts'
import { resolveChapterMount, findVolumeRecordId, rememberChapterRecordId } from './organize.ts'
import { createRecordsWithSelfHeal, updateRecordsWithSelfHeal } from './selfheal.ts'

/**
 * 待写入的字段集合。
 * 刻意用可变版本：`RecordFields` 是 Readonly，无法逐字段赋值。
 */
type MutableFields = Record<string, CellValue>

/** 写章节的入参。 */
export interface WriteChapterParams {
  /** 章节号。省略时自动取「当前最大章节号 + 1」 */
  chapterNo?: number
  /** 章标题，同时作为飞书文档标题 */
  title: string
  /** 正文 Markdown。章内用 ## 划分场景 */
  content: string
  /** 所属卷名 */
  volume?: string
  /** 初始状态，默认「草稿」 */
  status?: ChapterStatus
  /** 大纲要点 */
  outline?: string
  /** 故事内时间 */
  storyTime?: string
}

/** 写章节的可选动作。 */
export interface WriteChapterOptions {
  /** 创建 Wiki 节点所需的空间 ID */
  spaceId?: string
  /** 创建 Wiki 节点所需的父节点（通常是卷节点） */
  parentNodeToken?: string
}

/** 写章节的结果。 */
export interface WriteChapterResult {
  /** 实际使用的章节号 */
  chapterNo: number
  title: string
  /** 正文文档 ID */
  documentId: string
  documentUrl: string
  /** 章节表记录 ID */
  recordId: string
  /** 正文字数 */
  words: number
  /** Wiki 节点（仅在提供了 spaceId/parentNodeToken 时创建） */
  wikiNodeToken?: string
  /** 非致命提示，例如自动修正了正文格式 */
  warnings: string[]
}

/**
 * 统计中文字数。
 *
 * 先剥离 Markdown 标记与空白，再数字符。
 * 中文场景字符数即字数（英文按词计会更准，但小说以中文为主）。
 */
export function countWords(markdown: string): number {
  const plain = markdown
    // 去掉代码块
    .replace(/```[\s\S]*?```/g, '')
    // 去掉标题标记
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // 去掉引用标记
    .replace(/^\s{0,3}>\s?/gm, '')
    // 去掉列表标记
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    // 去掉行内标记：粗体/斜体/删除线/行内代码
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    // 去掉图片与链接，保留文字
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 合并空白
    .replace(/\s+/g, '')
  return plain.length
}

/**
 * 规范化正文。
 *
 * 约定（技术选型阶段实测）：**章标题由飞书文档标题承担，正文只用 `##` 做场景分节**。
 * 若模型传入的正文首行写了 `# 章标题`，CLI 会用 --title 覆盖它导致层级丢失，
 * 因此这里主动剥离首行 h1，并在 warnings 中说明。
 */
export function normalizeContent(content: string): { content: string; warnings: string[] } {
  const warnings: string[] = []
  const trimmed = content.replace(/^\s+/, '')

  // 剥离首行 h1
  const h1Match = /^#\s+(.+)$/m.exec(trimmed)
  if (h1Match !== null && h1Match.index === 0) {
    warnings.push(`已剥离正文首行的 h1 标题「${(h1Match[1] ?? '').trim()}」：章标题由 title 参数承担，正文应只用 ## 划分场景。`)
    const stripped = trimmed.slice(h1Match[0].length).replace(/^\s*\n/, '')
    return { content: stripped, warnings }
  }

  // 正文完全没有任何 ## 分节时给出提示（不强制，短章节可能就一段）
  if (!/^\s{0,3}##\s+/m.test(trimmed)) {
    warnings.push('正文未使用 ## 划分场景分节；长章节建议分节，便于后续按块改写与导航。')
  }

  return { content: trimmed, warnings }
}

/** 查询当前最大章节号；无记录时返回 0。 */
export async function maxChapterNo(
  baseToken: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const rows = base.matrixToObjects(
      await base.listAllRecords(baseToken, TABLE.CHAPTER, {
        fieldIds: [CHAPTER_F.NO],
      }, signal),
    )
    let max = 0
    for (const r of rows) {
      const n = r[CHAPTER_F.NO]
      if (typeof n === 'number' && n > max) max = n
    }
    return max
  } catch {
    // 章节表不存在或查询失败：按 0 处理，交给后续创建流程报错
    return 0
  }
}

/**
 * 按章节号查找已有记录 ID；不存在返回 undefined。
 *
 * **查询失败会抛错**（而不是返回 undefined）。
 * 曾经这里用 `catch { return undefined }` 吞掉所有错误，
 * 后果是：查询一旦失败（限流、字段不匹配、表不存在），
 * 冲突检测就会误判为"无冲突"，于是重复创建同一章节号——
 * 数据污染且极难排查。宁可让调用失败，也不能静默放行。
 */
export async function findChapterRecord(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.NO, CHAPTER_F.TITLE],
      filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
      limit: 1,
    }, signal),
  )
  const id = rows[0]?.['__recordId']
  return typeof id === 'string' ? id : undefined
}

/**
 * 读取某章的关键字段（含 DOC_URL）。
 *
 * 用途：writeChapter 在「章节已存在」分支判断是 shell 还是已写正文。
 */
async function readChapterShellFields(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<{ docUrl: string | undefined }> {
  const rows = base.matrixToObjects(
    await base.listRecords(baseToken, TABLE.CHAPTER, {
      fieldIds: [CHAPTER_F.NO, CHAPTER_F.DOC_URL],
      filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
      limit: 1,
    }, signal),
  )
  const row = rows[0]
  const url = row?.[CHAPTER_F.DOC_URL]
  return { docUrl: typeof url === 'string' && url !== '' ? url : undefined }
}

/**
 * 为已存在的章节壳填充正文。
 *
 * 触发场景：`setChapterOutline`（entity.ts）自动建章后，章节壳有 TITLE=`第 N 章` /
 * OUTLINE / STORY_TIME / VOLUME 等元数据，但 NO DOC_URL。
 *
 * 行为：复用同一记录创建正文文档，回填 DOC_URL / WORDS / STATUS / TITLE；
 * TITLE 总是用 params.title 覆盖（占位 title 无意义）；
 * OUTLINE / STORY_TIME / VOLUME 仅在用户显式提供时覆盖——保留大纲官预填的内容。
 *
 * 若章节已有关联文档，抛错（应走 append/revise，不要重复建文档）。
 */
async function fillChapterShell(
  baseToken: string,
  chapterNo: number,
  recordId: string,
  params: WriteChapterParams,
  normalizedContent: string,
  words: number,
  baseWarnings: string[],
  _options: WriteChapterOptions,
  signal?: AbortSignal,
): Promise<WriteChapterResult> {
  const warnings = [...baseWarnings]

  // 1. 已有正文？→ 不属于「壳」场景，抛错让用户改走 append/revise
  const { docUrl: existingDocUrl } = await readChapterShellFields(baseToken, chapterNo, signal)
  if (existingDocUrl !== undefined) {
    throw new Error(
      `第 ${chapterNo} 章已存在且已有关联正文文档（记录 ${recordId}，文档 ${existingDocUrl}）。`
      + '若要续写请用 novel_append_chapter，若要改写请用 novel_revise_chapter。',
    )
  }

  // 2. 定位正文应挂载的父文件夹（卷文件夹 → 作品根文件夹）
  const mount = await resolveChapterMount(baseToken, {
    ...params.volume === undefined ? {} : { volume: params.volume },
  }, signal)
  warnings.push(...mount.warnings)

  // 3. 创建正文文档（与 writeChapter 新建路径同源）
  let doc: Awaited<ReturnType<typeof docs.createDoc>>
  try {
    doc = await docs.createDoc(
      params.title,
      normalizedContent,
      mount.parentToken === undefined ? {} : { parentToken: mount.parentToken },
      signal,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/parent.*(not found|not exist)|not.*exist.*parent/i.test(msg) || mount.parentToken === undefined) throw e
    warnings.push('作品目录已失效（可能被删除），本次正文落在「我的文档」根目录。'
      + '请重新执行 novel_manage_work(action=link_folder) 修复目录。')
    doc = await docs.createDoc(params.title, normalizedContent, {}, signal)
  }
  if (mount.parentToken === undefined) {
    warnings.push('作品未挂接文档目录，正文已创建在「我的文档」根目录。'
      + '可用 novel_manage_work(action=link_folder) 为作品创建目录，此后正文自动归位。')
  }

  // 4. 回填章节记录。
  //    TITLE 总是覆盖（占位 `第 N 章` 无意义），WORDS/STATUS/DOC_URL 必定写入；
  //    OUTLINE/STORY_TIME/VOLUME 仅在用户提供时覆盖（保留 setChapterOutline 的预填值）。
  const fields: MutableFields = {
    [CHAPTER_F.TITLE]: params.title,
    [CHAPTER_F.WORDS]: words,
    [CHAPTER_F.STATUS]: [params.status ?? CHAPTER_STATUS.DRAFT],
    [CHAPTER_F.DOC_URL]: doc.url,
    [CHAPTER_F.UPDATED_AT]: Date.now(),
  }
  if (params.outline !== undefined) fields[CHAPTER_F.OUTLINE] = params.outline
  if (params.storyTime !== undefined) fields[CHAPTER_F.STORY_TIME] = params.storyTime

  await updateRecordsWithSelfHeal(
    baseToken, TABLE.CHAPTER, { [recordId]: fields }, signal,
    (msg) => { warnings.push(msg) },
  )

  // 5. 「所属卷」link：用户显式提供 volume 且卷记录可用则回填；否则不动原值
  if (params.volume !== undefined) {
    const volumeRecordId = mount.volumeRecordId
    if (volumeRecordId !== undefined) {
      const visible = await awaitVisible(
        async () => (await findVolumeRecordId(baseToken, params.volume!, signal)) === volumeRecordId,
        signal,
        () => {},
      )
      if (visible) {
        await updateRecordsWithSelfHeal(
          baseToken, TABLE.CHAPTER,
          { [recordId]: { [CHAPTER_F.VOLUME]: [{ id: volumeRecordId }] } },
          signal,
          (msg) => { warnings.push(msg) },
        )
      } else {
        warnings.push(`「${params.volume}」的卷记录迟迟不可见，「所属卷」未关联。`)
      }
    } else {
      warnings.push(`「${params.volume}」的卷记录不可用，「所属卷」未关联。`)
    }
  }

  // 6. 让紧随其后的 revise/append 命中缓存（章节号缓存 TTL=60s 解决 bitable
  //    link 收敛延迟 ~6s+ 的问题，见 selfheal.ts:52080412）
  rememberChapterRecordId(baseToken, chapterNo, recordId)

  return {
    chapterNo,
    title: params.title,
    documentId: doc.document_id,
    documentUrl: doc.url,
    recordId,
    words,
    warnings,
  }
}

/**
 * 新建一章，或为已建好的章壳填充正文。
 *
 * 两种入口都走本函数：
 *   - 章节号未占用 → 新建文档 + 写入章节索引（old path）
 *   - 章节号已占用但尚无正文文档 → 视为「填充正文」，复用同一条记录
 *     创建文档并回填 docUrl/words/status（fillChapterShell）
 *   - 章节号已占用且已有正文文档 → 拒绝（应走 append/revise）
 *
 * 为什么需要第二种入口：`setChapterOutline`（entity.ts）会自动建章壳，
 * 壳里有 TITLE=`第 N 章` / OUTLINE / STORY_TIME / VOLUME 等元数据但 NO DOC_URL。
 * 此前 append/revise/read 都因无 DOC_URL 拒绝，writeChapter 又因"章已存在"
 * 拒绝——形成死锁（2026-09-02 实机复现：novel_write_chapter → 章节已存在；
 * novel_append_chapter / novel_read_chapter / novel_revise_chapter → 无 DOC_URL）。
 * 本函数打破之：让 writeChapter 在「壳」场景下也能创建文档。
 */
export async function writeChapter(
  baseToken: string,
  params: WriteChapterParams,
  options: WriteChapterOptions = {},
  signal?: AbortSignal,
): Promise<WriteChapterResult> {
  const { content: normalized, warnings } = normalizeContent(params.content)
  const words = countWords(normalized)

  // 1. 确定章节号
  const chapterNo = params.chapterNo ?? (await maxChapterNo(baseToken, signal)) + 1
  const existing = await findChapterRecord(baseToken, chapterNo, signal)
  if (existing !== undefined) {
    return await fillChapterShell(
      baseToken, chapterNo, existing, params, normalized, words, warnings, options, signal,
    )
  }

  // 2. 定位正文应挂载的父文件夹（多作品组织的关键，见 organize.ts 的说明）
  const mount = await resolveChapterMount(baseToken, {
    ...params.volume === undefined ? {} : { volume: params.volume },
  }, signal)
  warnings.push(...mount.warnings)

  // 3. 创建正文文档（章标题由 --title 承担，正文放进所属卷文件夹或作品根文件夹）
  let doc: Awaited<ReturnType<typeof docs.createDoc>>
  try {
    doc = await docs.createDoc(
      params.title,
      normalized,
      mount.parentToken === undefined ? {} : { parentToken: mount.parentToken },
      signal,
    )
  } catch (e) {
    // 目录可能已被删除（用户清理云盘），而作品表里还存着失效 URL。
    // 降级为根目录创建，绝不因组织结构问题阻断写作。
    const msg = e instanceof Error ? e.message : String(e)
    if (!/parent.*(not found|not exist)|not.*exist.*parent/i.test(msg) || mount.parentToken === undefined) throw e
    warnings.push('作品目录已失效（可能被删除），本次正文落在「我的文档」根目录。'
      + '请重新执行 novel_manage_work(action=link_folder) 修复目录。')
    doc = await docs.createDoc(params.title, normalized, {}, signal)
  }
  if (mount.parentToken === undefined) {
    warnings.push('作品未挂接文档目录，正文已创建在「我的文档」根目录。'
      + '可用 novel_manage_work(action=link_folder) 为作品创建目录，此后正文自动归位。')
  }

  // 4. 写入章节索引
  const fields: MutableFields = {
    [CHAPTER_F.TITLE]: params.title,
    [CHAPTER_F.NO]: chapterNo,
    [CHAPTER_F.WORDS]: words,
    [CHAPTER_F.STATUS]: [params.status ?? CHAPTER_STATUS.DRAFT],
    [CHAPTER_F.DOC_URL]: doc.url,
  }
  // 「所属卷」是 link 字段：必须传 [{id}] 关联格式。
  // **不能在首次 createRecords 时写入**：卷记录可能也是刚创建的（本流程
  // 自动建卷的场景），而 link 指向的**目标记录**同样有可见性延迟——
  // 目标不可见时报 not_found。因此先建章节、等卷记录可见后再回填 link。
  const pendingVolumeLink =
    mount.volumeRecordId !== undefined && params.volume !== undefined
      ? { volume: params.volume, recordId: mount.volumeRecordId }
      : undefined
  if (pendingVolumeLink === undefined && params.volume !== undefined) {
    warnings.push(`「${params.volume}」的卷记录不可用，「所属卷」未关联。`)
  }
  if (params.outline !== undefined) fields[CHAPTER_F.OUTLINE] = params.outline
  if (params.storyTime !== undefined) fields[CHAPTER_F.STORY_TIME] = params.storyTime

  // 写入章节索引。
  // 自愈：新库的 link 字段（所属卷/出场人物/关联伏笔）可能仍在平台侧
  // 收敛中（实测分钟级），写入会报 800030201 not_found。此时跑一次
  // initWork 幂等补齐缺失字段后重试，让用户无感。
  const recordIds = await createRecordsWithSelfHeal(
    baseToken, TABLE.CHAPTER, [fields], signal,
    (msg) => { warnings.push(msg) },
  )
  const recordId = recordIds[0]
  if (recordId === undefined) {
    throw new Error('章节记录创建失败：未返回 record_id')
  }
  // 种写后缓存：紧随其后的 revise/append/query 要能立刻找到这章
  //（列表索引有 ~6s 延迟，见 entity.ts findChapterRecordId）
  rememberChapterRecordId(baseToken, chapterNo, recordId)

  // 回填「所属卷」link（等卷记录可见后）
  if (pendingVolumeLink !== undefined) {
    const linked = await awaitVisible(
      async () =>
        (await findVolumeRecordId(baseToken, pendingVolumeLink.volume, signal))
        === pendingVolumeLink.recordId,
      signal,
      () => {},
    )
    if (linked) {
      await updateRecordsWithSelfHeal(
        baseToken,
        TABLE.CHAPTER,
        { [recordId]: { [CHAPTER_F.VOLUME]: [{ id: pendingVolumeLink.recordId }] } },
        signal,
      )
    } else {
      warnings.push(`「${pendingVolumeLink.volume}」的卷记录迟迟不可见，「所属卷」未关联。`)
    }
  }

  // 等待记录可被查询命中，再做后续操作。
  // 见 awaitVisible 的注释：飞书 Base 有约 1 秒的写入索引延迟。
  await awaitVisible(
    async () => (await findChapterRecord(baseToken, chapterNo, signal)) === recordId,
    signal,
    (msg) => { warnings.push(msg) },
  )

  return {
    chapterNo,
    title: params.title,
    documentId: doc.document_id,
    documentUrl: doc.url,
    recordId,
    words,
    warnings,
  }
}

/**
 * 等待「写入的记录可被查询命中」。
 *
 * **实测存在的坑**：飞书 Base 写入后有约 1 秒的索引延迟
 * （27 条记录时实测：t+668ms 未命中，t+1675ms 命中）。
 *
 * 后果很严重：写入后立刻做「存在性检测」（如 upsert 查重、章节号冲突检测），
 * 会查不到刚写的记录，误判为"不存在"，于是重复创建——数据污染且难排查。
 *
 * 因此任何「写后马上要按字段查」的场景都应调用本函数兜底。
 * 超时不抛错（记录其实已创建成功），通过返回值 false 告知调用方。
 *
 * @param check 谓词：返回 true 表示记录已可查询命中
 */
export async function awaitVisible(
  check: () => Promise<boolean>,
  signal: AbortSignal | undefined,
  onTimeout: (message: string) => void,
  timeoutMs = 6000,
): Promise<boolean> {
  const started = Date.now()
  const delays = [0, 300, 500, 800, 1000, 1500]

  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    if (Date.now() - started > timeoutMs) break
    try {
      if (await check()) return true
    } catch {
      // 查询失败继续重试，不放弃
    }
  }

  onTimeout(
    `记录已写入但索引尚未生效（等待 ${Date.now() - started}ms 仍查不到），`
    + '短时间内按字段查询可能检测不到它。',
  )
  return false
}

/** 读取一章正文。 */
export async function readChapter(
  docTokenOrUrl: string,
  options: { docFormat?: 'markdown' | 'xml'; withIds?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ content: string; documentId: string }> {
  const token = extractDocToken(docTokenOrUrl) ?? docTokenOrUrl
  const doc = await docs.fetchDoc(
    token,
    {
      docFormat: options.docFormat ?? 'markdown',
      ...options.withIds === true ? { detail: 'with-ids' as const } : {},
    },
    signal,
  )
  return { content: doc.content, documentId: doc.document_id }
}
