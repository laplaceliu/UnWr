/**
 * novel_calculate 工具测试
 *
 * 覆盖三类：
 *   1. safeCalculate 纯函数：算术正确性 + 沙箱安全 + 大数路径
 *   2. 工具注册：字段齐全 + schema 形状 + execute 行为
 *   3. WRITING_CONVENTIONS 提到 novel_calculate → 工具真实存在（防提示词幻影）
 *
 * 背景：实机 2026-09-03 观察到模型直算"4×100+2×50=600"、"120000-108600=14400"，
 * 此工具是消除这类错误的根治手段。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { safeCalculate } from '../src/tools/calculate.ts'
import { apply, WRITING_CONVENTIONS } from '../src/index.ts'

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

/* -------------------- safeCalculate 纯函数 -------------------- */
describe('safeCalculate 纯函数', () => {
  /* ---- 算术正确性（包含实机 bug 复现） ---- */
  it('实机 bug 复现 1：4×100+2×50 = 500（不是 600）', () => {
    const r = safeCalculate('4*100 + 2*50')
    expect(r.result).toBe(500)
    expect(r.isBigInt).toBe(false)
    expect(r.steps).toContain('(4*100 + 2*50) = 500')
  })

  it('实机 bug 复现 2：120000 - 108600 = 11400（不是 14400）', () => {
    const r = safeCalculate('120000 - 108600')
    expect(r.result).toBe(11400)
    expect(r.isBigInt).toBe(false)
  })

  it('基本四则：加/减/乘/除', () => {
    expect(safeCalculate('1 + 2').result).toBe(3)
    expect(safeCalculate('10 - 3').result).toBe(7)
    expect(safeCalculate('6 * 7').result).toBe(42)
    expect(safeCalculate('100 / 4').result).toBe(25)
    expect(safeCalculate('10 % 3').result).toBe(1)
  })

  it('括号嵌套', () => {
    expect(safeCalculate('(2 + 3) * 4').result).toBe(20)
    expect(safeCalculate('((1 + 2) * (3 + 4))').result).toBe(21)
  })

  it('负数与减号', () => {
    expect(safeCalculate('-5 + 10').result).toBe(5)
    expect(safeCalculate('100 - 200').result).toBe(-100)
  })

  it('小数运算', () => {
    expect(safeCalculate('0.1 + 0.2').result).toBeCloseTo(0.3, 10)
    expect(safeCalculate('3.14 * 2').result).toBeCloseTo(6.28, 10)
  })

  it('Math 子集可用', () => {
    expect(safeCalculate('Math.floor(3.7)').result).toBe(3)
    expect(safeCalculate('Math.ceil(3.2)').result).toBe(4)
    expect(safeCalculate('Math.round(3.5)').result).toBe(4)
    expect(safeCalculate('Math.abs(-5)').result).toBe(5)
    expect(safeCalculate('Math.max(1, 2, 3)').result).toBe(3)
    expect(safeCalculate('Math.min(1, 2, 3)').result).toBe(1)
    expect(safeCalculate('Math.pow(2, 10)').result).toBe(1024)
    expect(safeCalculate('Math.sqrt(16)').result).toBe(4)
  })

  /* ---- 大数：BigInt 路径 ---- */
  it('大数（用 BigInt 字面量 n 后缀）走 BigInt 路径', () => {
    // 9007199254740993n 是 JS BigInt 字面量，精确表示 2^53+1
    // 直接写 9007199254740993 会被 Number 静默舍入到 2^53，是预期行为
    const r = safeCalculate('9007199254740993n')
    expect(r.isBigInt).toBe(true)
    expect(r.result).toBe('9007199254740993')
  })

  it('大数加法（BigInt 字面量）：1000000000000000n + 1000000000000000n', () => {
    const r = safeCalculate('1000000000000000n + 1000000000000000n')
    expect(r.isBigInt).toBe(true)
    expect(r.result).toBe('2000000000000000')
  })

  it('BigInt() 构造器可用', () => {
    const r = safeCalculate('BigInt("12345678901234567890")')
    expect(r.isBigInt).toBe(true)
    expect(r.result).toBe('12345678901234567890')
  })

  it('安全范围内的大数仍走 number 路径', () => {
    const r = safeCalculate('999999999999999') // < MAX_SAFE_INTEGER
    expect(r.isBigInt).toBe(false)
    expect(r.result).toBe(999999999999999)
  })

  /* ---- 沙箱安全 ---- */
  it('拒绝 require', () => {
    expect(() => safeCalculate('require("fs")')).toThrow(/禁用关键字/)
  })

  it('拒绝 process', () => {
    expect(() => safeCalculate('process.env')).toThrow(/禁用关键字/)
  })

  it('拒绝 global / globalThis', () => {
    expect(() => safeCalculate('global')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('globalThis')).toThrow(/禁用关键字/)
  })

  it('拒绝 fetch', () => {
    expect(() => safeCalculate('fetch("http://evil")')).toThrow(/禁用关键字/)
  })

  it('拒绝 eval / Function', () => {
    expect(() => safeCalculate('eval("1+1")')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('Function("return 1")()')).toThrow(/禁用关键字/)
  })

  it('拒绝 setTimeout / setInterval / setImmediate / queueMicrotask', () => {
    expect(() => safeCalculate('setTimeout(()=>{},0)')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('setInterval(()=>{},0)')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('setImmediate(()=>{})')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('queueMicrotask(()=>{})')).toThrow(/禁用关键字/)
  })

  it('拒绝 import', () => {
    expect(() => safeCalculate('import("fs")')).toThrow(/禁用关键字/)
  })

  it('拒绝 new 关键字', () => {
    expect(() => safeCalculate('new Date()')).toThrow(/禁用关键字/)
    expect(() => safeCalculate('new Function("return 1")()')).toThrow(/禁用关键字/)
  })

  it('拒绝过长表达式', () => {
    const long = '1+' .repeat(150)
    expect(() => safeCalculate(long)).toThrow(/过长/)
  })

  it('语法错误抛自纠正 Error（含最小示例）', () => {
    // 未闭合括号 — 必然语法错
    expect(() => safeCalculate('((1+2')).toThrow(/最小可工作示例/)
    // 不合法 token
    expect(() => safeCalculate('1 + + +')).toThrow(/最小可工作示例/)
  })

  it('NaN 抛错', () => {
    expect(() => safeCalculate('0/0')).toThrow(/NaN/)
  })

  it('非数字结果抛错', () => {
    expect(() => safeCalculate('"hello"')).toThrow(/非数字/)
    expect(() => safeCalculate('({})')).toThrow(/非数字/)
  })

  /* ---- 边界 ---- */
  it('空字符串抛语法错', () => {
    expect(() => safeCalculate('')).toThrow()
  })

  it('单数字字面量', () => {
    expect(safeCalculate('42').result).toBe(42)
    expect(safeCalculate('-7').result).toBe(-7)
  })
})

