/**
 * 编排层一致性测试：cordis.patch.yml ↔ 插件注册表 ↔ 主会话路由表。
 *
 * 为什么必须有：7 个角色的 toolName / persona / toolFilter 定义在 yml，
 * 工具实现在 bundle；dsh-tool-subagent 启动时遇到 allow 里的未知工具名
 * 会直接崩（unknown names fail startup）。此前的防线只有「重启实例才发现」。
 *
 * 同时守住三个契约：
 *   1. 白名单里的每个工具名都必须真实注册（防拼写错 / 改名后漏改 yml）
 *   2. 评审官零写工具（03 文档 §3.7 权限边界）
 *   3. 主会话路由表提到的 novel_agent_* 与 yml 的 toolName 一一对应
 *      （DSH tool-subagent 的 Config 没有 description 字段，路由规则
 *      挂在 persona「何时被委托」+ 主会话 WRITING_CONVENTIONS 两处，
 *      改其一必须同步另一处——见 README「路由契约」）
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, WRITING_CONVENTIONS } from '../src/index.ts'

const YML_PATH = '../../../profiles/web/cordis.patch.yml'

/** yml 中 7 个 agent 块的 id 与期望 toolName。 */
const AGENT_IDS = [
  'worldkeeper', 'characterkeeper', 'outliner', 'drafter', 'reviser', 'critic', 'rescuer',
] as const

const EXPECTED_TOOLNAMES = AGENT_IDS.map((s) => `novel_agent_${s}`)

/** 纯只读工具集合：评审官的 allow 只允许出现在这里（03 文档 §3.7）。 */
const READ_ONLY_TOOLS = new Set([
  'novel_get_review_focus',
  'novel_read_chapter',
  'novel_list_scenes',
  'novel_get_chapter_history',
  'novel_run_consistency_check',
  'novel_get_semantic_check_pack',
  'novel_build_context',
  // 算术验算工具（WRITING_CONVENTIONS 第 14 条）：纯函数，无副作用，不写飞书。
  // 评审官拿到它只为「把验算结果写进报告」，不改正文；改正是改稿官的活。
  // 实机踩坑 2026-09-03：不给工具时评审靠心算报告，可能再次算错。
  'novel_calculate',
])

/** 起草官必须携带的记忆沉淀三件套（G1/G2/G3 的落库能力）。 */
const DRAFTER_REQUIRED = [
  'novel_build_context',
  'novel_write_chapter',
  'novel_append_chapter',
  'novel_update_summary',
  'novel_record_character_state',
  'novel_record_event',
  // 撞上「大纲壳」时要能自己核对章纲与作品上下文，否则只能把整篇正文
  // 以文本形式交回主会话（实机 2026-09-02 第 1 章死锁）。
  'novel_manage_outline',
  // 算术规则（WRITING_CONVENTIONS 第 14 条）：写正文涉及「共/合计/总计/差值」
  // 必调。实机 2026-09-03：drafter filter 里没有就只能自算，必错。
  'novel_calculate',
]

/** 改稿官必携带算术修正工具（算术 bug 闭环修复前提）。 */
const REVISER_REQUIRED = [
  'novel_revise_chapter',
  // 算术闭环：评审回流过来的算式修稿，必须能算正确值再落笔。
  'novel_calculate',
]

/**
 * 每个建设型子代理都应能确认「自己在给哪部作品干活」。
 *
 * 实机踩坑 2026-09-02：大纲官开工前调 novel_manage_work(action=list) 核对
 * 作品，白名单里没有 → `Error: unknown tool "novel_manage_work"`。子代理
 * 继承会话默认作品，但**无法核对**，一旦 prompt 没写全就选错作品。
 */
const WORK_CONTEXT_AGENTS = [
  'unwr-agent-worldkeeper',
  'unwr-agent-characterkeeper',
  'unwr-agent-outliner',
  'unwr-agent-drafter',
]

interface MinimalTool { name: string }

/** 用最小 fake ctx 跑一遍 apply，收集真实注册的工具名。 */
function registeredToolNames(): Set<string> {
  const names = new Set<string>()
  apply(
    {
      tools: { register: (t: MinimalTool) => { names.add(t.name) } },
      systemPrompt: { section: () => {} },
    } as never,
    {},
  )
  return names
}

interface AgentBlock {
  id: string
  toolName?: string
  allow: string[]
  personaTrigger: boolean
  personaReadonlyNote: boolean
}

/**
 * 微型解析器：从 patch yml 里提取 agent 块。
 *
 * 只认本文件用到的形状（id / toolName / allow 内联或多行列表 / persona
 * block scalar），不做通用 YAML。新增无关字段不受影响；allow 列表内的
 * `#` 注释行会被跳过而不是终止列表。
 */
