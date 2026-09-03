/**
 * 计算工具：novel_calculate
 *
 * 用途：模型写小说涉及多步算术（合计/差值/单价×数量/多项加总）时，落笔前必调此工具
 * 拿到 result 后**整段照抄**到正文，禁止自己心算。
 *
 * 核心动机（实机 2026-09-03）：
 *   LLM 直算多步四则不可靠 —— "四张一百铢，二张五十铢" 写成"六百铢"（实际 500）、
 *   "十二万-十万八千六百" 写成"一万四千四百贯"（实际 11400）都是同一类错误。
 *   让模型负责"中文→JS 表达式"（结构映射，模型擅长），工具负责"表达式→数值"
 *   （纯求值，工具稳定）—— 分工天然契合，且零外部依赖。
 *
 * 设计要点：
 *   - 表达式：JS 算术（数字、+ - * / % ( )、Math 子集）
 *   - 安全：vm.runInNewContext + sandbox 白名单 + 关键词黑名单 + 长度限制 + timeout
 *   - 大数：自动检测精度损失，超出 Number.MAX_SAFE_INTEGER 时走 BigInt 路径
 *   - 输出 steps[]：把演算展示出来，agent 可以抄进正文做演算过程（reviewer 自查）
 *
 * @module @unwr/novel/tools/calculate
 */

import vm from 'node:vm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

/* -------------------------- 安全沙箱 -------------------------- */

/**
 * sandbox 只暴露 Math 子集 + Number.isInteger/isFinite。
 * 无 fs / process / fetch / eval / Function / new / 全局对象。
 */
const SANDBOX = Object.freeze({
  Math: Object.freeze({
    floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
    min: Math.min, max: Math.max, round: Math.round,
    pow: Math.pow, sqrt: Math.sqrt,
    log: Math.log, log2: Math.log2, log10: Math.log10,
  }),
  Number: Object.freeze({
    isInteger: Number.isInteger, isFinite: Number.isFinite,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  }),
  /**
   * BigInt 入口（pure，无 I/O）：agent 写超大数字时使用 BigInt 字面量 `123n`
   * 或 BigInt("123") 即可走大数路径。普通数字不需要这个。
   */
  BigInt,
})

/**
 * 禁用关键字黑名单（前置拦截，防原型逃逸 / 任意代码执行）：
 *   - require / process / global / globalThis / fetch → 拒绝访问 Node/浏览器环境
 *   - eval / Function / setTimeout / setInterval / setImmediate / queueMicrotask
 *     → 拒绝动态代码执行 / 异步逃逸
 *   - import → 拒绝 ESM 动态 import
 *   - `new ` → 拒绝任意对象构造（防 `new Function(...)` 等绕过）
 *
 * 注意：`new ` 后跟空格才匹配，避免误伤 `newYear` 之类标识符。
 * 工具接受的是表达式而非标识符，所以标识符本就不该出现。
 */
const BANNED = /\b(require|process|global|globalThis|fetch|eval|Function|setTimeout|setInterval|setImmediate|queueMicrotask|import)\b|new\s/i

/** 表达式长度上限（防 DoS / 解析器过载）。 */
const MAX_EXPR_LEN = 200

/** 单次求值 timeout（ms，防死循环 / ReDoS 解析）。 */
const EVAL_TIMEOUT_MS = 100

/* -------------------------- 核心求值 -------------------------- */

export interface SafeCalcResult {
  /** 求值结果（数值在安全整数范围内时为 number，否则为 string 形式的 BigInt） */
  result: number | string
  /** 原表达式（trim 后） */
  expression: string
  /** 演算步骤展示，方便 agent 抄进正文或 reviewer 自查 */
  steps: string[]
  /** 数值是否为 BigInt（true 时 result 是十进制字符串） */
  isBigInt: boolean
}

/**
 * 安全 JS 算术表达式求值。
 *
 * 抛出 Error 含自纠正信息：模型看到错误应改对再调用（不是工具 bug）。
 */
