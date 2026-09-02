/**
 * 工具体检：把注册表里全部 26 个 novel_* 工具在**全新作品库**上按
 * 真实编排时序各打一发代表性探针，输出逐工具 ✓/✗ 报告。
 *
 * 与其它测试的分工：
 *   - vitest 单测            → 纯函数 / mock 域层
 *   - e2e-workflow.spec.ts   → 生命周期 + 错误分支（vitest 编排）
 *   - 本脚本                 → **每个工具至少一次成功调用**的体检矩阵，
 *     快速回答「26 个工具现在都能用吗」；智能体 e2e（pnpm test:agent）
 *     测的是模型编排，本脚本测工具本身——互不替代。
 *
 * 用法：
 *   node --import tsx/esm packages/novel/scripts/tool-audit.ts
 *   node --import tsx/esm packages/novel/scripts/tool-audit.ts --keep
 *
 * 注意：lark-cli 没有 base 删除命令，每次体检会新建一个 [audit] 前缀
 * 的作品库，需定期去飞书 UI 手动清理。
 *
 * @module scripts/tool-audit
 */

import { apply } from '../src/index.ts'
import { base } from '@unwr/feishu'

// ─── 工具收集（与 e2e-workflow.spec.ts 同一模式） ──────────────────────

interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({
    tools: { register: (t: MinimalTool) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  } as never, {})
  return tools
}

// ─── 基础设施 ─────────────────────────────────────────────────────────

interface Probe {
  /** 展示名（默认工具名） */
  label?: string
  tool: string
  args: Record<string, unknown>
  /** 期望返回里出现的字段（探针成功断言，宽松 contains） */
  expectKey?: string
}

interface Result {
  tool: string
  label: string
  ok: boolean
  ms: number
  warnings: number
  detail: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 新库收敛期重试（not_found / NOTEXIST / 800030201 退避；其余快速失败）。 */
async function withConvergenceRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (!/not.?found|notexist|1254045|800030201/i.test(msg)) throw e
      if (attempt < maxAttempts) await sleep(3000)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** 等新库写路径收敛（实测分钟级多级就绪；探针写人物表）。 */
async function waitForBaseReady(baseToken: string, timeoutMs = 120_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await base.createRecords(baseToken, '人物表', [{ 姓名: '__收敛探针__', 身份: '体检探针（可忽略）' }])
      return
    } catch (e) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`新库写路径 ${Math.round(timeoutMs / 1000)}s 未收敛：${e instanceof Error ? e.message : String(e)}`)
      }
      await sleep(3000)
    }
  }
}

// ─── 探针序列（顺序 = 真实编排时序） ───────────────────────────────────

/** 第一章正文（两个 ## 场景；含 revise 探针要 patch 的原句）。 */
const CH1 = `## 一、夜探

沈砚翻进领事馆后墙时，怀表恰好指向丑时三刻。

廊下没有灯。他把风衣下摆掖进腰带，贴着柱影往里挪。

## 二、交锋

「三更半夜，沈先生好雅兴。」说话的人从阴影里踱出来，警棍在掌心敲了两下。

沈砚笑了笑：「林警司的值班室，茶都凉了三回吧。」`

