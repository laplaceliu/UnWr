/**
 * 改稿领域服务。
 *
 * 定位策略（三选一，优先级从高到低）：
 *
 *   1. `blockId`  —— 已知道确切块 id，直接操作（最快，但 id 会失效）
 *   2. `scene`    —— 按 `## ` 场景标题定位整个场景（**推荐**，语义稳定）
 *   3. `match`    —— 精确文本匹配（句/词级改动）
 *
 * 为什么把 `scene` 作为推荐方式：block_id 在文档结构变化后会失效，
 * 而场景标题是内容本身的一部分，稳定且对模型友好——模型知道"改第二场"
 * 比知道"改 doxcnXXX 这个块"自然得多。
 *
 * 改稿动作：
 *   replace 整块替换（改写 / 缩写 / 视角切换 / 人称切换 / 文风切换）
 *   expand  在指定位置后插入（扩写）
 *   patch   精确文本替换（润色）
 *   delete  删除整块（清理占位块/空段落；无需 content）
 *
 * @module @unwr/novel/domain/revision
 */

import { docs, type BlockTarget } from '@unwr/feishu'
import { findChapterRecord } from './chapter.ts'
import { extractDocToken } from '../context/builder.ts'
import { countWords } from './chapter.ts'

/** 定位方式。 */
export interface ReviseTarget {
  /** 直接指定块 id（需先 fetchDoc with-ids 获取） */
  blockId?: string
  /**
   * 场景标题，如「二、交锋」或「交锋」。
   * 会在 `## ` 标题中做包含匹配。
   */
  scene?: string
  /**
   * 场景内段落序号（1-based，按正文段落计，不含场景标题）。
   * 与 scene 搭配实现**结构化定位**——最佳实践：比逐字 match 稳定，
   * 模型无需复制原文。paragraph=0 表示「场景标题块本身」。
   */
  paragraph?: number
  /**
   * 区间起点段序号（1-based，含）。与 endParagraph 搭配，
   * 一次替换/删除连续多段——「把第 2-4 段合并成一段」这类需求
   * 原本要 replace + 多次 delete，现在一次调用即可。
   */
  startParagraph?: number
  /** 区间终点段序号（1-based，含）。必须与 startParagraph 同时给出。 */
  endParagraph?: number
  /**
   * 区间起点块 id（含）。lark-cli 的 `--start-block-id`，**必须**与
   * endBlockId 配对，且不能与 blockId 混用。
   */
  startBlockId?: string
  /** 区间终点块 id（含）。lark-cli 的 `--end-block-id`。 */
  endBlockId?: string
  /** 要替换的原文片段（patch 模式必填；replace 模式下用于校验） */
  match?: string
}

/** 改稿动作。 */
export type ReviseAction = 'replace' | 'expand' | 'patch' | 'delete'

/** 改稿入参。 */
export interface ReviseParams {
  /**
   * 新内容。replace 时为整块新文本，patch 时为替换后的文本，expand 时为插入文本。
   * delete 动作不需要 content（实机教训 2026-09-02：模型清理占位块时传
   * content:"" 连续被拒 12 次——删除就该有自己的动作，而不是靠空格Hack）。
   */
  content?: string
  action: ReviseAction
  target: ReviseTarget
  /** 目标字数（用于回写字数统计） */
  updateWordCount?: boolean
}

/** 改稿结果。 */
export interface ReviseResult {
  /** 实际采用的定位方式 */
  locatedBy: 'blockId' | 'scene' | 'paragraph' | 'range' | 'match'
  /** 命中的块 id（区间定位时为**起始**块 id） */
  blockId: string
  /** 场景标题（若按场景定位） */
  sceneTitle?: string
  /** 命中的段落在场景内的序号（若按单段落定位） */
  paragraphIndex?: number
  /** 命中的段落区间（若按区间定位，两端都包含） */
  paragraphRange?: { from: number; to: number }
  /** 变更前后的字数差 */
  wordDelta: number
  /** 文档新版本号 */
  revisionId: number
  documentId: string
  warnings: string[]
}