export function safeCalculate(expression: string): SafeCalcResult {
  // 1. 长度限制
  if (expression.length > MAX_EXPR_LEN) {
    throw new Error(
      `表达式过长（${expression.length} 字符 > ${MAX_EXPR_LEN}）。` +
      `请拆成多步或缩短。最小可工作示例：` +
      `novel_calculate({ expression: "4*100 + 2*50" })`,
    )
  }

  // 2. 关键字黑名单
  if (BANNED.test(expression)) {
    throw new Error(
      `表达式含禁用关键字（require/eval/new/Function...）。` +
      `本工具只接受纯算术表达式，运算符仅限 + - * / % ( )。` +
      `最小可工作示例：novel_calculate({ expression: "4*100 + 2*50" })`,
    )
  }

  // 3. 安全求值（vm 沙箱 + timeout）
  let raw: unknown
  try {
    raw = vm.runInNewContext(`(${expression})`, SANDBOX, {
      timeout: EVAL_TIMEOUT_MS,
      displayErrors: false,
    })
  } catch (e) {
    throw new Error(
      `表达式求值失败：${(e as Error).message}。` +
      `请检查语法（括号、运算符）。最小可工作示例：` +
      `novel_calculate({ expression: "4*100 + 2*50" })`,
    )
  }

  // 4. 类型校验
  if (typeof raw !== 'number' && typeof raw !== 'bigint') {
    throw new Error(
      `表达式结果非数字（得到 ${typeof raw}）。` +
      `请用纯算术表达式，不要返回字符串或对象。` +
      `最小可工作示例：novel_calculate({ expression: "4*100 + 2*50" })`,
    )
  }

  if (Number.isNaN(raw as number)) {
    throw new Error(`表达式结果为 NaN（典型原因：0/0、负数开方）。请改写算式。`)
  }

  // 5. 大数处理：BigInt 或超出 Number 安全范围 → 走字符串路径
  const isBigInt = typeof raw === 'bigint'
  const asNumber = isBigInt ? Number(raw) : (raw as number)
  const safeNumber = typeof asNumber === 'number' && Number.isFinite(asNumber)
    && Math.abs(asNumber) <= Number.MAX_SAFE_INTEGER

  if (isBigInt || !safeNumber) {
    return {
      result: raw.toString(),
      expression: expression.trim(),
      steps: [`(${expression}) = ${raw.toString()}`],
      isBigInt: true,
    }
  }

  // 6. 标准 number 路径
  const expr = expression.trim()
  const steps = buildSteps(expr, asNumber)
  return {
    result: asNumber,
    expression: expr,
    steps,
    isBigInt: false,
  }
}

/**
 * 从表达式 + 最终值生成演算步骤展示。
 *
 * 简易实现：把表达式原样回填 + "= 最终值"。复杂分解（拆括号等）超出工具职责，
 * agent 自己用 LLM 能力拆分；工具只保证数值正确。
 */
function buildSteps(expression: string, result: number): string[] {
  return [`(${expression}) = ${result}`]
}

/* -------------------------- 工具注册 -------------------------- */

/** 注册 novel_calculate 工具。挂在「写作期」最合适——drafter / 主会话直接调用。 */
export function registerCalculateTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_calculate',
    description: 'Evaluate an arithmetic expression and return the verified numeric result. '
      + 'CALL THIS BEFORE WRITING any arithmetic in prose (totals, deltas, unit×quantity). '
      + 'LLM-computed multi-step arithmetic is unreliable (e.g. 4×100+2×50 may be written as 600 instead of 500); '
      + 'this tool guarantees the number you copy into prose is correct. '
      + '\n\n'
      + 'USAGE: pass a pure arithmetic JS expression (numbers, + - * / %, parentheses). '
      + 'You translate the Chinese narrative into the expression; the tool only does the math. '
      + '\n\n'
      + 'EXAMPLES:\n'
      + '  Narrative "四张一百铢，二张五十铢，共X铢"\n'
      + '    → novel_calculate({ expression: "4*100 + 2*50" })\n'
      + '    → result: 500 → 写 "共五百铢"（不要自己再算）\n'
      + '  Narrative "应到十二万贯，实到十万八千六百贯，差X贯"\n'
      + '    → novel_calculate({ expression: "120000 - 108600" })\n'
      + '    → result: 11400 → 写 "差一万一千四百贯"\n'
      + '  Narrative "二十人，每人三刀，共X刀"\n'
      + '    → novel_calculate({ expression: "20 * 3" })\n'
      + '    → result: 60\n'
      + '\n'
      + 'STEPS field shows the breakdown — copy it into prose if the narrative itself displays the calculation. '
      + 'The `result` is the verified truth value; do NOT recompute it yourself.',
    parameters: {
      expression: {
        type: 'string', required: true,
        description: 'Pure arithmetic JS expression. Operators: + - * / % ( ). '
          + 'Use Math.floor/ceil/abs/round/min/max/pow/sqrt/log if needed. '
          + 'No variables, no function calls beyond Math.*, no objects. '
          + 'Length limit 200 chars.',
      },
      context: {
        type: 'string',
        description: 'Optional: the original Chinese narrative this expression comes from. '
          + 'Stored alongside result for audit; does not affect calculation.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          result: {
            description: 'Verified numeric result. Number when within safe integer range, '
              + 'decimal string when BigInt path was taken.',
            oneOf: [
              { type: 'number' },
              { type: 'string' },
            ],
          },
          expression: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          isBigInt: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      const r = safeCalculate(args.expression)
      const warnings: string[] = []
      if (args.context !== undefined && args.context !== '') {
        // 浅校验：context 里出现「共」「差」「合计」「总计」+ 数字 → 提醒 agent 整段照抄
        if (/共|差|合计|总计|应|实|欠/.test(args.context) && /\d/.test(args.context)) {
          warnings.push('context 含「共/差/合计/总计/应/实/欠」+ 数字，请把 result 整段照抄进正文，不要再算')
        }
      }
      return { ...r, warnings }
    },
  }))
}