function parseAgentBlocks(yml: string): AgentBlock[] {
  const blocks: AgentBlock[] = []
  let cur: AgentBlock | null = null
  let inAllowList = false
  let inPersona = false

  for (const line of yml.split(/\r?\n/)) {
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      cur = { id: idMatch[1]!, allow: [], personaTrigger: false, personaReadonlyNote: false }
      blocks.push(cur)
      inAllowList = false
      inPersona = false
      continue
    }
    if (cur === null) continue

    const toolNameMatch = /^\s*toolName:\s*(\S+)\s*$/.exec(line)
    if (toolNameMatch) {
      cur.toolName = toolNameMatch[1]
      inAllowList = false
      inPersona = false
      continue
    }

    const inlineAllow = /^\s*allow:\s*\[(.*)\]\s*$/.exec(line)
    if (inlineAllow) {
      cur.allow.push(...inlineAllow[1]!.split(',').map((s) => s.trim()).filter(Boolean))
      inAllowList = false
      inPersona = false
      continue
    }

    if (/^\s*allow:\s*$/.test(line)) {
      inAllowList = true
      inPersona = false
      continue
    }

    if (inAllowList) {
      const item = /^\s+-\s+(\S+)\s*$/.exec(line)
      if (item) {
        cur.allow.push(item[1]!)
        continue
      }
      // 空行 / 注释行不终止列表
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      inAllowList = false
    }

    if (/^\s*persona:\s*\|/.test(line)) {
      inPersona = true
      continue
    }
    if (inPersona) {
      // persona 内容缩进 ≥10 空格；更浅的非空行 = 块结束
      if (/^\s{0,9}\S/.test(line)) {
        inPersona = false
        continue
      }
      if (line.includes('何时被委托')) cur.personaTrigger = true
      if (line.includes('只读约束')) cur.personaReadonlyNote = true
    }
  }

  return blocks
}

const yml = readFileSync(new URL(YML_PATH, import.meta.url), 'utf8')
const allBlocks = parseAgentBlocks(yml)
const agentBlocks = allBlocks.filter((b) => b.id.startsWith('unwr-agent-'))
const TOOLS = registeredToolNames()

describe('cordis.patch.yml ↔ 插件注册表', () => {
  it('7 个角色块齐全，toolName 命名正确', () => {
    expect(agentBlocks.map((b) => b.id)).toEqual(AGENT_IDS.map((s) => `unwr-agent-${s}`))
    expect(agentBlocks.map((b) => b.toolName)).toEqual(EXPECTED_TOOLNAMES)
  })

  it('每个白名单里的工具名都真实注册（unknown names fail startup）', () => {
    for (const b of agentBlocks) {
      expect(b.allow.length, `${b.id} 白名单为空`).toBeGreaterThan(0)
      for (const t of b.allow) {
        expect(TOOLS.has(t), `${b.id} 白名单含未注册工具: ${t}`).toBe(true)
      }
    }
  })

  it('白名单无重复项', () => {
    for (const b of agentBlocks) {
      expect(new Set(b.allow).size, `${b.id} 白名单有重复`).toBe(b.allow.length)
    }
  })

  it('评审官零写工具：allow ⊆ 只读集合（§3.7 权限边界）', () => {
    const critic = agentBlocks.find((b) => b.id === 'unwr-agent-critic')
    expect(critic).toBeDefined()
    for (const t of critic?.allow ?? []) {
      expect(READ_ONLY_TOOLS.has(t), `评审官不应持有: ${t}`).toBe(true)
    }
  })

  it('起草官白名单含记忆沉淀三件套（G1/G2/G3 落库能力）', () => {
    const drafter = agentBlocks.find((b) => b.id === 'unwr-agent-drafter')
    expect(drafter?.allow ?? []).toEqual(expect.arrayContaining(DRAFTER_REQUIRED))
  })

  it('改稿官白名单含算术修正工具（算术 bug 闭环修复前提）', () => {
    const reviser = agentBlocks.find((b) => b.id === 'unwr-agent-reviser')
    expect(reviser?.allow ?? []).toEqual(expect.arrayContaining(REVISER_REQUIRED))
  })

  it('改稿官/救援官拿 manage_character 时 persona 必须带只读约束', () => {
    for (const id of ['unwr-agent-reviser', 'unwr-agent-rescuer']) {
      const b = agentBlocks.find((x) => x.id === id)
      expect(b).toBeDefined()
      if (b?.allow.includes('novel_manage_character')) {
        expect(b.personaReadonlyNote, `${id} 持有 manage_character 但 persona 无只读约束`).toBe(true)
      }
    }
  })

  it('建设型角色都能确认作品上下文（防 unknown tool "novel_manage_work"）', () => {
    for (const id of WORK_CONTEXT_AGENTS) {
      const b = agentBlocks.find((x) => x.id === id)
      expect(b, `${id} 缺失`).toBeDefined()
      // 拿得到工具才能核对作品；同时 persona 必须把它限成只读
      expect(b?.allow ?? [], `${id} 白名单缺 novel_manage_work`).toContain('novel_manage_work')
      expect(b?.personaReadonlyNote, `${id} 持有 manage_work 但 persona 无只读约束`).toBe(true)
    }
  })

  it('起草官能自己核对章纲（章壳死锁的自救前提）', () => {
    const drafter = agentBlocks.find((b) => b.id === 'unwr-agent-drafter')
    expect(drafter?.allow ?? []).toContain('novel_manage_outline')
    expect(drafter?.personaReadonlyNote).toBe(true)
  })
})

describe('路由契约（两份载体缺一不可）', () => {
  it('每个 persona 都有「何时被委托」', () => {
    for (const b of agentBlocks) {
      expect(b.personaTrigger, `${b.id} persona 缺「何时被委托」`).toBe(true)
    }
  })

  it('主会话路由表提到的 novel_agent_* 与 yml toolName 一一对应', () => {
    const mentioned = [...new Set(WRITING_CONVENTIONS.match(/novel_agent_[a-z]+/g) ?? [])]
    expect(mentioned.sort()).toEqual(EXPECTED_TOOLNAMES.slice().sort())
  })
})

describe('隐私红线（memory 78207951 复检）', () => {
  it('yml 不含个人 home 路径', () => {
    expect(yml).not.toContain('/home/')
  })
})