/** 定位失败——目标不存在。 */
export class LocateError extends Error {
  constructor(message: string, readonly candidates: string[]) {
    super(message)
    this.name = 'LocateError'
  }
}

/** 从章节表取正文文档 token。 */
export async function resolveChapterDoc(
  baseToken: string,
  chapterNo: number,
  signal?: AbortSignal,
): Promise<{ docToken: string; docUrl: string }> {
  const { base } = await import('@unwr/feishu')
  const { CHAPTER_F, TABLE } = await import('@unwr/schema')

  // findChapterRecord 只判断存在性，这里还需要正文链接
  let rows: Record<string, unknown>[]
  try {
    rows = base.matrixToObjects(
      await base.listRecords(baseToken, TABLE.CHAPTER, {
        fieldIds: [CHAPTER_F.NO, CHAPTER_F.DOC_URL],
        filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
        limit: 1,
      }, signal),
    )
  } catch (e) {
    // 实测：模型会抄错 workToken（…Lhnzf 抄成 …Llnzf），Base 域报 NOTEXIST。
    // 给出能自我纠正的提示，而不是裸的 NOTEXIST。
    throw new Error(
      `读取章节表失败（${e instanceof Error ? e.message : String(e)}）。`
      + '常见原因是 workToken 抄写错误——请用 novel_manage_work(action=list) 核对正确的 base_token。',
      { cause: e },
    )
  }
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`第 ${chapterNo} 章不存在，无法改稿。`)
  }
  const docUrl = row[CHAPTER_F.DOC_URL]
  if (typeof docUrl !== 'string' || docUrl === '') {
    throw new Error(
      `第 ${chapterNo} 章没有正文文档（章节壳可能仅含大纲）。`
      + '请先用 novel_write_chapter 写入正文，再来改稿。',
    )
  }
  const token = extractDocToken(docUrl)
  if (token === undefined) {
    throw new Error(`无法从「${docUrl}」解析文档 token。`)
  }
  return { docToken: token, docUrl }
}

/**
 * 列出文档中的场景（h2 标题）。
 *
 * 用于：按场景定位前的探查，以及定位失败时给出候选项。
 */
export async function listScenes(
  docToken: string,
  signal?: AbortSignal,
): Promise<{ title: string; blockId: string }[]> {
  const doc = await docs.fetchDoc(
    docToken,
    { scope: 'outline', docFormat: 'xml' },
    signal,
  )
  // outline 形如：
  //   <outline><h1 id="doxcnA">第一章</h1><h2 id="doxcnB">一、入城</h2>...</outline>
  const scenes: { title: string; blockId: string }[] = []
  const re = /<h([1-6])\s+id="([^"]+)">([\s\S]*?)<\/h\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(doc.content)) !== null) {
    scenes.push({
      title: stripTags(m[3] ?? '').trim(),
      blockId: m[2] ?? '',
    })
  }
  return scenes.filter((s) => s.blockId !== '')
}

/** 去掉 outline 里的内联标签。 */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

/**
 * 按场景标题定位块 id。
 *
 * 匹配规则：先精确相等，再包含匹配。都失败则抛 LocateError 并列出候选。
 */
