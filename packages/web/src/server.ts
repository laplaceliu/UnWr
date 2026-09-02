/**
 * UnWr 工作台本地服务（零新依赖）。
 *
 * 职责：把 @unwr/feishu / @unwr/novel 的领域函数以只读为主的 REST API
 * 暴露给前端 SPA（public/）。写操作仅限低风险三类：新建作品、切换
 * 写作模式、章节状态流转——正文与结构化数据的写入仍走 DSH 智能体
 * （评审官只读、起草官落库的权限模型在工作台侧不重复实现）。
 *
 * 启动：pnpm workbench（默认 http://127.0.0.1:3311，PORT 可覆盖）
 * 认证：复用 lark-cli 的登录态（~/.lark-cli/config.json）。
 *
 * @module @unwr/web/server
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

import { base, docs } from '../../feishu/src/index.ts'
import {
  TABLE, CHAPTER_F, CHAPTER_STATUS, CHARACTER_F, CHARACTER_STATE_F,
  BRANCH_F, EVENT_F, FORESHADOW_F, MEMORY_F, PLOTLINE_F, RELATION_F,
  SETTING_F, VOLUME_F, WORK_F,
} from '../../schema/src/index.ts'
import type { GenrePreset } from '../../schema/src/index.ts'
import {
  listWorks, getWorkConfig, updateWorkConfig, createWorkRootFolder,
} from '../../novel/src/domain/work.ts'
import { initWork, ensureWorkSchemaCached } from '../../novel/src/domain/bootstrap.ts'
import { findChapterRecord } from '../../novel/src/domain/chapter.ts'
import { buildContext, extractDocToken } from '../../novel/src/context/builder.ts'
import { runRuleChecks, buildSemanticCheckPack } from '../../novel/src/domain/consistency.ts'
import { chapterHistory, listScenes } from '../../novel/src/domain/revision.ts'
import {
  renderReviewFocus, weightForIssueType,
} from '../../novel/src/genre/review-focus.ts'
import { renderWritingGuide } from '../../novel/src/tools/context.ts'

const PORT = Number(process.env.PORT ?? 3311)
const HOST = process.env.HOST ?? '127.0.0.1'
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const YML_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'profiles', 'web', 'cordis.patch.yml')

/* ============================== 小工具 ============================== */

