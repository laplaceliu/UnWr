/* ============================================================
 * UnWr 工作台前端（无构建、无依赖）
 * 路由：#/ S0 总览 · #/w/{token}/write|agents|checks|memory
 * ============================================================ */
'use strict'

/* ---------------- 工具 ---------------- */
const $ = (sel, el = document) => el.querySelector(sel)
const main = $('#main')

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN')

async function api(path, opts = {}) {
  // /api 被 dsh-client-connection 保留，工作台 API 统一挂在 /workbench/api 下
  const res = await fetch('/workbench/api' + path, {
    method: opts.method ?? 'GET',
    ...(opts.body !== undefined ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
    } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

let toastTimer
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 1800)
}

function copyText(text) {
  navigator.clipboard.writeText(text)
    .then(() => toast('已复制到剪贴板'))
    .catch(() => toast('复制失败，请手动选择文本'))
}

/* 正文 markdown-lite：约定 ## 为场景标题，无一级标题 */
function proseHtml(md) {
  const lines = String(md || '').split(/\r?\n/)
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  let html = ''
  let para = []
  const flush = () => {
    if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = [] }
  }
  for (const line of lines) {
    const t = line.trim()
    if (t === '') { flush(); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      flush()
      const lvl = h[1].length === 2 ? 2 : 3
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`
      continue
    }
    para.push(line)
  }
  flush()
  return html || '<p class="no-indent">（正文为空——该章尚未起草，或文档未挂接。可在 DSH 会话委托起草官生成。）</p>'
}

/* 值渲染：飞书 link/select 常为数组 */
const cell = (v) => Array.isArray(v) ? v.map(esc).join('、') : esc(v)

const STATUS_DOT = { '大纲': 'outline', '草稿': 'draft', '修订': 'revising', '定稿': 'final' }
const STATUS_CLS = { '大纲': 'gray', '草稿': 'amber', '修订': 'indigo', '定稿': 'jade' }

/* ---------------- 全局状态 ---------------- */
const state = { works: [], workToken: null, config: null }

async function loadWorks() {
  state.works = await api('/works')
  const sel = $('#work-switch')
  sel.innerHTML = state.works.length === 0
    ? '<option value="">（暂无作品）</option>'
    : state.works.map((w) =>
      `<option value="${esc(w.baseToken)}">${esc(w.name)}</option>`).join('')
  if (state.workToken) sel.value = state.workToken
  sel.onchange = () => {
    if (sel.value) location.hash = `#/w/${sel.value}/write`
  }
}

function setNav(token, view) {
  const nav = $('#sidenav')
  nav.hidden = false
  document.body.classList.add('has-nav')
  for (const a of nav.querySelectorAll('a')) {
    a.href = `#/w/${token}/${a.dataset.nav}`
    a.classList.toggle('active', a.dataset.nav === view)
  }
}

async function useWork(token) {
  if (state.workToken !== token || !state.config) {
    state.workToken = token
    state.config = await api(`/works/${token}/config`)
    const w = state.works.find((x) => x.baseToken === token)
    if (w && state.config.name && w.name !== state.config.name) w.name = state.config.name
    $('#work-switch').value = token
  }
}

function banner(e) {
  return `<div class="error-banner">✕ ${esc(e.message ?? e)}<div class="small muted" style="margin-top:4px">请确认 lark-cli 已登录（终端执行 lark-cli auth status），且该作品库可访问。</div></div>`
}

/* ---------------- S0 作品总览 ---------------- */
async function viewWorks() {
  $('#sidenav').hidden = true
  document.body.classList.remove('has-nav')
  main.innerHTML = '<div class="boot"><span class="spin"></span> 正在扫描云盘作品…</div>'
  try {
    if (state.works.length === 0) await loadWorks()
    const cards = state.works.map((w) => {
      const progress = w.targetWords > 0 && w.currentChapter > 0
        ? `<div class="progress"><i style="width:${Math.min(96, w.currentChapter * 4)}%"></i></div>
           <div class="progress-row"><span>进行到第 ${w.currentChapter} 章</span><span>目标 ${fmtN(w.targetWords)} 字</span></div>`
        : `<div class="progress-row"><span>${w.currentChapter > 0 ? `进行到第 ${w.currentChapter} 章` : '尚未开始'}</span></div>`
      const meta = [
        w.genre ? `<span class="badge red">${esc(w.genre)}</span>` : '',
        w.subgenre ? `<span class="badge gray">${esc(w.subgenre)}</span>` : '',
        w.mode ? `<span class="badge indigo">${esc(w.mode)}</span>` : '',
      ].join('')
      return `<div class="card work-card" data-token="${esc(w.baseToken)}">
        <h3>${esc(w.name)}</h3>
        <div class="work-meta">${meta}</div>
        ${progress}
      </div>`
    }).join('')
    main.innerHTML = `
      <h1 class="h-page">作品总览 <span class="sub">一部作品 = 一个多维表格 + 一个云盘目录</span></h1>
      ${state.works.length === 0
        ? `<div class="empty">云盘里还没有 UnWr 作品。<br><br><button class="btn primary" onclick="openNewWork()">＋ 新建第一部作品</button></div>`
        : `<div class="works-grid">${cards}</div>`}`
    for (const el of main.querySelectorAll('.work-card')) {
      el.onclick = () => { location.hash = `#/w/${el.dataset.token}/write` }
    }
  } catch (e) {
    main.innerHTML = banner(e)
  }
}

/* ---------------- S1 写作台 ---------------- */
async function viewWrite(token, qs) {
  try {
    await useWork(token)
    const cfg = state.config
    const chFromQs = Number(new URLSearchParams(qs).get('ch'))
    main.innerHTML = `
      <h1 class="h-page">${esc(cfg.name)} · 写作台
        <span class="sub">${esc([cfg.genre, cfg.subgenre, cfg.scale].filter(Boolean).join(' / '))}</span></h1>
      <div class="write-grid">
        <div class="card toc-panel" id="toc"><div class="boot small">载入目录…</div></div>
        <div class="card reader" id="reader"><div class="boot">载入章节…</div></div>
        <div class="card ctx-panel" id="ctx"><div class="boot small">载入上下文…</div></div>
      </div>`

    const { volumes, chapters } = await api(`/works/${token}/outline`)
    renderToc(volumes, chapters, chFromQs || cfg.currentChapter || chapters[0]?.no || 1)

    const tabs = initCtxTabs(token)
    await Promise.all([
      loadChapter(token, chFromQs || cfg.currentChapter || chapters[0]?.no || 1, tabs.refresh),
      tabs.refresh(chFromQs || cfg.currentChapter || chapters[0]?.no || 1),
    ])
  } catch (e) {
    main.innerHTML = banner(e)
  }
}

function renderToc(volumes, chapters, activeNo) {
  const groups = new Map()
  for (const v of [...volumes].sort((a, b) => (a['卷序'] ?? 0) - (b['卷序'] ?? 0))) {
    groups.set(v['卷名'] ?? '', [])
  }
  for (const c of chapters) {
    const key = groups.has(c.volume) ? c.volume : (groups.get('') ? '' : [...groups.keys()][0] ?? '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const volOrder = new Map(volumes.map((v, i) => [v['卷名'] ?? '', v['卷序'] ?? i]))
  const sorted = [...groups.entries()].sort((a, b) => (volOrder.get(a[0]) ?? 999) - (volOrder.get(b[0]) ?? 999))
  $('#toc').innerHTML = sorted.map(([vol, chs]) => `
    <div class="toc-vol">${esc(vol || '未分卷')}</div>
    ${chs.map((c) => `
      <div class="toc-ch ${c.no === activeNo ? 'active' : ''}" data-no="${c.no}">
        <span class="dot ${STATUS_DOT[c.status] ?? 'outline'}"></span>
        <span>第${c.no}章 ${esc(c.title || '')}</span>
        <span class="words">${c.words > 0 ? fmtN(c.words) : ''}</span>
      </div>`).join('')}`).join('')
  for (const el of $('#toc').querySelectorAll('.toc-ch')) {
    el.onclick = () => {
      const no = Number(el.dataset.no)
      $('#toc').querySelectorAll('.toc-ch').forEach((x) => x.classList.toggle('active', x === el))
      loadChapter(state.workToken, no, window.__ctxRefresh)
      window.__ctxRefresh(no)
    }
  }
}

async function loadChapter(token, no, ctxRefresh) {
  window.__ctxRefresh = ctxRefresh
  const reader = $('#reader')
  reader.innerHTML = '<div class="boot">载入章节…</div>'
  try {
    const c = await api(`/works/${token}/chapters/${no}?scenes=1`)
    const statusSel = Object.keys(STATUS_DOT).map((s) =>
      `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')
    reader.innerHTML = `
      <div class="reader-head">
        <h2>第${c.no}章 ${esc(c.title || '')}</h2>
        <div class="reader-toolbar">
          <span class="badge ${STATUS_CLS[c.status] ?? 'gray'}">${esc(c.status || '大纲')}</span>
          <select id="ch-status" class="work-switch small" title="流转章节状态">${statusSel}</select>
          <button class="btn ghost small" id="btn-history">版本</button>
        </div>
      </div>
      <div class="small muted">
        ${c.words > 0 ? `${fmtN(c.words)} 字 · ` : ''}
        ${c.storyTime ? `故事时间 ${esc(c.storyTime)} · ` : ''}
        ${c.tension > 0 ? `张力 ${c.tension}/5 · ` : ''}
        ${c.cast?.length ? `出场：${c.cast.map(esc).join('、')}` : ''}
      </div>
      ${c.outline ? `<div class="guide-box" style="margin-top:10px"><b>章纲</b> ${esc(c.outline)}</div>` : ''}
      <div class="prose">${proseHtml(c.content)}</div>`
    $('#ch-status').onchange = async (ev) => {
      try {
        await api(`/works/${token}/chapters/${no}`, { method: 'PATCH', body: { status: ev.target.value } })
        toast(`第${no}章 → ${ev.target.value}`)
        const { chapters } = await api(`/works/${token}/outline`)
        const cur = chapters.find((x) => x.no === no)
        if (cur) {
          cur.status = ev.target.value
          renderTocFromCache(chapters, no)
        }
      } catch (e) { toast(e.message) }
    }
    $('#btn-history').onclick = () => showHistory(token, no)
  } catch (e) {
    reader.innerHTML = banner(e)
  }
}

async function renderTocFromCache(chapters, activeNo) {
  // 仅更新圆点与激活态，避免整树重绘丢失滚动位置
  for (const el of $('#toc').querySelectorAll('.toc-ch')) {
    const c = chapters.find((x) => x.no === Number(el.dataset.no))
    if (c) el.querySelector('.dot').className = `dot ${STATUS_DOT[c.status] ?? 'outline'}`
  }
}

async function showHistory(token, no) {
  try {
    const h = await api(`/works/${token}/chapters/${no}?history=1`)
    openModal('版本历史', `
      ${h.entries.length === 0 ? '<div class="muted small">暂无历史版本。</div>' : `
      <table class="data-table"><thead><tr><th>版本</th><th>时间</th></tr></thead>
      <tbody>${h.entries.map((e) => `<tr><td>r${e.revisionId}</td><td>${esc(e.editTime)}</td></tr>`).join('')}</tbody></table>`}`)
  } catch (e) { toast(e.message) }
}

function initCtxTabs(token) {
  const ctx = $('#ctx')
  const TABS = [
    ['guide', '题材指引'], ['outline', '章纲'], ['states', '人物状态'],
    ['settings', '相关设定'], ['foreshadow', '伏笔'], ['memory', '记忆'],
  ]
  ctx.innerHTML = `
    <div class="ctx-tabs">${TABS.map(([k, label], i) =>
      `<button data-k="${k}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div class="ctx-body" id="ctx-body"><div class="boot small">载入上下文…</div></div>`
  let cur = 'guide'
  let digest = null
  async function refresh(no) {
    const body = $('#ctx-body')
    body.innerHTML = '<div class="boot small">载入上下文…</div>'
    try {
      digest = await api(`/works/${token}/context/${no}`)
      renderTab()
    } catch (e) {
      body.innerHTML = `<div class="small" style="color:var(--cinnabar)">${esc(e.message)}</div>`
    }
  }
  function renderTab() {
    const body = $('#ctx-body')
    const d = digest
    if (cur === 'guide') {
      body.innerHTML = `<div class="guide-box">${esc(d.writingGuide)}</div>
        <div class="small muted" style="margin-top:8px">上下文估算 ${fmtN(d.estimatedTokens)} tokens · 近距完整章 ${d.recentFullChapters} 章</div>`
    } else if (cur === 'outline') {
      body.innerHTML = d.outline
        ? `<div class="ctx-item">${esc(d.outline)}</div>`
        : '<div class="muted small">本章暂无章纲。可委托大纲官补齐。</div>'
    } else if (cur === 'states') {
      body.innerHTML = d.characterStates.length === 0
        ? '<div class="muted small">尚无人物状态快照。起草官写完一章后会自动沉淀。</div>'
        : d.characterStates.map((s) => `<div class="ctx-item"><b>${esc(s.name)}</b><br>${esc(s.summary)}</div>`).join('')
    } else if (cur === 'settings') {
      body.innerHTML = d.relevantSettings.length === 0
        ? '<div class="muted small">本章没有命中相关设定。</div>'
        : d.relevantSettings.map((s) => `<div class="ctx-item"><b>${esc(s.term)}</b><span class="imp">重要度 ${s.importance}</span><br>${esc(s.definition)}</div>`).join('')
    } else if (cur === 'foreshadow') {
      body.innerHTML = d.openForeshadows.length === 0
        ? '<div class="muted small">没有未回收伏笔。</div>'
        : d.openForeshadows.map((f) => `<div class="ctx-item"><b>${esc(f.plantedIn)}</b> <span class="imp">重要度 ${f.importance}</span><br>${esc(f.content)}</div>`).join('')
    } else if (cur === 'memory') {
      body.innerHTML = `
        <div class="small muted">章节摘要（L1）${d.chapterSummaries.length} 条 · 卷/全书（L2）${d.bookSummaries.length} 条</div>
        ${d.chapterSummaries.slice(-4).map((s) => `<div class="ctx-item"><b>第${s.no}章 ${esc(s.title)}</b><br>${esc(s.summary)}</div>`).join('')}
        ${d.bookSummaries.map((s) => `<div class="ctx-item"><b>【${esc(s.level)}】${esc(s.title)}</b><br>${esc(s.content)}</div>`).join('')}`
    }
  }
  for (const btn of ctx.querySelectorAll('.ctx-tabs button')) {
    btn.onclick = () => {
      cur = btn.dataset.k
      ctx.querySelectorAll('.ctx-tabs button').forEach((b) => b.classList.toggle('active', b === btn))
      renderTab()
    }
  }
  return { refresh }
}

/* ---------------- S2 智能体 ---------------- */
const ROLE_CN = {
  worldkeeper: '世界观设定官', characterkeeper: '人物官', outliner: '大纲官',
  drafter: '起草官', reviser: '改稿官', critic: '评审官', rescuer: '卡文救援官',
}
const WRITE_RE = /novel_(manage_(character|character_state|setting|outline|foreshadow|plotline|branch|relation|work)|write_chapter|append_chapter|revise_chapter|update_summary|record_character_state|record_event|mark_chapter_memories_stale|breakthrough_planning|advance_character_arc|record_chapter_tension)/

function personaLine(persona, key) {
  const m = new RegExp(`${key}：(.*)`).exec(persona)
  return m ? m[1].trim() : ''
}

async function viewAgents(token) {
  try {
    await useWork(token)
    main.innerHTML = '<div class="boot"><span class="spin"></span> 载入角色矩阵…</div>'
    const [agents] = await Promise.all([api('/agents')])
    const cards = [{ id: 'orchestrator', toolName: '（主会话本身）', allow: [], persona: '' }]
      .concat(agents)
      .map((a) => {
        const isMain = a.id === 'orchestrator'
        const cn = isMain ? '主编排官' : (ROLE_CN[a.id.replace('unwr-agent-', '')] ?? a.id)
        const duty = isMain
          ? '最高频入口：先查路由表再审意图，把复杂写作任务委托给对应角色子代理；简单查询与单条 upsert 直接调工具。'
          : personaLine(a.persona, '职责').split('；')[0] || personaLine(a.persona, '职责')
        const when = isMain
          ? '默认入口，常驻主会话。'
          : personaLine(a.persona, '何时被委托') || '（见角色提示词）'
        const chips = a.allow.map((t) =>
          `<span class="chip ${WRITE_RE.test(t) ? 'write' : ''}">${esc(t.replace('novel_', ''))}</span>`).join('')
        const stamp = a.id === 'unwr-agent-critic'
          ? '<span class="stamp">零写工具</span>'
          : (a.persona.includes('只读约束') ? '<span class="stamp jade">写权限受限</span>' : '')
        return `<div class="card agent-card">
          <h3>${esc(cn)} <span class="role-sub">${esc(isMain ? '主会话' : a.toolName)}</span> ${stamp}</h3>
          <div class="agent-sec"><div class="label">何时被委托</div>${esc(when)}</div>
          <div class="agent-sec"><div class="label">职责</div>${esc(duty)}</div>
          ${a.allow.length ? `<div class="agent-sec"><div class="label">工具白名单（toolFilter 硬约束）</div><div class="chips">${chips}</div></div>` : ''}
        </div>`
      }).join('')
    main.innerHTML = `
      <h1 class="h-page">智能体矩阵 <span class="sub">主编排官 + 7 角色子代理 · 白名单即权限（03 文档 §二/§三）</span></h1>
      <div class="agent-grid">${cards}</div>
      <div class="card delegator card-pad">
        <h3 class="h-block" style="font-size:17px">委托指令生成器</h3>
        <div class="small muted">子代理是全新会话，看不到主对话——生成的指令自带作品 / 章节 / 作用域（对齐主会话约定第 5 条）。复制后粘贴到 DSH 会话即可。</div>
        <div class="delegator-grid">
          <div>
            <div class="field"><label>角色</label>
              <select id="dg-role">${Object.entries(ROLE_CN).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
            <div class="field"><label>章节号</label><input id="dg-ch" type="number" min="1" value="${state.config.currentChapter || 1}"></div>
            <div class="field"><label>作用域（可选）</label><input id="dg-scope" placeholder="如：第二场 对白 / 全章"></div>
          </div>
          <div>
            <div class="field"><label>任务指令</label>
              <textarea id="dg-task" placeholder="如：把对白改冷峻些，保留悬念，不动旁白"></textarea></div>
            <output id="dg-out"></output>
            <div style="display:flex;gap:10px;margin-top:10px">
              <button class="btn primary" id="dg-copy">复制指令</button>
              <button class="btn ghost" id="dg-go">在 DSH 打开 ↗</button>
            </div>
          </div>
        </div>
      </div>`
    const gen = () => {
      const role = $('#dg-role').value
      const ch = $('#dg-ch').value || '1'
      const scope = $('#dg-scope').value.trim()
      const task = $('#dg-task').value.trim() || '（在此填写任务）'
      $('#dg-out').textContent =
        `@${ROLE_CN[role]}\n作品：《${state.config.name}》 base_token: ${token}\n目标章节：第 ${ch} 章\n作用域：${scope || '全章'}\n任务：${task}\n（上下文可先用 novel_build_context(chapterNo=${ch}) 组装）`
    }
    for (const id of ['dg-role', 'dg-ch', 'dg-scope', 'dg-task']) {
      $(`#${id}`).addEventListener('input', gen)
    }
    gen()
    $('#dg-copy').onclick = () => copyText($('#dg-out').textContent)
    $('#dg-go').onclick = () => window.open('http://localhost:3080', '_blank')
  } catch (e) {
    main.innerHTML = banner(e)
  }
}

/* ---------------- S3 一致性检查 ---------------- */
async function viewChecks(token) {
  try {
    await useWork(token)
    const cfg = state.config
    const f = cfg.reviewFocus
    const maxW = Math.max(...f.weights.map((w) => w.weight), 0.01)
    main.innerHTML = `
      <h1 class="h-page">一致性检查 <span class="sub">规则型查表 · 语义型备料（README §一致性检查）</span></h1>
      <div class="focus-banner">
        <div class="card card-pad">
          <div class="h-block">题材评审重点 <span class="badge red">${esc(f.presetName)}</span></div>
          <div class="small" style="max-width:420px">${esc(f.genreFocus)}</div>
          <div class="small muted" style="margin-top:8px">阻断阈值：严重度 ≥ <b>${f.blockingThreshold}</b> 视为可能阻断定稿</div>
        </div>
        <div class="card card-pad" style="max-width:380px">
          <div class="h-block">检查权重（w_*）</div>
          <div class="weight-bars">
            ${f.weights.map((w) => `<div class="weight-row"><span class="name">${esc(w.label)}</span><span class="bar"><i style="width:${Math.round(w.weight / maxW * 100)}%"></i></span><span class="val">${w.weight.toFixed(2)}</span></div>`).join('')}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin:18px 0 4px">
        <button class="btn cinnabar" id="btn-run">◎ 运行规则检查</button>
        <button class="btn ghost" id="btn-semantic">语义检查清单</button>
        <button class="btn ghost" id="btn-foreshadow">伏笔回收追踪</button>
      </div>
      <div id="check-result"></div>`
    $('#btn-run').onclick = () => runChecks(token)
    $('#btn-semantic').onclick = () => showChecklist()
    $('#btn-foreshadow').onclick = () => showForeshadowWatch(token)
    if (cfg.currentChapter > 0) runChecks(token)
  } catch (e) {
    main.innerHTML = banner(e)
  }
}

async function runChecks(token) {
  const box = $('#check-result')
  box.innerHTML = '<div class="boot"><span class="spin"></span> 查表比对中…</div>'
  try {
    const r = await api(`/works/${token}/checks?currentChapterNo=${state.config.currentChapter || 1}`)
    const sevCls = (s) => `sev-${Math.min(5, Math.max(1, s))}`
    box.innerHTML = `
      ${r.skippedTables.length ? `<div class="small muted" style="margin:8px 0">跳过缺表：${r.skippedTables.map(esc).join('、')}</div>` : ''}
      ${r.total === 0
        ? '<div class="empty">✓ 规则型检查全部通过（伏笔时限 / 方位连续性 / 伤势恢复 / 事件时序）。</div>'
        : `<div class="small muted" style="margin:4px 0 2px">共 ${r.total} 条 · 可能阻断定稿 ${r.blocking} 条（阈值 ${r.blockingThreshold}）</div>
           <div class="issue-list">${r.issues.map((i) => `
             <div class="card issue">
               <span class="sev ${sevCls(i.severity)}">${i.severity}</span>
               <div><h4>${esc(i.title)}</h4>
                 <div class="loc">${esc(i.location ?? '')}${i.confidence !== undefined ? ` · 置信度 ${Math.round(i.confidence * 100)}%` : ''}</div>
               </div>
             </div>`).join('')}</div>`}`
  } catch (e) {
    box.innerHTML = banner(e)
  }
}

function showChecklist() {
  const f = state.config.reviewFocus
  openModal('语义型检查清单（评审官）', `
    <div class="small muted" style="margin-bottom:8px">权重随题材实时渲染（novel_get_review_focus）；材料由 novel_get_semantic_check_pack 备齐，判断由模型做出。</div>
    <ul class="checklist">${f.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`)
}

async function showForeshadowWatch(token) {
  try {
    const list = await api(`/works/${token}/table/foreshadows`)
    const cur = state.config.currentChapter || 0
    const open = list.filter((r) => (r['状态'] ?? '已埋设') === '已埋设')
    const rows = open.map((r) => {
      const plan = Number(r['计划回收章节'] ?? 0)
      const overdue = cur > 0 && plan > 0 && plan < cur
      return `<tr>
        <td style="max-width:280px">${cell(r['伏笔内容'])}</td>
        <td>${r['埋设章节'] ?? '—'}</td>
        <td>${plan || '—'}</td>
        <td>${overdue ? '<span class="badge red">已逾期</span>' : '<span class="badge jade">在窗口内</span>'}</td>
      </tr>`
    }).join('')
    openModal(`伏笔回收追踪（未回收 ${open.length} 条）`, `
      ${open.length === 0 ? '<div class="muted small">没有未回收伏笔。</div>' : `
      <table class="data-table"><thead><tr><th>伏笔</th><th>埋设</th><th>计划回收</th><th>时限</th></tr></thead>
      <tbody>${rows}</tbody></table>`}`)
  } catch (e) { toast(e.message) }
}

/* ---------------- S4 记忆与数据 ---------------- */
const MEM_TABS = [
  ['settings', '设定'], ['characters', '人物'], ['relations', '关系'], ['plotlines', '剧情线'],
  ['foreshadows', '伏笔'], ['events', '事件'], ['memory', '记忆索引'],
  ['branches', '候选分支'], ['states', '人物状态时间线'],
]

async function viewMemory(token) {
  try {
    await useWork(token)
    main.innerHTML = `
      <h1 class="h-page">记忆与数据 <span class="sub">飞书为 source of truth · 本页只读（03 文档 §1.4）</span></h1>
      <div class="mem-tabs">${MEM_TABS.map(([k, label], i) =>
        `<button data-k="${k}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('')}</div>
      <div id="mem-body" class="card card-pad" style="overflow:auto"><div class="boot small">载入…</div></div>`
    let cur = 'settings'
    async function load(view) {
      const body = $('#mem-body')
      body.innerHTML = '<div class="boot small">载入…</div>'
      try {
        const list = await api(`/works/${token}/table/${view}`)
        if (view === 'states') { body.innerHTML = statesTimeline(list); return }
        body.innerHTML = list.length === 0
          ? '<div class="empty">这张表还没有数据。结构化写入由各角色子代理在 DSH 会话中完成。</div>'
          : tableHtml(list)
      } catch (e) {
        body.innerHTML = banner(e)
      }
    }
    for (const btn of $('.mem-tabs').querySelectorAll('button')) {
      btn.onclick = () => {
        cur = btn.dataset.k
        $('.mem-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn))
        load(cur)
      }
    }
    load(cur)
  } catch (e) {
    main.innerHTML = banner(e)
  }
}

function tableHtml(list) {
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))].filter((k) => k !== '__recordId')
  return `<table class="data-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${list.map((r) => `<tr>${cols.map((c) => {
      const v = r[c]
      const text = Array.isArray(v) ? v.map(cell).join('、') : cell(v)
      const isStale = c === '是否已过期' && (v === true || v === '是')
      return `<td ${String(text).length > 42 ? `title="${text}"` : ''}>${isStale ? '<span class="stale-mark">已过期 · 需重生成</span>' : (String(text).length > 120 ? esc(String(text).slice(0, 120)) + '…' : text)}</td>`
    }).join('')}</tr>`).join('')}</tbody></table>`
}

function statesTimeline(list) {
  const byChar = new Map()
  for (const s of list) {
    const name = Array.isArray(s['人物']) ? s['人物'][0] : (s['人物'] ?? '未名')
    if (!byChar.has(name)) byChar.set(name, [])
    byChar.get(name).push(s)
  }
  return [...byChar.entries()].map(([name, items]) => `
    <div style="margin-bottom:22px">
      <div class="h-block">${esc(name)} <span class="badge gray">${items.length} 条快照</span></div>
      <div class="tl">${items.sort((a, b) => (a['章节'] ?? 0) - (b['章节'] ?? 0)).map((s) => `
        <div class="tl-item">
          <b>第${s['章节'] ?? '?'}章</b>
          <span class="small muted">${esc([s['所在位置'], s['情绪状态']].filter(Boolean).map(cell).join(' · '))}</span>
          ${s['是否已过期'] === true ? '<span class="stale-mark">已过期</span>' : ''}
          <div class="small">${esc(cell(s['状态摘要']))}</div>
        </div>`).join('')}</div>
    </div>`).join('') || '<div class="empty">尚无人物状态快照。</div>'
}

/* ---------------- 模态 / 新建作品 ---------------- */
function openModal(title, bodyHtml) {
  $('#modal-root').innerHTML = `
    <div class="modal-mask" id="mask">
      <div class="card modal">
        <h3>${esc(title)}</h3>
        ${bodyHtml}
        <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">关闭</button></div>
      </div>
    </div>`
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') closeModal() }
}
function closeModal() { $('#modal-root').innerHTML = '' }

function openNewWork() {
  openModal('新建作品', `
    <div class="field"><label>作品名 *</label><input id="nw-name" placeholder="如：山河逆旅"></div>
    <div class="field"><label>题材</label><select id="nw-genre">
      <option>网文</option><option>类型小说</option><option>纯文学</option></select></div>
    <div class="field"><label>子题材</label><input id="nw-sub" placeholder="如：东方玄幻 / 推理 / 城市散文"></div>
    <div class="field"><label>规模档位</label><select id="nw-scale">
      <option>短篇</option><option>中篇</option><option selected>长篇</option><option>超长篇</option></select></div>
    <div class="field"><label>目标字数</label><input id="nw-target" type="number" min="0" step="10000" placeholder="800000"></div>
    <div class="field"><label>写作模式</label><select id="nw-mode">
      <option>协作助手</option><option>全自动</option><option>教练评审</option><option>协作+自动</option></select></div>
    <div class="field"><label>叙事视角</label><input id="nw-pov" placeholder="如：第三人称单视角（可留空）"></div>
    <div class="small muted">将创建：云盘目录《作品名》/ + 多维表格（13 表）+ 作品元信息。</div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">取消</button>
      <button class="btn cinnabar" id="nw-go">创建</button>
    </div>`)
  $('#nw-go').onclick = async () => {
    const name = $('#nw-name').value.trim()
    if (!name) { toast('请填写作品名'); return }
    try {
      $('#nw-go').disabled = true
      $('#nw-go').textContent = '建库中…（约 20 秒）'
      await api('/works', {
        method: 'POST',
        body: {
          name,
          genre: $('#nw-genre').value,
          subgenre: $('#nw-sub').value.trim(),
          scale: $('#nw-scale').value,
          targetWords: Number($('#nw-target').value) || 0,
          mode: $('#nw-mode').value,
          pov: $('#nw-pov').value.trim(),
        },
      })
      closeModal()
      state.works = []
      toast('作品已创建')
      location.hash = '#/'
      viewWorks()
    } catch (e) {
      $('#nw-go').disabled = false
      $('#nw-go').textContent = '创建'
      toast(e.message)
    }
  }
}
window.openNewWork = openNewWork
window.closeModal = closeModal

/* ---------------- 路由 ---------------- */
async function render() {
  const h = location.hash.slice(1) || '/'
  if (h === '/') { await viewWorks(); return }
  const m = /^\/w\/([^/]+)\/(\w+)(?:\?(.*))?$/.exec(h)
  if (!m) { location.hash = '#/'; return }
  const [, token, view, qs] = m
  setNav(token, view)
  if (view === 'write') await viewWrite(token, qs)
  else if (view === 'agents') await viewAgents(token)
  else if (view === 'checks') await viewChecks(token)
  else if (view === 'memory') await viewMemory(token)
  else location.hash = '#/'
}

window.addEventListener('hashchange', render)
render().catch((e) => { main.innerHTML = banner(e) })