export async function locateByScene(
  docToken: string,
  scene: string,
  signal?: AbortSignal,
): Promise<{ blockId: string; sceneTitle: string }> {
  const scenes = await listScenes(docToken, signal)
  if (scenes.length === 0) {
    throw new LocateError(
      '该文档没有使用 ## 划分场景，无法按场景定位。请改用 match（精确文本）或 blockId 定位。',
      [],
    )
  }

  const needle = scene.replace(/^#+\s*/, '').trim()

  // 1. 精确匹配
  const exact = scenes.find((s) => s.title === needle)
  if (exact !== undefined) return { blockId: exact.blockId, sceneTitle: exact.title }

  // 2. 去掉序号后匹配（「二、交锋」→「交锋」）
  const normalized = needle.replace(/^[\d一二三四五六七八九十]+[、.．]\s*/, '')
  const byNormalized = scenes.find(
    (s) => s.title === normalized
      || s.title.replace(/^[\d一二三四五六七八九十]+[、.．]\s*/, '') === normalized,
  )
  if (byNormalized !== undefined) {
    return { blockId: byNormalized.blockId, sceneTitle: byNormalized.title }
  }

  // 3. 包含匹配
  const contains = scenes.find((s) => s.title.includes(needle) || needle.includes(s.title))
  if (contains !== undefined) {
    return { blockId: contains.blockId, sceneTitle: contains.title }
  }

  throw new LocateError(
    `未找到场景「${scene}」。`,
    scenes.map((s) => s.title),
  )
}

/**
 * 列出场景内的段落（结构化定位的基础）。
 *
 * 返回场景标题块 + 场景内全部正文段落（1-based 序号 → block id + 文本）。
 * 「结构化定位」用它把「第 N 段」翻译成 block id——比逐字 match 稳定：
 * 模型不需要复制原文，只需要说「改第二场的第 3 段」。
 */
export async function getSceneParagraphs(
  docToken: string,
  scene: string,
  signal?: AbortSignal,
): Promise<{
  sceneBlockId: string
  sceneTitle: string
  /** key = 1-based 段落序号 */
  paragraphs: { index: number; blockId: string; text: string }[]
}> {
  const located = await locateByScene(docToken, scene, signal)

  // 取全文（带块 id 的 XML），收集该 h2 之后、下一个 heading 之前的 <p> 块
  const doc = await docs.fetchDoc(docToken, { detail: 'with-ids', docFormat: 'xml' }, signal)
  const xml = doc.content

  // 定位场景标题块的位置
  const headingRe = new RegExp(
    `<h[1-6]\\s+id="(${located.blockId})"[^>]*>[\\s\\S]*?</h[1-6]>`,
  )
  const hm = headingRe.exec(xml)
  if (hm === null) throw new LocateError(`未在文档结构中找到场景「${located.sceneTitle}」的标题块。`, [])

  const rest = xml.slice((hm.index ?? 0) + hm[0].length)
  // 场景边界：下一个任意级标题
  const nextHeading = /<h[1-6]\s+id="[^"]+"/.exec(rest)
  const scope = nextHeading === null ? rest : rest.slice(0, (nextHeading.index ?? 0))

  const paragraphs: { index: number; blockId: string; text: string }[] = []
  const pRe = /<p\s+id="(doxcn[^"]+)"[^>]*>([\s\S]*?)<\/p>/g
  let m: RegExpExecArray | null
  while ((m = pRe.exec(scope)) !== null) {
    const text = stripTags(m[2] ?? '').trim()
    if (text === '') continue
    paragraphs.push({ index: paragraphs.length + 1, blockId: m[1] ?? '', text })
  }

  return { sceneBlockId: located.blockId, sceneTitle: located.sceneTitle, paragraphs }
}

/** 读取文档当前正文字数（用于计算 delta）。 */
async function currentWords(
  docToken: string,
  signal?: AbortSignal,
): Promise<number> {
  const doc = await docs.fetchDoc(docToken, { docFormat: 'markdown' }, signal)
  return countWords(doc.content)
}

/**
 * 把 patch 阶段的失败装饰为可被模型/调用方直接决策的错误。
 *
 * 实测高失败率：patch（精确文本替换）的 match 即使预检通过了，
 * lark-cli 仍可能因 markdown 转义差异、空格不可见字符差异、版本号 race
 * 报 degrade_code=1011（fatal:MatchFailure）。这时再 retry 同参数无意义。
 * 给 agent 一个清晰的下一步：别再用 patch，改用结构化定位（replace + scene + paragraph）。
 *
 * 也兼容「match 在预检里就直接不存在」之外的二次失败场景，
 * 抛出后模型读取这条消息即可自我归因。
 */
export function enrichPatchError(e: Error): Error {
  const detail = e.message
  return new Error(
    `patch 失败：${detail}`
    + '\n→ patch 对匹配文本过敏感（任何空白/标点差异都拒改），与其继续重试，'
    + '不如先 novel_list_scenes 取场景列表，然后改用 action=replace + scene + paragraph'
    + '（结构化定位，不依赖 match 逐字符匹配）；'
    + '要一次改连续多段则用 scene + startParagraph/endParagraph。'
    + '\n→ 若仍要继续 patch：请先 novel_read_chapter 拿到当前段落原文，逐字符比对 '
    + '（特别注意全角/半角、空格、换行符、引号），再用新 match 重试。',
    { cause: e },
  )
}

