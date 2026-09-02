/**
 * 工具 schema 不变量测试。
 *
 * 背景（实机踩坑 2026-09-02）：novel_manage_foreshadow 曾把 content 声明为
 * 无条件 required，导致 {"action":"query"} 在 schema 校验阶段就被拒
 * （missing required property "content"），永远到不了 execute 的 query 分支。
 * DSH 校验发生在 execute 之前（ToolArgsError → "invalid arguments: ..."），
 * 而"仅 upsert 必填"无法用平铺的 per-field required 表达——正确姿势是
 * schema 只约束 action 本身，动作级必填由 execute 的运行时守卫给出
 * 带动作名的错误。
 *
 * 注册对象的 parameters 是编译后的 JSON Schema：
 *   { type:'object', properties:{...}, required: string[] }
 * 不变量：凡 properties.action.enum 含 'query' 的工具，编译后的
 * required 数组必须恰好是 ['action']。
 * 这条规则一次性覆盖全部 novel_manage_* 工具，新增工具自动纳管。
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface CompiledParamSchema {
  type: 'object'
  properties: Record<string, { description?: string; enum?: string[] }>
  required?: string[]
}

interface RegisteredTool {
  name: string
  parameters: CompiledParamSchema
}

/** 用最小 fake ctx 跑 apply，捕获完整工具对象（含编译后的 parameters）。 */
function collectTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  apply(
    {
      tools: { register: (t: RegisteredTool) => { tools.push(t) } },
      systemPrompt: { section: () => {} },
    } as never,
    {},
  )
  return tools
}

const TOOLS = collectTools()

describe('工具 schema 不变量', () => {
  it('apply 注册了全部领域工具', () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(25)
  })

  it('action 枚举含 query 的工具：编译后 required 只允许 action', () => {
    const checked: string[] = []
    for (const t of TOOLS) {
      const params = t.parameters
      const actionEnum = params?.properties?.['action']?.enum
      if (actionEnum === undefined || !actionEnum.includes('query')) continue
      checked.push(t.name)
      expect(params.required, `${t.name} 的 query 动作会被 schema required 拦死`)
        .toEqual(['action'])
    }
    // 防空转：必须真的覆盖到了 manage_* 家族
    expect(checked).toEqual(expect.arrayContaining([
      'novel_manage_setting',
      'novel_manage_character',
      'novel_manage_foreshadow',
      'novel_manage_plotline',
      'novel_manage_branch',
      'novel_manage_relation',
    ]))
  })

  it('被修复的 5 个字段不再编译进 required，且描述保留 upsert 必填说明', () => {
    const cases: [string, string][] = [
      ['novel_manage_setting', 'term'],
      ['novel_manage_character', 'name'],
      ['novel_manage_foreshadow', 'content'],
      ['novel_manage_plotline', 'name'],
      ['novel_manage_branch', 'title'],
    ]
    for (const [name, field] of cases) {
      const t = TOOLS.find((x) => x.name === name)
      expect(t, `工具 ${name} 未注册`).toBeDefined()
      expect(t?.parameters.required ?? [], `${name} 编译后 required`)
        .not.toContain(field)
      expect(t?.parameters.properties[field]?.description ?? '')
        .toMatch(/REQUIRED for upsert/)
    }
  })
})
