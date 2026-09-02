/**
 * 智能体写作 e2e 的落库验收（由 scripts/run-e2e.mjs --agent 自动调用，
 * 也可手动复跑：node --import tsx/esm packages/novel/scripts/agent-verify.ts <baseToken>）。
 *
 * 与 packages/novel/tests/e2e-workflow.spec.ts 的区别：
 *   那个测「工具函数直接调用的域级行为」；本脚本测「真实 LLM 智能体
 *   通过多轮编排后，飞书里**实际沉淀了什么**」——它只看结果，不信任
 *   智能体的口头报告，因此能暴露编排层问题（漏沉淀、写错表、章壳
 *   未填、字数虚报等）。
 *
 * 验收矩阵（一次无人值守写作后应满足）：
 *   结构：13 张表齐全；作品表 1 条记录（名字可核对）
 *   正文：章节表有该章、DOC_URL 非空、字数 ≥ 阈值、状态过了「大纲」、
 *         大纲要点与章节摘要非空；正文文档可读且长度达标、用 ## 分场景
 *   记忆：人物状态快照 ≥1、事件 ≥1
 *   素材：设定 ≥3、人物 ≥2、人物关系 ≥1、卷 ≥1、伏笔 ≥1、剧情线 ≥1
 *
 * 注意（平台坑，见 memory 52080412）：link 字段在 record-list 的
 * --field-id 投影下会被静默忽略——本脚本一律拉全字段本地处理。
 *
 * @module scripts/agent-verify
 */

import { base } from '@unwr/feishu'
import {
  ALL_TABLES, CHAPTER_F, CHAPTER_STATUS, CHARACTER_F, EVENT_F, FORESHADOW_F,
  PLOTLINE_F, RELATION_F, SETTING_F, TABLE, VOLUME_F, WORK_F,
} from '@unwr/schema'
import { readChapter } from '../src/domain/chapter.ts'

// ─── 参数 ─────────────────────────────────────────────────────────────

function usage(): never {
  console.error('用法: node --import tsx/esm packages/novel/scripts/agent-verify.ts <baseToken> [--min-words=800] [--expect-name=作品名] [--chapter=1]')
  process.exit(2)
}

const positional: string[] = []
let minWords = 800
let expectName = ''
let chapterNo = 1
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--min-words=')) minWords = Number(a.slice('--min-words='.length)) || minWords
  else if (a.startsWith('--expect-name=')) expectName = a.slice('--expect-name='.length)
  else if (a.startsWith('--chapter=')) chapterNo = Number(a.slice('--chapter='.length)) || chapterNo
  else positional.push(a)
}
const baseToken = positional[0] ?? ''
if (baseToken === '') usage()

// ─── 基础设施 ─────────────────────────────────────────────────────────

