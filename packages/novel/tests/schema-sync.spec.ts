/**
 * 工具返回值与 output schema 的一致性测试。
 *
 * 背景：`additionalProperties: false` 的 schema 下，返回值里多出一个
 * 未声明属性就会让 DSH 拒绝工具输出（模型看到的是 "returned invalid
 * output"）。这个问题已实际翻车两次（folderUrl / wikiUrl 切换期），
 * 原因都是「改了返回体、漏改嵌套 schema」。
 *
 * 本文件用简易递归校验器对**真实输出**做校验，防回归。
 * @module
 */

import { describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'

interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  output?: { schema?: SchemaNode }
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({ tools: { register: (t: MinimalTool) => tools.set(t.name, t) } } as never, {})
  return tools
}

/** 简易 JSON Schema 校验器（只覆盖本项目用到的子集）。 */
function validate(value: unknown, schema: SchemaNode, path: string): string[] {
  const errors: string[] = []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path}: 期望 object`]
    }
    const props = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${path}.${key} 未在 schema 中声明（additionalProperties: false）`)
        }
      }
    }
    for (const key of schema.required ?? []) {
      if (!(key in (value as Record<string, unknown>))) {
        errors.push(`${path}.${key} 为 required 但返回值缺失`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined && sub !== undefined) {
        errors.push(...validate(v, sub, `${path}.${key}`))
      }
    }
    return errors
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path}: 期望 array`]
    if (schema.items !== undefined) {
      value.forEach((v, i) => errors.push(...validate(v, schema.items as SchemaNode, `${path}[${i}]`)))
    }
    return errors
  }
  // 基础类型
  const t = schema.type
  const ok =
    (t === 'string' && typeof value === 'string') ||
    (t === 'number' && typeof value === 'number') ||
    (t === 'boolean' && typeof value === 'boolean')
  if (!ok) errors.push(`${path}: 期望 ${t}，实际 ${typeof value}`)
  return errors
}

interface SchemaNode {
  type?: string
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: SchemaNode
}

const TEST_BASE = process.env.UNWR_TEST_BASE ?? ''
const HAS_BASE = TEST_BASE !== ''

/** 真实调用工具并校验输出（端到端场景专用）。 */
async function execAndValidate(
  tools: Map<string, MinimalTool>,
  name: string,
  args: Record<string, unknown>,
): Promise<string[]> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`${name} 未注册`)
  const out = await tool.execute(args, { signal: AbortSignal.timeout(50_000) })
  const schema = tool.output?.schema
  if (schema === undefined) return []
  return validate(out, schema, name)
}

describe('工具输出与 output schema 同步', () => {
  it('全部工具的 schema 结构合法（additionalProperties: false 的 object 必须有 properties）', () => {
    for (const tool of collectTools().values()) {
      const schema = tool.output?.schema
      if (schema === undefined) continue
      const walk = (node: SchemaNode, path: string): void => {
        if (node.type === 'object' && node.additionalProperties === false) {
          // DSH 要求嵌套 object 必须显式声明 properties，否则推导为 never
          expect(node.properties, `${path} 缺少 properties`).toBeDefined()
        }
        for (const child of Object.values(node.properties ?? {})) walk(child, path)
        if (node.items !== undefined) walk(node.items, `${path}[]`)
      }
      walk(schema, tool.name)
    }
  })

  it.skipIf(!HAS_BASE)(
    'get_config 真实输出通过 schema 校验（回归：folderUrl 翻车点）',
    { timeout: 60_000 },
    async () => {
      const errors = await execAndValidate(
        collectTools(), 'novel_manage_work',
        { action: 'get_config', workToken: TEST_BASE },
      )
      expect(errors).toEqual([])
    },
  )

  it.skipIf(!HAS_BASE)(
    'list 动作真实输出通过 schema 校验',
    { timeout: 60_000 },
    async () => {
      const errors = await execAndValidate(
        collectTools(), 'novel_manage_work', { action: 'list' },
      )
      expect(errors).toEqual([])
    },
  )

  it.skipIf(!HAS_BASE)(
    'query 类工具真实输出通过 schema 校验',
    { timeout: 90_000 },
    async () => {
      const errors = [
        ...(await execAndValidate(collectTools(), 'novel_manage_setting', { action: 'query', workToken: TEST_BASE })),
        ...(await execAndValidate(collectTools(), 'novel_manage_character', { action: 'query', workToken: TEST_BASE })),
        ...(await execAndValidate(collectTools(), 'novel_manage_foreshadow', { action: 'query', workToken: TEST_BASE })),
      ]
      expect(errors).toEqual([])
    },
  )
})
