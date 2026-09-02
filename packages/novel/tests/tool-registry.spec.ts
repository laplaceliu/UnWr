/**
 * 工具注册表一致性（纯静态，不碰飞书）：
 *
 *   1. 每个 defineTool 字段齐全（name/description/parameters/output/execute）
 *   2. 工具名全局唯一
 *   3. profiles/web/cordis.patch.yml 里 7 个角色的 toolFilter.allow ⊆ 注册表
 *      ——filter 写错名字 = 该子代理永久 unknown tool（硬失败，无自救）
 *   4. persona 与 WRITING_CONVENTIONS 文案里提到的 novel_* 工具都真实存在
 *      ——提示词承诺了模型就会去调，注册表没有 = 下一轮必炸
 *
 * 背景（实机 2026-09-02 晚）：设定官与起草官各撞一次 unknown tool，
 * 全部是 toolFilter 缺配 + 提示词提及了模型看不见的工具。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.ts'
import { WRITING_CONVENTIONS } from '../src/index.ts'

interface ToolLike {
  name: string
  description?: unknown
  parameters?: unknown
  output?: unknown
  execute?: unknown
}

function collectTools(): Map<string, ToolLike> {
  const tools = new Map<string, ToolLike>()
  apply({
    tools: { register: (t: ToolLike) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  } as never, {})
  return tools
}

const here = dirname(fileURLToPath(import.meta.url))
const patchText = readFileSync(resolve(here, '../../../profiles/web/cordis.patch.yml'), 'utf8')

/** 从 canonical patch 里抓每个角色的 toolFilter.allow 清单。 */
function parseToolFilters(): Map<string, string[]> {
  const out = new Map<string, string>()
  // 按 "- id: unwr-agent-xxx" 分段
  const sections = patchText.split(/(?=^    - id: )/m)
  for (const sec of sections) {
    const id = sec.match(/- id: (unwr-agent-[a-z]+)/)?.[1]
    if (id === undefined) continue
    const allow = [...sec.matchAll(/^\s{12}- (novel_[a-z_]+)\s*$/gm)].map((m) => m[1]!)
    out.set(id, allow)
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...new Set(v)]]))
}

/** 抓 persona 文案里提到的 novel_* 工具名（提示词承诺 = 模型会去调）。 */
function parsePersonaToolMentions(): string[] {
  const text = patchText + WRITING_CONVENTIONS
  const all = [...text.matchAll(/novel_[a-z_]+/g)].map((m) => ({ name: m[0]!, after: text.slice((m.index ?? 0) + m[0]!.length, (m.index ?? 0) + m[0]!.length + 1) }))
  // 尾带 '_' = 族名/前缀引用（novel_manage_、novel_agent_）；
  // 后跟 '/' = 斜杠族名简写（novel_write/revise/manage_*）。都不是具体工具。
  return [...new Set(all.filter((x) => !x.name.endsWith('_') && x.after !== '/').map((x) => x.name))]
}

describe('工具注册表一致性', () => {
  const registry = collectTools()
  const names = [...registry.keys()]

  it('26 个工具全部注册且字段齐全、名字唯一', () => {
    expect(names.length).toBe(26)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      const t = registry.get(name)!
      expect(name, 'name 前缀').toMatch(/^novel_/)
      expect(typeof t.description, `${name}.description`).toBe('string')
      expect(t.parameters, `${name}.parameters`).toBeTruthy()
      expect(t.output, `${name}.output`).toBeTruthy()
      expect(typeof t.execute, `${name}.execute`).toBe('function')
    }
  })

  it('7 个角色的 toolFilter.allow 都指向真实工具（防 permanent unknown tool）', () => {
    const filters = parseToolFilters()
    expect(filters.size).toBe(7)
    for (const [role, allow] of filters) {
      expect(allow.length, `${role} 的 filter 不应为空`).toBeGreaterThan(0)
      const ghost = allow.filter((n) => !registry.has(n))
      expect(ghost, `${role} filter 引用了不存在的工具`).toEqual([])
    }
  })

  it('persona 与写作约定提到的 novel_* 工具都真实存在（防提示词幻影）', () => {
    // patch 层的 7 个 novel_agent_* 委托工具由 dsh-tool-subagent 注册，
    // 不在插件 registry 里——从 patch 的 toolName 字段收集
    const delegationTools = [...new Set(
      [...patchText.matchAll(/toolName: (novel_[a-z_]+)/g)].map((m) => m[1]!),
    )]
    expect(delegationTools.length).toBe(7)
    const valid = new Set([...registry.keys(), ...delegationTools])
    const mentioned = parsePersonaToolMentions()
    expect(mentioned.length).toBeGreaterThanOrEqual(20)
    const ghost = mentioned.filter((n) => !valid.has(n))
    expect(ghost, '提示词承诺了不存在的工具').toEqual([])
  })
})