/**
 * 执行改稿。
 *
 * 所有动作都会在飞书留下版本，可用 `docs +history-list` 回溯。
 */
export async function reviseChapter(
  baseToken: string,
  chapterNo: number,
  params: ReviseParams,
  signal?: AbortSignal,
): Promise<ReviseResult> {
  // 入参校验：空 content 曾一路透传到 CLI，报出晦涩的
  // "block_replace requires --content"（实测一个会话里连踩 3 次）。
  // delete 不需要 content；其余动作空 content 直接拦截并指向正确动作。
  if (params.action === 'delete') {
    if (params.content !== undefined && params.content.trim() !== '') {
      throw new Error('delete 动作不接受 content——它删除的是整个块。若想替换块内容，请用 action=replace。')
    }
  } else if (params.content === undefined || params.content.trim() === '') {
    throw new Error(
      'content 不能为空——replace 需要整块新文本，patch 需要替换后的文本，expand 需要插入文本。'
      + '若你其实想删掉这一块（如清理占位段落），请改用 action=delete（不需要 content）。',
    )
  }
  if (params.action === 'patch' && (params.target.match === undefined || params.target.match.trim() === '')) {
    throw new Error('patch 需要 match（正文中要被替换的精确连续文本）。')
  }
  // 实测高频错误：模型把换行写成字面 \n（两个字符）。真实正文里是
  // 换行字符，永远匹配不上。提前拦截并解释，避免一轮 CLI 往返。
  const literalBackslashN = String.fromCharCode(92) + 'n'
  if (params.target.match !== undefined && params.target.match.includes(literalBackslashN)) {
    const hint = [
      'match 里包含字面反斜杠+n（两个字符）。',
      '正文中换行就是换行字符本身，请直接用真实换行，',
      '且 match 必须与 novel_read_chapter 返回的文本逐字符一致。',
    ].join('')
    throw new Error(hint)
  }
  // ★ 跨块守卫（实机踩坑 2026-09-03，本轮报错的直接原因）：
  //   lark-cli 对 str_replace 的 --pattern 的契约是
  //     "simple inline text matched by str_replace; use block_replace for
  //      paragraphs, multiline content, or multiple blocks"
  //   即 **只匹配块内连续文本**，跨段落/多行一律要走 block_replace。
  //
  //   而下面的失配预检比的是 **markdown 渲染**（段落间恰好是 \n\n），
  //   于是跨段落的 match 能"通过"预检 → 到 CLI 侧必然匹配不上 → 只回
  //   一个毫无细节的 "cli failed with exit code 1"。预检给了虚假信心，
  //   模型会以为 match 没问题而反复重试（实测重试 7 次都是同一个错）。
  //
  //   放在 I/O 之前（resolveChapterDoc + currentWords = 3 次 CLI 往返
  //   都在后面），零网络开销拦下并给出可执行的下一步。
  if (params.action === 'patch' && params.target.match !== undefined) {
    const matchLf = params.target.match.replace(/\r\n/g, '\n')
    if (matchLf.includes('\n')) {
      const acrossParagraphs = matchLf.includes('\n\n')
      throw new Error(
        `match ${acrossParagraphs ? '跨段落（含空行）' : '跨行（含换行符）'}，`
        + '但 str_replace 的 --pattern 只匹配**块内连续文本**'
        + '（lark-cli：use block_replace for paragraphs, multiline content, or multiple blocks）。'
        + '这类 match 在 markdown 预检里看起来存在，实际永远匹配不上——'
        + '所以**不要**再去逐字符校对重试，换定位方式才是正解。'
        + '\n→ 只改一句：把 match 缩短到单个段落内的连续片段，多次 patch 即可。'
        + '\n→ 改整段：改用 action=replace + scene + paragraph（结构化定位，推荐）。'
        + '\n→ 多段合一：用 action=replace + scene + startParagraph/endParagraph'
        + '（一次替换连续多段，两端都包含）。'
        + '\n→ 后两条都要 scene 名，不确定就先 novel_list_scenes。'
        + '（本条守卫先于任何 I/O 触发，因此这里列不出场景列表。）'
        + '\n→ 无论走哪条：match 必须从 novel_read_chapter 的输出**逐字复制**，'
        + '不要凭记忆拼——凭记忆拼出来的段落顺序常常是错的。',
      )
    }
  }

  // ★ 区间参数守卫（lark-cli 契约：--start-block-id requires --end-block-id
  //   and cannot be combined with --block-id）。同样是零 I/O 开销拦下，
  //   避免让 CLI 回一个无细节的 exit code 1。
  {
    const t = params.target
    const hasStartBlock = t.startBlockId !== undefined && t.startBlockId !== ''
    const hasEndBlock = t.endBlockId !== undefined && t.endBlockId !== ''
    if (hasStartBlock !== hasEndBlock) {
      throw new Error(
        'startBlockId 与 endBlockId 必须成对给出（区间两端都包含）。'
        + `当前只提供了 ${hasStartBlock ? 'startBlockId' : 'endBlockId'}。`
        + '若只改单个块，请用 blockId（或 scene + paragraph）。',
      )
    }
    if (hasStartBlock && t.blockId !== undefined && t.blockId !== '') {
      throw new Error('blockId 与 startBlockId/endBlockId 不能同时使用（lark-cli 禁止混用）。请二选一。')
    }

    const hasStartPara = t.startParagraph !== undefined
    const hasEndPara = t.endParagraph !== undefined
    if (hasStartPara !== hasEndPara) {
      throw new Error(
        'startParagraph 与 endParagraph 必须成对给出（区间两端都包含）。'
        + `当前只提供了 ${hasStartPara ? 'startParagraph' : 'endParagraph'}。`
        + '若只改单段，请用 paragraph。',
      )
    }
    if (hasStartPara && t.paragraph !== undefined) {
      throw new Error('paragraph 与 startParagraph/endParagraph 语义冲突，请二选一。')
    }
    if (t.startParagraph !== undefined && t.endParagraph !== undefined) {
      const from = t.startParagraph
      const to = t.endParagraph
      if (from > to) {
        throw new Error(`段落区间非法：startParagraph(${from}) 大于 endParagraph(${to})。`)
      }
      if ((t.scene === undefined || t.scene === '') && !hasStartBlock) {
        throw new Error('startParagraph/endParagraph 需要配合 scene 使用（段落序号是场景内序号）。')
      }
    }
    // block_insert_after 的 CLI 语义是"在某个块之后插入"，没有区间版本
    if (params.action === 'expand' && (hasStartBlock || hasStartPara)) {
      throw new Error(
        'expand 不支持区间定位——它是在**单个**块之后插入。'
        + '请改用 blockId 或 scene + paragraph 指定插入点；'
        + '若想一次插入多段内容，把多段文本都放进 content 即可。',
      )
    }
  }

  const { base } = await import('@unwr/feishu')
  const { CHAPTER_F, CHAPTER_STATUS, TABLE } = await import('@unwr/schema')

  const { docToken } = await resolveChapterDoc(baseToken, chapterNo, signal)
  const warnings: string[] = []

  // 记录变更前的字数
  const before = params.updateWordCount === true ? await currentWords(docToken, signal) : 0

  let locatedBy: ReviseResult['locatedBy']
  let blockId: string
  /** 实际下发给 CLI 的定位目标：单块 id 或兄弟块区间 */
  let blockTarget: BlockTarget
  let sceneTitle: string | undefined
  let res: { revision_id: number; url: string; result: string; warnings?: string[] }

  if (params.action === 'patch') {
    // patch 走精确文本替换，不需要块 id，但先做失配预检——
    // 直接透传 CLI 的话只有晦涩的 degrade_code，模型无法自我纠正
    if (params.target.match === undefined || params.target.match === '') {
      throw new Error('patch 动作必须提供 target.match（要被替换的精确连续文本）。')
    }
    {
      const full = await docs.fetchDoc(docToken, { docFormat: 'markdown' }, signal)
      if (!full.content.includes(params.target.match)) {
        // 失配引导：给了 scene 就列出该场景段落，否则列出场景标题
        const hasScene = params.target.scene !== undefined && params.target.scene !== ''
        const guide = hasScene
          ? (await getSceneParagraphs(docToken, params.target.scene as string, signal)).paragraphs
              .map((p) => `  ${p.index}. ${p.text.slice(0, 60)}${p.text.length > 60 ? '…' : ''}`)
              .join('\n')
          : (await listScenes(docToken, signal)).map((s) => `  - ${s.title}`).join('\n')
        throw new Error(
          'match 在正文中不存在（必须与 novel_read_chapter 返回的文本逐字符一致，含标点与换行）。'
          + `\n${hasScene ? '该场景的段落：' : '可用场景：'}\n${guide}`
          + '\n更稳的做法：改用 action=replace + scene + paragraph（结构化定位，无需复制原文）。',
        )
      }
    }
    locatedBy = 'match'
    blockId = ''
    blockTarget = ''
    try {
      res = await docs.strReplace(docToken, params.target.match, params.content as string, signal)
    } catch (e) {
      throw enrichPatchError(e instanceof Error ? e : new Error(String(e)))
    }
    warnings.push(...res.warnings ?? [])
  } else {
    // replace / expand / delete 需要定位到块。优先级：
    //   blockId / startBlockId+endBlockId（显式）
    //   > scene+startParagraph..endParagraph（结构化区间）
    //   > scene+paragraph（结构化单段，**推荐**）
    //   > scene（整场景）
    if (params.target.blockId !== undefined && params.target.blockId !== '') {
      locatedBy = 'blockId'
      blockId = params.target.blockId
      blockTarget = blockId
    } else if (
      params.target.startBlockId !== undefined && params.target.startBlockId !== ''
      && params.target.endBlockId !== undefined && params.target.endBlockId !== ''
    ) {
      locatedBy = 'range'
      blockId = params.target.startBlockId
      blockTarget = {
        startBlockId: params.target.startBlockId,
        endBlockId: params.target.endBlockId,
      }
    } else if (
      params.target.scene !== undefined && params.target.scene !== ''
      && params.target.startParagraph !== undefined
      && params.target.endParagraph !== undefined
    ) {
      // 结构化段落区间：把「第 M-N 段」翻译成块区间（两端都包含）
      const sp = await getSceneParagraphs(docToken, params.target.scene, signal)
      const from = params.target.startParagraph
      const to = params.target.endParagraph
      if (from < 1) {
        throw new Error(`段落区间序号从 1 开始（收到 startParagraph=${from}）。`)
      }
      const start = sp.paragraphs.find((p) => p.index === from)
      const end = sp.paragraphs.find((p) => p.index === to)
      if (start === undefined || end === undefined) {
        const bad = start === undefined ? from : to
        throw new LocateError(
          `场景「${sp.sceneTitle}」共 ${sp.paragraphs.length} 个段落，没有第 ${bad} 段。`,
          sp.paragraphs.map((p) => `${p.index}. ${p.text.slice(0, 40)}`),
        )
      }
      locatedBy = 'range'
      blockId = start.blockId
      blockTarget = { startBlockId: start.blockId, endBlockId: end.blockId }
      sceneTitle = sp.sceneTitle
      // 区间替换会吃掉中间一切：段落之间的引用块/列表/图片也一并处理
      if (to > from + 1) {
        warnings.push(
          `段落区间 ${from}-${to} 内共 ${to - from + 1} 段，`
          + '中间的非段落块（引用、列表、图片等）也会被一并替换。'
          + '若只想合并纯文本段落，请确认区间内没有其他内容块。',
        )
      }
    } else if (
      params.target.scene !== undefined && params.target.scene !== ''
      && params.target.paragraph !== undefined
    ) {
      // 结构化段落定位：无需复制原文，最稳
      const sp = await getSceneParagraphs(docToken, params.target.scene, signal)
      const para = sp.paragraphs.find((p) => p.index === params.target.paragraph)
      if (para === undefined) {
        throw new LocateError(
          `场景「${sp.sceneTitle}」共 ${sp.paragraphs.length} 个段落，没有第 ${params.target.paragraph} 段。`,
          sp.paragraphs.map((p) => `${p.index}. ${p.text.slice(0, 40)}`),
        )
      }
      locatedBy = 'paragraph'
      blockId = para.blockId
      blockTarget = para.blockId
      sceneTitle = sp.sceneTitle
    } else if (params.target.scene !== undefined && params.target.scene !== '') {
      const found = await locateByScene(docToken, params.target.scene, signal)
      locatedBy = 'scene'
      blockId = found.blockId
      blockTarget = found.blockId
      sceneTitle = found.sceneTitle
    } else if (params.target.match !== undefined && params.target.match !== '') {
      // 无 blockId / scene 时，退化到 match：但不直接替换，
      // 而是提示模型改用 patch 动作
      throw new Error(
        'replace / expand / delete 需要 blockId 或 scene 来定位。'
        + '若只有原文片段，请改用 action=patch。',
      )
    } else {
      throw new Error('必须提供 blockId、scene 或 match 之一来定位。')
    }

    if (params.action === 'replace') {
      res = await docs.blockReplace(docToken, blockTarget, params.content as string, {}, signal)
    } else if (params.action === 'expand') {
      // 区间已在上游守卫中拒绝，这里 blockTarget 必为单块 id
      res = await docs.blockInsertAfter(docToken, blockId, params.content as string, signal)
    } else {
      // delete：物理删除整块（占位段落/空段清理），区间版可批量删除。
      // CLI 实证无需 --content；块删除后 block_id 失效，结果里提示重新定位。
      res = await docs.blockDelete(docToken, blockTarget, signal)
      warnings.push('块已删除，其 block_id 已失效；继续操作同区域请重新 novel_list_scenes 获取结构。')
    }
    if (typeof blockTarget !== 'string') {
      // 区间操作会重建这些块，旧 id 全部失效
      warnings.push(
        '区间操作已重建该范围的块结构，区间内旧 block_id 全部失效；'
        + '后续操作请重新 novel_list_scenes 获取结构。',
      )
    }
    warnings.push(...res.warnings ?? [])
  }

  // 回写字数与状态
  let wordDelta = 0
  if (params.updateWordCount === true) {
    const after = await currentWords(docToken, signal)
    wordDelta = after - before
    const recordId = await findChapterRecord(baseToken, chapterNo, signal)
    if (recordId !== undefined) {
      await base.updateRecords(
        baseToken,
        TABLE.CHAPTER,
        {
          [recordId]: {
            [CHAPTER_F.WORDS]: after,
            [CHAPTER_F.STATUS]: [CHAPTER_STATUS.REVISING],
          },
        },
        signal,
      )
    } else {
      warnings.push('未找到章节记录，字数与状态未回写。')
    }
  }

  return {
    locatedBy,
    blockId,
    ...sceneTitle === undefined ? {} : { sceneTitle },
    ...params.target.paragraph === undefined ? {} : { paragraphIndex: params.target.paragraph },
    ...locatedBy === 'range'
      && params.target.startParagraph !== undefined
      && params.target.endParagraph !== undefined
      ? { paragraphRange: { from: params.target.startParagraph, to: params.target.endParagraph } }
      : {},
    wordDelta,
    revisionId: res.revision_id,
    documentId: docToken,
    warnings,
  }
}

/** 取章节的版本历史（改稿留痕）。 */
export async function chapterHistory(
  baseToken: string,
  chapterNo: number,
  pageSize = 20,
  signal?: AbortSignal,
): Promise<{
  documentId: string
  entries: {
    revisionId: number
    editTime: string
    historyVersionId: string
  }[]
}> {
  const { docToken } = await resolveChapterDoc(baseToken, chapterNo, signal)
  const res = await docs.listDocHistory(docToken, pageSize, signal)
  return {
    documentId: docToken,
    entries: (res.entries ?? []).map((e) => ({
      revisionId: e.revision_id,
      editTime: e.edit_time,
      historyVersionId: e.history_version_id,
    })),
  }
}