function buildPhases(baseToken: string): Probe[] {
  const T = (tool: string, args: Record<string, unknown>, label?: string, expectKey?: string): Probe =>
    ({ tool, args: { workToken: baseToken, ...args }, label, expectKey })
  return [
    // P1 作品（create 已在 main 先行完成并单记一条结果）
    T('novel_manage_work', { action: 'get_config' }, 'work.get_config', 'config'),
    T('novel_manage_work', { action: 'update_config', subgenre: '都市悬疑', targetWords: 200000 }, 'work.update_config'),
    T('novel_manage_work', { action: 'list' }, 'work.list', 'works'),
    // P2 素材
    T('novel_manage_setting', { action: 'upsert', term: '雾障', definition: '每逢十五笼罩全城的浓雾，雾中方向感失灵。', category: ['规则'], importance: 5 }, 'setting.upsert', 'recordId'),
    T('novel_manage_setting', { action: 'query', keyword: '雾' }, 'setting.query', 'items'),
    T('novel_manage_character', { action: 'upsert', name: '沈砚', role: '主角，前刑警', traits: ['缜密', '话少'], catchphrase: '查。', motive: '查清旧案' }, 'character.upsert', 'recordId'),
    T('novel_manage_character', { action: 'upsert', name: '林警司', role: '配角，值班警官', traits: ['油滑'] }, 'character.upsert#2'),
    T('novel_manage_character', { action: 'query', keyword: '沈' }, 'character.query', 'items'),
    T('novel_manage_relation', { action: 'upsert', characterA: '沈砚', characterB: '林警司', type: '利用', note: '互相试探的同盟' }, 'relation.upsert', 'recordId'),
    T('novel_manage_relation', { action: 'query' }, 'relation.query', 'items'),
    T('novel_manage_foreshadow', { action: 'upsert', content: '怀表停在丑时三刻——与凶案时间吻合', type: '物品', status: '已埋设', importance: 4 }, 'foreshadow.upsert', 'recordId'),
    T('novel_manage_foreshadow', { action: 'query', status: '已埋设' }, 'foreshadow.query', 'items'),
    T('novel_manage_plotline', { action: 'upsert', name: '领事馆纵火案', type: '主线', status: '铺垫', description: '主线悬案' }, 'plotline.upsert', 'recordId'),
    T('novel_manage_plotline', { action: 'query', type: '主线' }, 'plotline.query', 'items'),
    T('novel_manage_branch', { action: 'upsert', title: '分支A：林警司是内应', description: '警司暗中为纵火者传递情报', adoptStatus: '候选' }, 'branch.upsert', 'recordId'),
    T('novel_manage_branch', { action: 'query', adoptStatus: '候选' }, 'branch.query', 'items'),
    // P3 大纲
    T('novel_manage_outline', { action: 'upsert_volume', volume: '第一卷 雾起', order: 1, theme: '案件浮出', status: '进行中' }, 'outline.upsert_volume', 'recordId'),
    T('novel_manage_outline', { action: 'set_chapter_outline', chapterNo: 2, volume: '第一卷 雾起', outline: '沈砚从怀表入手，发现停针时刻的蹊跷。', storyTime: '六月十四 夜' }, 'outline.set#2', 'recordId'),
    T('novel_manage_outline', { action: 'query', chapterNo: 2 }, 'outline.query', 'items'),
    // P4 章节生命周期
    T('novel_build_context', { chapterNo: 1 }, 'context.build', 'writingGuide'),
    T('novel_write_chapter', { chapterNo: 1, title: '第一章 夜探', content: CH1, volume: '第一卷 雾起' }, 'chapter.write', 'documentId'),
    T('novel_read_chapter', { chapterNo: 1, mode: 'full' }, 'chapter.read', 'content'),
    T('novel_list_scenes', { chapterNo: 1 }, 'revision.list_scenes', 'scenes'),
    T('novel_revise_chapter', { chapterNo: 1, action: 'patch', scene: '二、交锋', match: '茶都凉了三回吧。', content: '茶都凉了五回了吧。' }, 'revision.patch', 'revisionId'),
    T('novel_append_chapter', { chapterNo: 1, content: '\n他把手表贴在耳边，听指针停摆的死寂。' }, 'chapter.append', 'totalWords'),
    T('novel_get_chapter_history', { chapterNo: 1 }, 'revision.history', 'entries'),
    // P5 记忆沉淀
    T('novel_update_summary', { chapterNo: 1, scene: '六月十三夜，领事馆后墙', events: ['沈砚夜探领事馆', '被林警司撞见，言语试探'], characterChanges: ['沈砚：身份暴露边缘'], newInfo: ['怀表停针与凶案时间吻合'], endState: '林警司放行，动机存疑' }, 'memory.summary', 'summaryText'),
    T('novel_record_character_state', { chapterNo: 1, character: '沈砚', location: '领事馆外巷', physical: '无伤', emotion: '警觉', summary: '夜探未遂，被警司盯上' }, 'memory.state', 'recordId'),
    T('novel_record_event', { chapterNo: 1, name: '领事馆夜探', location: '领事馆后墙', participants: ['沈砚', '林警司'], summary: '试探性接触', isTurningPoint: false }, 'memory.event', 'recordId'),
    T('novel_record_chapter_tension', { chapterNo: 1, score: 3 }, 'memory.tension', 'recordId'),
    T('novel_upsert_book_summary', { level: '全书', title: '全书梗概（体检写入）', content: '刑警沈砚追查领事馆纵火案。' }, 'memory.book_summary', 'recordId'),
    // P6 诊断
    T('novel_run_consistency_check', { chapterNo: 1 }, 'consistency.run', 'issues'),
    T('novel_get_semantic_check_pack', { chapterNo: 1 }, 'consistency.semantic_pack', 'characters'),
    T('novel_get_review_focus', {}, 'consistency.review_focus', 'weights'),
    T('novel_breakthrough_planning', { chapterNo: 2, stuckSnippet: '怀表这条线推不动了：是让林警司主动提起，还是让沈砚自己发现停针时刻？' }, 'breakthrough.plan', 'diagnosticPrompts'),
    T('novel_advance_character_arc', { character: '沈砚', arcStage: '触发' }, 'arc.advance', 'recordId'),
    T('novel_mark_chapter_memories_stale', { chapterNo: 1 }, 'memory.mark_stale', 'affected'),
  ]
}

