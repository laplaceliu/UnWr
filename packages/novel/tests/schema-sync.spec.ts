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
  apply({
    tools: { register: (t: MinimalTool) => tools.set(t.name, t) },
    // 插件会向主会话注入写作约定（systemPrompt.section）
    systemPrompt: { section: () => {} },
  } as never, {})
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

  /**
   * Schema 顶层 required 必填断言。
   *
   * 起因：2026-09-02 端口 3080 会话里，模型给 novel_revise_chapter 漏传 workToken，
   * 被执行期 guard 拦下报"需要"→ 反复重试。把 workToken 从顶层 required 移除
   * 后，模型会在第一次调用时自己意识到"这一参非强制"，避免假装自己要它。
   *
   * 断言目的：每个工具的顶层 parameters.required 数组都必须**完整**包含
   * 让模型知道「必填」的字段；guard 兜底只能是补充，不能是主防线。
   * workToken 全系列应避免 required（默认会话上下文已带）。
   */
  it('工具 schema 顶层 required 收口：必填字段不缺失', () => {
    type ReqNode = { required?: string[]; properties?: Record<string, ReqNode | unknown> }
    const expected: Record<string, string[]> = {
      // ── 改稿 / 写章 ──
      // revise_chapter：content 为动作级必填（delete 不需要），schema 只约束
      // chapterNo / action；replace/expand/patch 缺 content 由 execute 守卫拦截
      // （实机 2026-09-02：模型清理占位块传 content:"" 被拒 12 次后才补 delete）。
      novel_revise_chapter: ['chapterNo', 'action'],
      novel_read_chapter: ['chapterNo'],
      novel_write_chapter: ['title', 'content'],  // chapterNo 可选：缺省 = current max + 1
      novel_append_chapter: ['content'],  // chapterNo 同样可选：缺省取上一章
      novel_list_scenes: ['chapterNo'],
      novel_get_chapter_history: ['chapterNo'],
      novel_build_context: [],
      // ── 记忆沉淀 ──
      novel_update_summary: ['chapterNo'],  // 字段已拆成 scene/events/characterChanges/.../freeform，summary 字段不存在
      novel_record_character_state: ['chapterNo', 'character'],
      novel_record_event: ['chapterNo', 'name'],
      novel_upsert_book_summary: ['level', 'title', 'content'],
      // ── 实体（entity.ts）──
      // manage_setting / manage_character / manage_outline / manage_foreshadow / manage_plotline / manage_branch
      // 都是「多 action 共用 schema」的形态（action 守门员分支），所以 schema.required
      // 只有 action；具体必填字段在 description 中「REQUIRED for upsert」标注 + execute 期 throw 兜底。
      novel_manage_setting: ['action'],
      novel_manage_character: ['action'],
      novel_manage_outline: ['action'],
      novel_manage_foreshadow: ['action'],
      novel_manage_plotline: ['action'],
      novel_manage_branch: ['action'],
      // ── 一致性 ──
      novel_run_consistency_check: [],
      novel_get_semantic_check_pack: [],
      // ── work ──
      novel_manage_work: ['action'],
    }
    for (const [toolName, required] of Object.entries(expected)) {
      const tool = collectTools().get(toolName)
      if (tool === undefined) {
        // 测试允许 listed tool 在 collectTools 之外——但 revert 失配了直接失败
        throw new Error(`schema-sync: ${toolName} 未注册`)
      }
      const params = tool.parameters as ReqNode
      expect(params.required ?? [], `${toolName}.parameters.required`).toEqual(
        expect.arrayContaining(required),
      )
    }
  })

  it('workToken 在所有工具顶层 required 都不出现（会话默认承接，详见 resolveWorkToken）', () => {
    for (const [toolName, tool] of collectTools()) {
      const params = tool.parameters as { required?: string[] }
      const reqs = params.required ?? []
      expect(reqs, `${toolName} 不应把 workToken 强制为顶层 required`).not.toContain('workToken')
    }
  })

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
