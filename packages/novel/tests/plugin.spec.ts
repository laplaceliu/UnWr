/**
 * 插件入口与工具注册验证。
 *
 * 用最小 fake ctx 驱动 apply()，确认：
 *   1. 插件导出符合 Cordis 约定（有 name / inject / apply）
 *   2. 工具被正确注册且 schema 合法
 *   3. 工具能端到端执行（读真实飞书测试库）
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

/** 工具定义的最小视图（只需断言我们关心的字段）。 */
interface MinimalTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

/** 构造最小 fake Cordis context。 */
function fakeContext(): { ctx: unknown; registered: MinimalTool[] } {
  const registered: MinimalTool[] = []
  const ctx = {
    tools: {
      register(tool: MinimalTool): void {
        registered.push(tool)
      },
    },
  }
  return { ctx, registered }
}

/**
 * 测试用作品库。**不内置任何默认 token**——那会是个人资源标识，
 * 且对其他人无效。未设置时端到端用例自动跳过，其余用例照常运行。
 * 取值方式见 .env.example。
 */
const TEST_BASE = process.env.UNWR_TEST_BASE ?? ''
const HAS_TEST_BASE = TEST_BASE !== ''

describe('@unwr/novel plugin', () => {
  it('导出符合 Cordis 插件约定', () => {
    expect(name).toBe('unwr-novel')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('tools')
  })

  it('apply 注册 novel_build_context 工具', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, {})
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('novel_build_context')
  })

  it('工具 schema 合法且含必需参数', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never, {})
    const tool = registered[0]
    expect(tool).toBeDefined()
    expect(tool?.description.length ?? 0).toBeGreaterThan(20)

    // defineTool 会把 parameters DSL 规范化为标准 JSON Schema
    const params = tool?.parameters as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    } | undefined
    expect(params?.type).toBe('object')
    expect(Object.keys(params?.properties ?? {})).toEqual(
      expect.arrayContaining(['workToken', 'chapterNo', 'presetId']),
    )
    // workToken / chapterNo 必填，presetId 可选
    expect(params?.required ?? []).toEqual(expect.arrayContaining(['workToken', 'chapterNo']))
    expect(params?.required ?? []).not.toContain('presetId')

    // 工具名必须匹配 DSH 约定：64 字符内，[A-Za-z0-9_-]
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(tool?.name ?? '')).toBe(true)
  })

  // 未配置测试库时跳过，而非失败——其余用例不受影响
  it.skipIf(!HAS_TEST_BASE)(
    '端到端：从真实飞书测试库组装第 4 章上下文',
    { timeout: 60_000 },
    async () => {
      const { ctx, registered } = fakeContext()
      apply(ctx as never, {})
      const tool = registered[0]
      if (tool === undefined) throw new Error('tool not registered')

      const result = await tool.execute(
        { workToken: TEST_BASE, chapterNo: 4, presetId: 'webnovel' },
        { signal: AbortSignal.timeout(50_000) },
      ) as Record<string, unknown>

      expect(result.chapterNo).toBe(4)
      // 写作指引必须渲染出来（题材配置生效）
      expect(typeof result.writingGuide).toBe('string')
      expect(result.writingGuide as string).toContain('中文网文')
      expect(typeof result.estimatedTokens).toBe('number')
      // openForeshadows 依赖测试库实际数据，只校验类型
      expect(Array.isArray(result.openForeshadows)).toBe(true)
    },
  )
})
