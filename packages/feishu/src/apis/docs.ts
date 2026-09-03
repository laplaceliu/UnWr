/**
 * 云文档 API（章节正文存储）。
 *
 * 需求阶段实测的关键行为：
 *   - `#`/`##` 在**真实换行**时正确转为 `<h1>`/`<h2>`（inline 传参会导致整章变一行）
 *   - 每个块有稳定 `block_id`，支持 `block_replace` 精确定位
 *   - `--scope keyword` 返回 `hit-block-ids`，可回溯原文
 *   - 每次编辑生成版本，`docs +history-list` 可追溯
 *
 * 安全策略：`overwrite` 一律不暴露（会丢弃无关富内容），
 * 只允许 append / str_replace / block_replace。
 *
 * @module @unwr/feishu/apis/docs
 */

import { runCli } from '../cli.ts'
import { withTempDir } from '../file-bridge.ts'

/** 文档读取的作用域。 */
export type DocScope = 'full' | 'outline' | 'range' | 'keyword' | 'section'

export interface FetchOptions {
  scope?: DocScope
  /** 输出格式。写入什么格式就要用什么格式读回 */
  docFormat?: 'xml' | 'markdown'
  detail?: 'simple' | 'with-ids' | 'full'
  /** keyword 作用域的检索词，支持 `|` 分隔的 OR 分支 */
  keyword?: string
  /** range/section 的起始块 */
  startBlockId?: string
  endBlockId?: string
  /** 上下文块数 */
  contextBefore?: number
  contextAfter?: number
}

/**
 * docs 域的响应比 base 域多一层 `data.document` 包裹。
 * 这是实测发现的结构差异——base 域的字段直接在 `data` 下，
 * 而 docs 域一律包在 `data.document` 内。
 */
interface DocEnvelope<T> {
  document: T
}

export interface FetchedDoc {
  content: string
  document_id: string
  revision_id?: number
}

/** 读取文档内容。 */
export async function fetchDoc(
  doc: string,
  options: FetchOptions = {},
  signal?: AbortSignal,
): Promise<FetchedDoc> {
  const args = ['docs', '+fetch', '--doc', doc, '--doc-format', options.docFormat ?? 'markdown']
  if (options.scope !== undefined) args.push('--scope', options.scope)
  if (options.detail !== undefined) args.push('--detail', options.detail)
  if (options.keyword !== undefined) args.push('--keyword', options.keyword)
  if (options.startBlockId !== undefined) args.push('--start-block-id', options.startBlockId)
  if (options.endBlockId !== undefined) args.push('--end-block-id', options.endBlockId)
  if (options.contextBefore !== undefined) args.push('--context-before', String(options.contextBefore))
  if (options.contextAfter !== undefined) args.push('--context-after', String(options.contextAfter))
  const res = await runCli<DocEnvelope<FetchedDoc>>(args, { signal })
  return res.document
}

export interface CreatedDoc {
  document_id: string
  revision_id: number
  url: string
}

/** 创建文档。正文**必须**走文件传参，否则换行丢失导致标题层级失效。 */
export async function createDoc(
  title: string,
  content: string,
  options: { parentToken?: string; docFormat?: 'xml' | 'markdown' } = {},
  signal?: AbortSignal,
): Promise<CreatedDoc> {
  return withTempDir(async (dir) => {
    const f = await dir.write('content.md', content)
    const args = ['docs', '+create',
      '--title', title,
      '--doc-format', options.docFormat ?? 'markdown',
      '--content', `@${f.relative}`]
    if (options.parentToken !== undefined) args.push('--parent-token', options.parentToken)
    const res = await runCli<DocEnvelope<CreatedDoc>>(args, { cwd: dir.cwd, signal })
    return res.document
  })
}

/** 文档更新命令。刻意不提供 overwrite。 */
export type UpdateCommand =
  | 'str_replace'
  | 'block_replace'
  | 'block_insert_after'
  | 'block_delete'
  | 'append'