interface Check { name: string, ok: boolean, detail: string }
const checks: Check[] = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 收敛期重试：新库/新写的记录有秒级索引延迟（实测 6s+，分钟级也有）。 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const msg = e instanceof Error ? e.message : String(e)
      // 「note has been deleted」= base 本身没了，永久错误，重试无意义
      if (/has been deleted|invalid.?base.?token/i.test(msg)) throw e
      if (/not.?found|notexist|1254045|800030201/i.test(msg) || attempt < attempts) {
        console.log(`  … ${label} 第 ${attempt} 次未就绪（${msg.slice(0, 120)}），重试`)
        await sleep(3000)
        continue
      }
      throw e
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 拉一张表的全部记录（不传 fieldIds：link 字段投影会被静默忽略）。 */
async function rows(table: string): Promise<Record<string, unknown>[]> {
  return withRetry(`读取${table}`, async () => {
    const matrix = await base.listRecords(baseToken, table, {})
    return base.matrixToObjects(matrix)
  })
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
const firstStr = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? text(v[0]) : text(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0)

// ─── 验收 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[agent-verify] base=${baseToken} chapter=${chapterNo} minWords=${minWords}`)
  if (expectName !== '') console.log(`[agent-verify] expect-name=${expectName}`)

  // 1. 13 张表齐全
  const tableInfo = await withRetry('listTables', () => base.listTables(baseToken))
  const present = new Set(tableInfo.tables.map((t) => t.name))
  const missing = ALL_TABLES.filter((t) => !present.has(t))
  record(
    '13 张表齐全',
    missing.length === 0,
    missing.length === 0 ? `实际 ${present.size} 张` : `缺：${missing.join('、')}`,
  )

  // 2. 作品表
  const workRows = await rows(TABLE.WORK)
  const workName = workRows.length > 0 ? firstStr(workRows[0]?.[WORK_F.NAME]) : ''
  const nameOk = expectName === '' ? workName !== '' : workName === expectName
  record('作品表有记录且名字匹配', workRows.length === 1 && nameOk,
    `记录 ${workRows.length} 条，作品名="${workName}"${expectName !== '' ? `（期望 "${expectName}"）` : ''}`)

  // 3. 章节表：存在 + 状态 + 字数 + 文档 + 大纲 + 摘要
  const chapterRows = await rows(TABLE.CHAPTER)
  const chapter = chapterRows.find((r) => num(r[CHAPTER_F.NO]) === chapterNo)
  if (chapter === undefined) {
    record(`章节 ${chapterNo} 存在`, false, `章节表共 ${chapterRows.length} 条，无第 ${chapterNo} 章`)
  } else {
    const status = firstStr(chapter[CHAPTER_F.STATUS])
    const words = num(chapter[CHAPTER_F.WORDS])
    const docUrl = text(chapter[CHAPTER_F.DOC_URL])
    const outline = text(chapter[CHAPTER_F.OUTLINE])
    const summary = text(chapter[CHAPTER_F.SUMMARY])
    const title = firstStr(chapter[CHAPTER_F.TITLE])

    record(`章节 ${chapterNo} 状态过「大纲」`, status !== '' && status !== CHAPTER_STATUS.OUTLINE,
      `标题="${title}" 状态="${status}"`)
    record(`章节 ${chapterNo} 索引字数 ≥ ${minWords}`, words >= minWords, `字数=${words}`)
    record(`章节 ${chapterNo} 有正文文档`, docUrl !== '', docUrl === '' ? 'DOC_URL 为空（章壳未填？）' : docUrl)
    record(`章节 ${chapterNo} 大纲要点非空`, outline !== '', outline === '' ? '为空' : `${outline.length} 字`)
    record(`章节 ${chapterNo} 章节摘要非空（记忆沉淀）`, summary !== '', summary === '' ? '为空（漏 novel_update_summary？）' : `${summary.length} 字`)

    // 4. 正文可读性（只信文档，不信索引字数）
    if (docUrl !== '') {
      try {
        const { content } = await withRetry(`读取第 ${chapterNo} 章正文`, () => readChapter(docUrl, {}, undefined), 3)
        // docx 标题在 markdown 导出中呈现为首行 h1——这是「章标题由文档标题承担」
        // 的合法形态（正文本身不应再写 h1），先剥离再检查正文层级。
        const body = content.replace(/^#\s+.*\n/, '')
        const clean = body.replace(/\s/g, '')
        record(`正文实读长度 ≥ ${minWords}`, clean.length >= minWords, `实读 ${clean.length} 字（索引口径 ${words}）`)
        const scenes = (body.match(/^##\s/gm) ?? []).length
        record('正文用 ## 划分场景', scenes >= 1, `${scenes} 个 ## 场景${scenes === 0 ? '（写作约定第 3 条未遵守？）' : ''}`)
        record('正文不含 # 一级标题', !/^#\s/m.test(body), /^#\s/m.test(body) ? '正文中出现了 # 一级标题' : '合规（首行 h1 为文档标题的导出形态，不计）')
      } catch (e) {
        record(`正文实读长度 ≥ ${minWords}`, false, `正文文档读取失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // 5. 记忆沉淀：人物状态 + 事件
  const stateRows = await rows(TABLE.CHARACTER_STATE)
  record('人物状态快照 ≥ 1', stateRows.length >= 1,
    `${stateRows.length} 条${stateRows.length === 0 ? '（漏 novel_record_character_state？）' : ''}`)
  const eventRows = await rows(TABLE.EVENT)
  record('事件索引 ≥ 1', eventRows.length >= 1,
    `${eventRows.length} 条${eventRows.length === 0 ? '（漏 novel_record_event？）' : ''}`)

  // 6. 创作素材
  const settingRows = await rows(TABLE.SETTING)
  record('设定词条 ≥ 3', settingRows.length >= 3, `${settingRows.length} 条`)
  const charRows = await rows(TABLE.CHARACTER)
  record('人物档案 ≥ 2', charRows.length >= 2, `${charRows.length} 条（${charRows.map((r) => firstStr(r[CHARACTER_F.NAME])).slice(0, 5).join('、')}）`)
  const relationRows = await rows(TABLE.RELATION)
  record('人物关系 ≥ 1', relationRows.length >= 1,
    `${relationRows.length} 条${relationRows.length === 0 ? '' : `（${firstStr(relationRows[0]?.[RELATION_F.TYPE])}）`}`)
  const volumeRows = await rows(TABLE.VOLUME)
  record('分卷 ≥ 1', volumeRows.length >= 1,
    `${volumeRows.length} 卷${volumeRows.length > 0 ? `（${firstStr(volumeRows[0]?.[VOLUME_F.NAME])}）` : ''}`)
  const foreshadowRows = await rows(TABLE.FORESHADOW)
  const planted = foreshadowRows.filter((r) => firstStr(r[FORESHADOW_F.STATUS]) === '已埋设').length
  record('伏笔（已埋设）≥ 1', planted >= 1, `共 ${foreshadowRows.length} 条，已埋设 ${planted} 条`)
  const plotlineRows = await rows(TABLE.PLOTLINE)
  const mainlines = plotlineRows.filter((r) => firstStr(r[PLOTLINE_F.TYPE]) === '主线')
  record('主线剧情线 ≥ 1', mainlines.length >= 1, `共 ${plotlineRows.length} 条，主线 ${mainlines.length} 条`)

  // ─── 汇总 ─────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok)
  const ok = failed.length === 0
  console.log()
  console.log(ok
    ? `[agent-verify] ✓ 验收通过（${checks.length} 项检查全过）`
    : `[agent-verify] ✗ 验收失败：${failed.length}/${checks.length} 项未过：\n${failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n')}`)

  // 机器可读输出（run-e2e.mjs 解析最后一段 JSON）
  console.log('<<<AGENT_VERIFY_JSON>>>')
  console.log(JSON.stringify({
    ok,
    baseToken,
    chapterNo,
    minWords,
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
  }, null, 2))

  process.exit(ok ? 0 : 1)
}

await main().catch((e) => {
  console.error(`[agent-verify] 异常退出：${e instanceof Error ? e.stack : String(e)}`)
  console.log('<<<AGENT_VERIFY_JSON>>>')
  console.log(JSON.stringify({ ok: false, baseToken, error: String(e) }, null, 2))
  process.exit(1)
})