const str = (v: unknown): string =>
  Array.isArray(v) ? String(v[0] ?? '') : (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number =>
  typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : 0

function json(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 统一错误包装：领域函数抛错 → 500 + 可读信息（lark-cli 未认证等）。 */
function fail(res: ServerResponse, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  console.error('[workbench]', msg)
  json(res, 500, { error: msg })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 1_000_000) throw new Error('请求体超过 1MB。')
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
}

/** 拉一张表并转对象（附带 __recordId）。表缺失时返回空数组。 */
async function rows(
  baseToken: string,
  table: string,
  fields: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  try {
    return base.matrixToObjects(
      await base.listAllRecords(baseToken, table, { fieldIds: fields }, signal),
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 表不存在是新建作品的常态，不阻断整体渲染
    if (/not.?exist|NOTEXIST|not_found|不存在/i.test(msg)) return []
    throw e
  }
}

/* ============================== 领域查询 ============================== */

interface WorkCard {
  baseToken: string
  name: string
  url?: string
  genre: string
  mode: string
  currentChapter: number
  targetWords: number
  folderUrl: string
  /** 非 UnWr 库（云盘搜索会捞到无关 bitable）被过滤，此字段仅内部使用 */
  isUnwr: boolean
}

/** S0 卡片：云盘搜索 + 逐作品并行拉配置。非 UnWr 库（无作品表）剔除。 */
async function workCards(signal?: AbortSignal): Promise<WorkCard[]> {
  const summaries = await listWorks({ pageSize: 20 }, signal)
  const cards = await Promise.all(summaries.map(async (w): Promise<WorkCard> => {
    try {
      const cfg = await getWorkConfig(w.baseToken, signal)
      // getWorkConfig 缺表回落默认值不报错——必须显式探测作品表是否存在
      await base.listRecords(w.baseToken, TABLE.WORK, { limit: 1 }, signal)
      return {
        baseToken: w.baseToken,
        name: cfg.name !== '' ? cfg.name : w.name,
        url: w.url,
        genre: cfg.genre,
        mode: cfg.mode,
        currentChapter: cfg.currentChapter,
        targetWords: cfg.targetWords,
        folderUrl: cfg.folderUrl,
        isUnwr: true,
      }
    } catch {
      return {
        baseToken: w.baseToken, name: w.name, genre: '', mode: '',
        currentChapter: 0, targetWords: 0, folderUrl: '', isUnwr: false,
      }
    }
  }))
  return cards.filter((c) => c.isUnwr)
}

/** 新建作品：文件夹 → Base → 13 表 → 元信息（复刻 novel_manage_work create）。 */
async function createWork(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const name = str(body.name).trim()
  if (name === '') throw new Error('create 需要 name（作品名）。')
  const workFolder = await createWorkRootFolder(name, signal)
  const created = await base.createBase(name, { folderToken: workFolder.folderToken }, signal)
  const baseToken = String(created.base_token ?? '')
  if (baseToken === '') throw new Error('createBase 未返回 base_token。')
  const r = await initWork(baseToken, signal)

  const meta: Record<string, unknown> = { name }
  for (const key of ['genre', 'subgenre', 'scale', 'mode', 'pov'] as const) {
    if (str(body[key]) !== '') meta[key] = str(body[key])
  }
  if (num(body.targetWords) > 0) meta.targetWords = num(body.targetWords)
  await updateWorkConfig(baseToken, meta, {
    extraFields: { [WORK_F.FOLDER_URL]: workFolder.url },
  }, signal)

  return {
    baseToken,
    url: created.url,
    folderUrl: workFolder.url,
    failedLinks: r.failedLinks,
  }
}

/** S1 左栏：卷 + 章节树。 */
async function outline(baseToken: string, signal?: AbortSignal) {
  const [volumeRows, chapterRows] = await Promise.all([
    rows(baseToken, TABLE.VOLUME, [
      VOLUME_F.NAME, VOLUME_F.ORDER, VOLUME_F.THEME, VOLUME_F.STATUS, VOLUME_F.SUMMARY,
    ], signal),
    rows(baseToken, TABLE.CHAPTER, [
      CHAPTER_F.NO, CHAPTER_F.TITLE, CHAPTER_F.STATUS, CHAPTER_F.WORDS,
      CHAPTER_F.OUTLINE, CHAPTER_F.VOLUME, CHAPTER_F.STORY_TIME, CHAPTER_F.TENSION,
    ], signal),
  ])
  const volumeName = new Map<string, string>()
  for (const v of volumeRows) {
    const rid = str(v['__recordId'])
    if (rid !== '') volumeName.set(rid, str(v[VOLUME_F.NAME]))
  }
  const chapters = chapterRows
    .map((c) => ({
      recordId: str(c['__recordId']),
      no: num(c[CHAPTER_F.NO]),
      title: str(c[CHAPTER_F.TITLE]),
      status: str(c[CHAPTER_F.STATUS]),
      words: num(c[CHAPTER_F.WORDS]),
      outline: str(c[CHAPTER_F.OUTLINE]),
      tension: num(c[CHAPTER_F.TENSION]),
      storyTime: str(c[CHAPTER_F.STORY_TIME]),
      volume: volumeName.get(str(c[CHAPTER_F.VOLUME])) ?? '',
    }))
    .sort((a, b) => a.no - b.no)
  return { volumes: volumeRows, chapters }
}

/** S1 中栏：章节详情（正文 markdown + 可选场景导航与版本历史）。 */
async function chapterDetail(
  baseToken: string,
  chapterNo: number,
  opts: { scenes?: boolean; history?: boolean },
  signal?: AbortSignal,
) {
  const recordId = await findChapterRecord(baseToken, chapterNo, signal)
  if (recordId === undefined) throw new Error(`第 ${chapterNo} 章不存在。`)
  const meta = base.matrixToObjects(await base.listRecords(baseToken, TABLE.CHAPTER, {
    fieldIds: [
      CHAPTER_F.NO, CHAPTER_F.TITLE, CHAPTER_F.STATUS, CHAPTER_F.WORDS,
      CHAPTER_F.OUTLINE, CHAPTER_F.SUMMARY, CHAPTER_F.CAST, CHAPTER_F.STORY_TIME,
      CHAPTER_F.TENSION, CHAPTER_F.DOC_URL, CHAPTER_F.UPDATED_AT,
    ],
    filter: { logic: 'and', conditions: [[CHAPTER_F.NO, '==', chapterNo]] },
    limit: 1,
  }, signal))
  const m = meta[0] ?? {}
  const docToken = extractDocToken(str(m[CHAPTER_F.DOC_URL]))

  const [content, scenes, history] = await Promise.all([
    docToken === undefined
      ? Promise.resolve('')
      : docs.fetchDoc(docToken, { docFormat: 'markdown' }, signal).then((d) => d.content),
    opts.scenes === true && docToken !== undefined
      ? listScenes(docToken, signal).catch(() => [])
      : Promise.resolve([]),
    opts.history === true
      ? chapterHistory(baseToken, chapterNo, 20, signal).catch(() => ({ documentId: '', entries: [] }))
      : Promise.resolve(undefined),
  ])

  return {
    recordId,
    no: num(m[CHAPTER_F.NO]),
    title: str(m[CHAPTER_F.TITLE]),
    status: str(m[CHAPTER_F.STATUS]),
    words: num(m[CHAPTER_F.WORDS]),
    outline: str(m[CHAPTER_F.OUTLINE]),
    summary: str(m[CHAPTER_F.SUMMARY]),
    cast: Array.isArray(m[CHAPTER_F.CAST]) ? m[CHAPTER_F.CAST] : [],
    storyTime: str(m[CHAPTER_F.STORY_TIME]),
    tension: num(m[CHAPTER_F.TENSION]),
    updatedAt: str(m[CHAPTER_F.UPDATED_AT]),
    docToken: docToken ?? '',
    content,
    scenes,
    history,
  }
}

/** S1 右栏：起草上下文摘要（recentChapters 全文不回传，只回传计数）。 */
async function contextDigest(baseToken: string, chapterNo: number, signal?: AbortSignal) {
  const cfg = await getWorkConfig(baseToken, signal)
  const built = await buildContext(baseToken, chapterNo, cfg.preset, undefined, signal)
  return {
    chapterNo: built.chapterNo,
    outline: built.outline,
    characterStates: built.characterStates,
    relevantSettings: built.relevantSettings,
    openForeshadows: built.openForeshadows,
    chapterSummaries: built.chapterSummaries,
    bookSummaries: built.bookSummaries,
    recentFullChapters: built.recentChapters.length,
    writingGuide: renderWritingGuide(cfg.preset),
    estimatedTokens: built.estimatedTokens,
  }
}

/** S3：规则检查 + 题材权重排序与阈值。 */
async function checks(
  baseToken: string,
  query: URLSearchParams,
  signal?: AbortSignal,
) {
  const currentChapterNo = num(query.get('currentChapterNo'))
  const cfg = await getWorkConfig(baseToken, signal)
  const r = await runRuleChecks(baseToken, {
    ...(currentChapterNo > 0 ? { currentChapterNo } : {}),
  }, signal)
  const threshold = cfg.preset.consistency_weights.blocking_threshold
  const issues = [...r.issues].sort((a, b) =>
    weightForIssueType(b.type, cfg.preset) - weightForIssueType(a.type, cfg.preset)
    || b.severity - a.severity)
  return {
    total: issues.length,
    blocking: issues.filter((i) => i.severity >= threshold).length,
    blockingThreshold: threshold,
    genreFocus: renderReviewFocus(cfg.preset).genreFocus,
    issues,
    checkedTables: r.checkedTables,
    skippedTables: r.skipped,
  }
}

/* ============================== 表视图 ============================== */

/** 白名单化的表视图：键 → (表, 字段集)。避免任意表名/字段注入。 */
const TABLE_VIEWS: Record<string, { table: string; fields: string[] }> = {
  settings: {
    table: TABLE.SETTING,
    fields: [SETTING_F.TERM, SETTING_F.CATEGORY, SETTING_F.DEFINITION,
      SETTING_F.IMPORTANCE, SETTING_F.FIRST_CHAPTER, SETTING_F.STATUS, SETTING_F.DOC_URL],
  },
  characters: {
    table: TABLE.CHARACTER,
    fields: [CHARACTER_F.NAME, CHARACTER_F.ALIAS, CHARACTER_F.ROLE, CHARACTER_F.TRAITS,
      CHARACTER_F.CATCHPHRASE, CHARACTER_F.MOTIVE, CHARACTER_F.APPEARANCE,
      CHARACTER_F.ARC_STAGE, CHARACTER_F.APPEARANCES, CHARACTER_F.BIO_URL],
  },
  plotlines: {
    table: TABLE.PLOTLINE,
    fields: [PLOTLINE_F.NAME, PLOTLINE_F.TYPE, PLOTLINE_F.STATUS, PLOTLINE_F.DESCRIPTION,
      PLOTLINE_F.CHAPTERS, PLOTLINE_F.CHARACTERS, PLOTLINE_F.FORESHADOWS],
  },
  foreshadows: {
    table: TABLE.FORESHADOW,
    fields: [FORESHADOW_F.CONTENT, FORESHADOW_F.TYPE, FORESHADOW_F.STATUS,
      FORESHADOW_F.PLANT_CHAPTER, FORESHADOW_F.PLAN_PAYOFF_CHAPTER,
      FORESHADOW_F.ACTUAL_PAYOFF_CHAPTER, FORESHADOW_F.IMPORTANCE, FORESHADOW_F.NOTE],
  },
  branches: {
    table: TABLE.BRANCH,
    fields: [BRANCH_F.TITLE, BRANCH_F.STUCK_CHAPTER, BRANCH_F.DESCRIPTION,
      BRANCH_F.ADOPT_STATUS, BRANCH_F.NOTE],
  },
  events: {
    table: TABLE.EVENT,
    fields: [EVENT_F.NAME, EVENT_F.CHAPTER, EVENT_F.STORY_TIME, EVENT_F.LOCATION,
      EVENT_F.PARTICIPANTS, EVENT_F.SUMMARY, EVENT_F.IMPACT, EVENT_F.IS_TURNING_POINT],
  },
  memory: {
    table: TABLE.MEMORY,
    fields: [MEMORY_F.TITLE, MEMORY_F.LEVEL, MEMORY_F.FROM_CHAPTER, MEMORY_F.TO_CHAPTER,
      MEMORY_F.CONTENT, MEMORY_F.CHAPTERS, MEMORY_F.STALE],
  },
}

async function tableView(
  baseToken: string,
  view: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const spec = TABLE_VIEWS[view]
  if (spec !== undefined) {
    return rows(baseToken, spec.table, spec.fields, signal)
  }
  if (view === 'states') {
    // 人物状态时间线：link 的 record id 解析为姓名
    const [stateRows, characterRows] = await Promise.all([
      rows(baseToken, TABLE.CHARACTER_STATE, [
        CHARACTER_STATE_F.CHARACTER, CHARACTER_STATE_F.CHAPTER, CHARACTER_STATE_F.LOCATION,
        CHARACTER_STATE_F.PHYSICAL, CHARACTER_STATE_F.EMOTION, CHARACTER_STATE_F.BELONGINGS,
        CHARACTER_STATE_F.RELATION_CHANGE, CHARACTER_STATE_F.SUMMARY,
      ], signal),
      rows(baseToken, TABLE.CHARACTER, [CHARACTER_F.NAME], signal),
    ])
    const names = new Map<string, string>()
    for (const c of characterRows) {
      const rid = str(c['__recordId'])
      if (rid !== '') names.set(rid, str(c[CHARACTER_F.NAME]))
    }
    return stateRows.map((s) => ({ ...s, [CHARACTER_STATE_F.CHARACTER]: names.get(str(s[CHARACTER_STATE_F.CHARACTER])) ?? str(s[CHARACTER_STATE_F.CHARACTER]) }))
  }
  if (view === 'relations') {
    const [relationRows, characterRows] = await Promise.all([
      rows(baseToken, TABLE.RELATION, [
        RELATION_F.A, RELATION_F.B, RELATION_F.TYPE, RELATION_F.DESCRIPTION,
        RELATION_F.START_CHAPTER, RELATION_F.STATUS,
      ], signal),
      rows(baseToken, TABLE.CHARACTER, [CHARACTER_F.NAME], signal),
    ])
    const names = new Map<string, string>()
    for (const c of characterRows) {
      const rid = str(c['__recordId'])
      if (rid !== '') names.set(rid, str(c[CHARACTER_F.NAME]))
    }
    const resolve = (v: unknown): string =>
      Array.isArray(v) ? v.map((id) => names.get(String(id)) ?? String(id)).join('、') : str(v)
    return relationRows.map((r) => ({
      ...r,
      [RELATION_F.A]: resolve(r[RELATION_F.A]),
      [RELATION_F.B]: resolve(r[RELATION_F.B]),
    }))
  }
  throw new Error(`未知表视图: ${view}`)
}

/* ============================== 智能体画像 ============================== */

interface AgentProfile {
  id: string
  toolName: string
  allow: string[]
  persona: string
}

/**
 * 解析 cordis.patch.yml 的 agent 块（单源真值：工作台展示与
 * orchestration.spec.ts 的契约校验读同一份文件）。
 * 微型状态机，只认本项目用到的形状。
 */
function agentProfiles(): AgentProfile[] {
  const text = readFileSync(YML_PATH, 'utf8')
  const blocks: AgentProfile[] = []
  let cur: AgentProfile | null = null
  let inAllow = false
  let inPersona = false
  const personaLines: string[] = []

  const flush = (): void => {
    if (cur !== null) {
      cur.persona = personaLines.join('\n').trim()
      blocks.push(cur)
    }
    cur = null
    personaLines.length = 0
  }

  for (const line of text.split(/\r?\n/)) {
    const id = /^(\s*)-\s*id:\s*(unwr-agent-\S+)\s*$/.exec(line)
    if (id !== null) {
      flush()
      cur = { id: id[2] ?? '', toolName: '', allow: [], persona: '' }
      inAllow = false
      inPersona = false
      continue
    }
    if (cur === null) continue
    const tn = /^\s*toolName:\s*(\S+)\s*$/.exec(line)
    if (tn !== null) {
      cur.toolName = tn[1] ?? ''
      inAllow = false
      inPersona = false
      continue
    }
    const inline = /^\s*allow:\s*\[(.*)\]\s*$/.exec(line)
    if (inline !== null) {
      cur.allow.push(...(inline[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      inAllow = false
      inPersona = false
      continue
    }
    if (/^\s*allow:\s*$/.test(line)) {
      inAllow = true
      inPersona = false
      continue
    }
    if (inAllow) {
      const item = /^\s+-\s+(\S+)\s*$/.exec(line)
      if (item !== null) {
        cur.allow.push(item[1] ?? '')
        continue
      }
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      inAllow = false
    }
    if (/^\s*persona:\s*\|/.test(line)) {
      inPersona = true
      continue
    }
    if (inPersona) {
      if (/^\s{0,9}\S/.test(line)) {
        inPersona = false
        continue
      }
      personaLines.push(line.replace(/^\s{10}/, ''))
    }
  }
  flush()
  return blocks
}

/* ============================== 路由 ============================== */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR)) return false
  if (!existsSync(file) || !statSync(file).isFile()) return false
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
  return true
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const seg = url.pathname.split('/').filter(Boolean) // ['api', ...]
  const method = req.method ?? 'GET'
  const m = async (): Promise<unknown> => {
    // /api/health
    if (seg[1] === 'health') return { ok: true }

    // /api/agents
    if (seg[1] === 'agents') return agentProfiles()

    // /api/works
    if (seg[1] === 'works' && seg.length === 2) {
      if (method === 'POST') return createWork(await readBody(req))
      return workCards()
    }

    // /api/works/:token/...
    if (seg[1] === 'works' && seg.length >= 4) {
      const token = seg[2] ?? ''
      const rest = seg.slice(3)

      if (rest[0] === 'config' && rest.length === 1) {
        if (method === 'PATCH') {
          const body = await readBody(req)
          const meta: Record<string, unknown> = {}
          for (const key of ['name', 'genre', 'subgenre', 'scale', 'mode', 'pov'] as const) {
            if (str(body[key]) !== '') meta[key] = str(body[key])
          }
          if (num(body.targetWords) > 0) meta.targetWords = num(body.targetWords)
          await updateWorkConfig(token, meta, {})
          return { updated: true }
        }
        const cfg = await getWorkConfig(token)
        return { ...cfg, writingGuide: renderWritingGuide(cfg.preset), reviewFocus: renderReviewFocus(cfg.preset) }
      }

      if (rest[0] === 'outline' && rest.length === 1) return outline(token)

      if (rest[0] === 'chapters' && rest.length === 2) {
        const no = Number(seg[3])
        if (!Number.isInteger(no) || no <= 0) throw new Error('章节号非法。')
        return chapterDetail(token, no, {
          scenes: url.searchParams.get('scenes') === '1',
          history: url.searchParams.get('history') === '1',
        })
      }

      if (rest[0] === 'chapters' && rest.length === 2 && method === 'PATCH') {
        const no = Number(seg[3])
        const body = await readBody(req)
        const status = str(body.status)
        if (!Object.values(CHAPTER_STATUS).includes(status as never)) {
          throw new Error(`非法章节状态: ${status}`)
        }
        const recordId = await findChapterRecord(token, no)
        if (recordId === undefined) throw new Error(`第 ${no} 章不存在。`)
        await base.updateRecords(token, TABLE.CHAPTER, {
          [recordId]: { [CHAPTER_F.STATUS]: [status] },
        })
        return { updated: true, no, status }
      }

      if (rest[0] === 'context' && rest.length === 2) {
        return contextDigest(token, Number(seg[3]))
      }

      if (rest[0] === 'checks' && rest.length === 1) return checks(token, url.searchParams)

      // S3 语义包：材料 + 按题材权重排序的检查清单
      if (rest[0] === 'semantic-pack' && rest.length === 1) {
        const cfg = await getWorkConfig(token)
        const chapterNo = Number(url.searchParams.get('chapterNo'))
        const [pack, cfg2] = await Promise.all([
          buildSemanticCheckPack(token, chapterNo),
          Promise.resolve(cfg),
        ])
        return { ...pack, reviewChecklist: renderReviewFocus(cfg2.preset).checklist }
      }

      if (rest[0] === 'table' && rest.length === 2) {
        return tableView(token, seg[4] ?? '')
      }

      throw new Error(`未知 API: ${url.pathname}`)
    }

    throw new Error(`未知 API: ${url.pathname}`)
  }

  try {
    json(res, 200, await m())
  } catch (e) {
    fail(res, e)
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url)
    return
  }
  if (!serveStatic(url.pathname, res)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`UnWr 工作台 → http://${HOST}:${PORT}`)
  console.log('数据源：飞书（经 lark-cli）。正文与结构化写入仍由 DSH 智能体负责。')
})