export interface UpdateResult {
  revision_id: number
  url: string
  result: string
  warnings?: string[]
}

/**
 * `docs +update` 的响应结构与 fetch/create 不同：
 * `document` 与 `result`/`warnings` 是**平级**的，都在 `data` 下。
 */
interface UpdateEnvelope {
  document: { revision_id: number; url: string }
  result: string
  warnings?: string[]
}

/**
 * 归一化 update 响应的两种嵌套形状。
 *
 * **关键坑（实测）**：str_replace 无匹配时 CLI 返回 `ok:true` +
 * `result:"failed"` + warnings（degrade_code=1011）——HTTP 层是成功的！
 * 若只取 revision_id，上层会误以为改写成功。此处强制检查 result，
 * failed 一律抛错并携带 warnings 原文（内含 degrade_code 与原因）。
 */
function toUpdateResult(e: UpdateEnvelope): UpdateResult {
  if (e.result === 'failed') {
    const detail = (e.warnings ?? []).join('; ') || '无额外信息'
    throw new Error(`文档更新未生效（result=failed）：${detail}`)
  }
  return {
    revision_id: e.document.revision_id,
    url: e.document.url,
    result: e.result,
    ...e.warnings === undefined ? {} : { warnings: e.warnings },
  }
}

/** 追加内容到文档末尾（续写）。 */
export async function appendDoc(
  doc: string,
  content: string,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  return withTempDir(async (dir) => {
    const f = await dir.write('append.md', content)
    const res = await runCli<UpdateEnvelope>(
      ['docs', '+update', '--doc', doc,
        '--command', 'append',
        '--doc-format', 'markdown',
        '--content', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return toUpdateResult(res)
  })
}

/**
 * 局部精确替换（句/词级改稿）。
 *
 * 注意：`--pattern` 必须使用 Markdown **转义后**的形式才能匹配。
 * 从 `fetchDoc` 拿到的内容已带转义，可直接用作 pattern。
 */
export async function strReplace(
  doc: string,
  pattern: string,
  content: string,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  // content 走临时文件：与 blockReplace 一致，规避超长文本的 argv 风险
  return withTempDir(async (dir) => {
    const f = await dir.write('replace.md', content)
    const res = await runCli<UpdateEnvelope>(
      ['docs', '+update', '--doc', doc,
        '--command', 'str_replace',
        '--pattern', pattern,
        '--content', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return toUpdateResult(res)
  })
}

/**
 * 块定位目标：单个块 id，或**兄弟块区间**。
 *
 * 区间来自 lark-cli 的 `--start-block-id` / `--end-block-id`：
 *   "inclusive start block ID for a block_replace or block_delete sibling
 *    range; requires --end-block-id and cannot be combined with --block-id"
 * 端点**都包含**（inclusive）。
 *
 * 用途：把连续若干段落一次性替换/删除——例如「把第 2-4 段合并成一段」，
 * 原本需要 replace 首段 + delete 其余段两次调用，现在一次搞定。
 *
 * ⚠️ 区间内**所有**块都会被处理，包括段落之间的引用块、列表、图片等。
 * 缩窄区间前请确认中间没有想保留的内容。
 */
export type BlockTarget = string | BlockRange

/** 兄弟块区间（端点都包含）。 */
export interface BlockRange {
  startBlockId: string
  endBlockId: string
}

/**
 * 把块定位目标翻译成 CLI 参数。
 *
 * 单块用 `--block-id`，区间用 `--start-block-id` + `--end-block-id`。
 * CLI 明确禁止两者混用，也不允许只给一端，这里提前校验——比让 CLI
 * 回一个无细节的 exit code 1 好得多。
 */
function blockTargetArgs(target: BlockTarget): string[] {
  if (typeof target === 'string') {
    if (target === '') throw new Error('blockId 不能为空。')
    return ['--block-id', target]
  }
  if (target.startBlockId === '' || target.endBlockId === '') {
    throw new Error('块区间必须同时提供 startBlockId 与 endBlockId（两者皆包含）。')
  }
  if (target.startBlockId === target.endBlockId) {
    // 单块区间等价单块；CLI 上两者应该同义，但既然退化就用更稳的写法
    return ['--block-id', target.startBlockId]
  }
  return ['--start-block-id', target.startBlockId, '--end-block-id', target.endBlockId]
}

/**
 * 整块替换（段落/场景级改稿）。
 *
 * `target` 可为单个 blockId，或 `{startBlockId, endBlockId}` 兄弟块区间
 * （区间内所有块被整体替换，用于多段合一）。
 *
 * 注意：block_id 在结构变更后会失效，调用前应先 `fetchDoc({ detail: 'with-ids' })` 重新获取。
 */
export async function blockReplace(
  doc: string,
  target: BlockTarget,
  content: string,
  options: { docFormat?: 'xml' | 'markdown' } = {},
  signal?: AbortSignal,
): Promise<UpdateResult> {
  return withTempDir(async (dir) => {
    const f = await dir.write('block.md', content)
    const res = await runCli<UpdateEnvelope>(
      ['docs', '+update', '--doc', doc,
        '--command', 'block_replace',
        ...blockTargetArgs(target),
        '--doc-format', options.docFormat ?? 'markdown',
        '--content', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return toUpdateResult(res)
  })
}

/** 在指定块后插入内容（定点扩写）。 */
export async function blockInsertAfter(
  doc: string,
  blockId: string,
  content: string,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  return withTempDir(async (dir) => {
    const f = await dir.write('insert.md', content)
    const res = await runCli<UpdateEnvelope>(
      ['docs', '+update', '--doc', doc,
        '--command', 'block_insert_after',
        '--block-id', blockId,
        '--doc-format', 'markdown',
        '--content', `@${f.relative}`],
      { cwd: dir.cwd, signal },
    )
    return toUpdateResult(res)
  })
}

/**
 * 删除指定块（清理占位/空段落）。
 *
 * `target` 可为单个 blockId，或 `{startBlockId, endBlockId}` 兄弟块区间
 * （区间内所有块一并删除，用于批量清理占位段落）。
 *
 * 实证（lark-cli 1.0.92，2026-09-02）：`--command block_delete` **不需要**
 * `--content`，直接带 `--block-id` 即可成功（revision 递增，块物理消失）。
 * 注意：block_id 在结构变更后会失效，调用前应重新 `fetchDoc({ detail: 'with-ids' })`。
 */
export async function blockDelete(
  doc: string,
  target: BlockTarget,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  const res = await runCli<UpdateEnvelope>(
    ['docs', '+update', '--doc', doc,
      '--command', 'block_delete',
      ...blockTargetArgs(target)],
    { signal },
  )
  return toUpdateResult(res)
}

export interface DocHistoryEntry {
  edit_time: string
  editor_ids?: string[]
  history_version_id: string
  revision_id: number
  type?: number
}

/**
 * `--page-size` 的实际上限。
 * 实测：超过 20 会报 `invalid --page-size N: must be between 1 and 20`。
 */
export const MAX_HISTORY_PAGE_SIZE = 20

/** 列出文档版本历史（改稿留痕）。 */
export function listDocHistory(
  doc: string,
  pageSize = MAX_HISTORY_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<{ entries: DocHistoryEntry[] }> {
  const size = Math.min(Math.max(1, Math.trunc(pageSize)), MAX_HISTORY_PAGE_SIZE)
  return runCli(
    ['docs', '+history-list', '--doc', doc, '--page-size', String(size)],
    { signal },
  )
}

/**
 * 检索文档中的关键词，返回命中块。
 * 支撑一致性检查时的原文回溯（分层记忆 L4）。
 */
export function searchInDoc(
  doc: string,
  keyword: string,
  signal?: AbortSignal,
): Promise<FetchedDoc> {
  return fetchDoc(doc, { scope: 'keyword', keyword, docFormat: 'markdown' }, signal)
}