/* -------------------- 工具注册表 -------------------- */
describe('novel_calculate 工具注册', () => {
  const registry = collectTools()
  const tool = registry.get('novel_calculate')

  it('已注册', () => {
    expect(tool).toBeDefined()
  })

  it('字段齐全', () => {
    expect(typeof tool?.description).toBe('string')
    expect((tool?.description as string).length).toBeGreaterThan(100)
    expect(tool?.parameters).toBeTruthy()
    expect(tool?.output).toBeTruthy()
    expect(typeof tool?.execute).toBe('function')
  })

  it('description 包含两个示例', () => {
    const desc = tool?.description as string
    expect(desc).toContain('4*100 + 2*50')
    expect(desc).toContain('120000 - 108600')
  })

  it('execute 接收 expression + 可选 context，返回 result + steps + isBigInt + warnings', async () => {
    type ExecResult = {
      result: number | string
      expression: string
      steps: string[]
      isBigInt: boolean
      warnings: string[]
    }
    type Exec = (a: { expression: string; context?: string }) => Promise<ExecResult>
    const exec = tool?.execute as Exec

    // 正常路径
    const r1 = await exec({ expression: '10 * 5' })
    expect(r1.result).toBe(50)
    expect(r1.isBigInt).toBe(false)
    expect(r1.steps).toHaveLength(1)
    expect(r1.warnings).toEqual([])

    // context 含「共/差/合计/总计/应/实/欠」+ 数字 → 触发警告
    // 注：原文数字必须是 ASCII 数字（\d 正则不匹配中文数字——这正是中文→JS 算式翻译的难点）
    const r2 = await exec({ expression: '100 + 50', context: '共计 150 铢' })
    expect(r2.warnings.length).toBeGreaterThan(0)
    expect(r2.warnings[0]).toContain('整段照抄')
  })
})

/* -------------------- WRITING_CONVENTIONS 提到 → 工具存在 -------------------- */
describe('写作约定引用 novel_calculate', () => {
  it('WRITING_CONVENTIONS 提到了 novel_calculate（提示词承诺 = 模型会去调）', () => {
    expect(WRITING_CONVENTIONS).toContain('novel_calculate')
    // 且提到了核心算式示例
    expect(WRITING_CONVENTIONS).toContain('4*100 + 2*50')
    expect(WRITING_CONVENTIONS).toContain('120000 - 108600')
  })

  it('工具真实存在（防提示词幻影）', () => {
    const registry = collectTools()
    expect(registry.has('novel_calculate')).toBe(true)
  })
})