// ─── 执行 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep')
  const tools = collectTools()
  const stamp = Date.now().toString(36)
  const workName = `[audit] 工具体检-${stamp}`

  // create 用不带 workToken 的独立探针（token 还没建立）
  const createTool = tools.get('novel_manage_work')!
  console.log(`[audit] 创建体检作品库：${workName}`)
  const created = await createTool.execute({ action: 'create', name: workName, genre: '类型小说', scale: '中长篇' }, { signal: AbortSignal.timeout(120_000) }) as { baseToken?: string, warnings?: string[] }
  const baseToken = String(created.baseToken ?? '')
  if (baseToken === '') {
    console.error('[audit] ✗ create 未返回 baseToken，中止')
    process.exit(1)
  }
  console.log(`[audit] base=${baseToken}（lark-cli 无法删库，请定期去飞书 UI 清理 [audit] 前缀库）`)
  console.log('[audit] 等待新库写路径收敛...')
  await waitForBaseReady(baseToken)

  const probes = buildPhases(baseToken)
  const results: Result[] = [
    { tool: 'novel_manage_work', label: 'work.create', ok: true, ms: 0, warnings: (created.warnings ?? []).length, detail: `create → ${baseToken}` },
  ]
  const t0 = Date.now()

  for (const p of probes) {
    const tool = tools.get(p.tool)
    if (tool === undefined) {
      results.push({ tool: p.tool, label: p.label ?? p.tool, ok: false, ms: 0, warnings: 0, detail: '未注册' })
      continue
    }
    const started = Date.now()
    try {
      const out = await withConvergenceRetry(() =>
        tool.execute(p.args, { signal: AbortSignal.timeout(120_000) })) as Record<string, unknown>
      const ms = Date.now() - started
      const warnings = Array.isArray(out.warnings) ? out.warnings.length : 0
      const keyOk = p.expectKey === undefined || p.expectKey in out
      results.push({
        tool: p.tool, label: p.label ?? p.tool, ok: keyOk, ms, warnings,
        detail: keyOk ? `${ms}ms${warnings > 0 ? `，${warnings} 条 warnings` : ''}` : `缺期望字段 ${p.expectKey}`,
      })
    } catch (e) {
      results.push({
        tool: p.tool, label: p.label ?? p.tool, ok: false, ms: Date.now() - started, warnings: 0,
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 160),
      })
    }
    const r = results[results.length - 1]!
    console.log(`${r.ok ? '✓' : '✗'} ${r.label} — ${r.detail}`)
  }

  // 汇总
  const failed = results.filter((r) => !r.ok)
  const totalMs = Date.now() - t0
  const byTool = new Map<string, { ok: number; fail: number }>()
  for (const r of results) {
    const e = byTool.get(r.tool) ?? { ok: 0, fail: 0 }
    if (r.ok) e.ok++
    else e.fail++
    byTool.set(r.tool, e)
  }
  const toolCount = byTool.size
  const toolsWithFail = [...byTool.entries()].filter(([, v]) => v.fail > 0)

  console.log('\n════ 体检汇总 ════')
  console.log(`探针 ${results.length} 发：✓ ${results.length - failed.length} / ✗ ${failed.length}；耗时 ${Math.round(totalMs / 1000)}s`)
  console.log(`覆盖工具 ${toolCount}/26${toolsWithFail.length > 0 ? '' : '，全部健康'}`)
  for (const [tool, v] of toolsWithFail) console.log(`  ✗ ${tool}（${v.fail} 失败）`)
  for (const f of failed) console.log(`\n  [${f.label}] ${f.detail}`)

  console.log('<<<TOOL_AUDIT_JSON>>>')
  console.log(JSON.stringify({
    ok: failed.length === 0, baseToken, keep,
    probes: results.length, failed: failed.length, toolsCovered: toolCount,
    results,
  }, null, 2))

  if (!keep && failed.length === 0) {
    console.log('\n[audit] （库已留在飞书，名称带 [audit] 前缀，可在 UI 中批量清理）')
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

await main().catch((e) => {
  console.error(`[audit] 异常退出：${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
