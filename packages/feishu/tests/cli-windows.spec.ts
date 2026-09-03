/**
 * Windows spawn 适配的纯逻辑测试。
 *
 * 背景（Windows 实测故障）：npm 全局 lark-cli 在 PATH 里是 .cmd shim，
 * Node（CVE-2024-27980）对 shell:false spawn .cmd 直接 EINVAL——
 * 修复为 buildSpawn 按平台/命令形态分流，本文件守住分流与引号规则。
 *
 * 全部为纯函数断言（不真起进程），Windows 分支在本机（Linux）上
 * 通过 platform 参数注入验证。
 *
 * @module
 */

import { describe, expect, it, afterEach } from 'vitest'
import { buildSpawn, windowsQuote } from '../src/cli.ts'

afterEach(() => {
  delete process.env.ComSpec
})

/**
 * 参照实现：cross-spawn 同款 regex 版 MS C runtime quoting。
 * 与被测的逐字符版互相印证——两者对任意输入必须一致，
 * 深层反斜杠组合因此无需手写多层转义字面量。
 */
function quoteRef(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  return `"${arg
    .replace(/(\\*)"/g, (_, bs: string) => bs + bs + '\\"')
    .replace(/(\\+)$/, (bs: string) => bs + bs)}"`
}

describe('windowsQuote（MS C runtime 引号规则）', () => {
  it('无空格无引号的参数原样输出', () => {
    expect(windowsQuote('abc')).toBe('abc')
    expect(windowsQuote('--base-token')).toBe('--base-token')
    expect(windowsQuote('第1章')).toBe('第1章') // 中文无空格也原样
    expect(windowsQuote('C:\\foo')).toBe('C:\\foo') // 反斜杠无引号不触发包裹
  })

  it('基础包裹用例（浅层转义，手写字面量）', () => {
    expect(windowsQuote('')).toBe('""') // 空参数保留占位
    expect(windowsQuote('第 1 章')).toBe('"第 1 章"') // 空格触发包裹
    expect(windowsQuote('a"b')).toBe('"a\\"b"') // 内嵌引号转义
    expect(windowsQuote('a\\ b')).toBe('"a\\ b"') // 反斜杠+空格：包裹即可
  })

  it('与参照实现（cross-spawn regex 版）在恶意输入全集上一致', () => {
    const nasty = [
      'a"b',
      'a\\"b', // 引号前 1 个反斜杠
      'a\\\\"b', // 引号前 2 个反斜杠
      'a\\"', // 结尾：反斜杠+引号
      'C:\\foo\\', // 结尾反斜杠
      'C:\\', // 仅一个结尾反斜杠
      '"\\b', // 引号后接反斜杠
      '\\', // 单反斜杠（无引号，但以引用参照为准）
      'x "y" \\z\\ ',
      '多 字 符 "引" 号\\尾\\',
      '--title=第 1 章 初见',
    ]
    for (const input of nasty) {
      expect(windowsQuote(input), `输入: ${JSON.stringify(input)}`).toBe(quoteRef(input))
    }
  })
})

describe('buildSpawn（按平台/命令形态分流）', () => {
  it('非 Windows：直跑，行为与历史一致（不经 shell）', () => {
    const plan = buildSpawn('lark-cli', ['base', 'record-list', '--as', 'user'], 'linux')
    expect(plan).toEqual({ file: 'lark-cli', args: ['base', 'record-list', '--as', 'user'], viaCmd: false })
  })

  it('非 Windows 即使命令是 .cmd 也直跑（该形态只存在于 Windows）', () => {
    const plan = buildSpawn('/usr/bin/lark-cli.cmd', ['a'], 'darwin')
    expect(plan.viaCmd).toBe(false)
  })

  it('Windows + 裸名：走 cmd /d /s /c 包装 + 整体引号', () => {
    const plan = buildSpawn('lark-cli', ['base', 'record-list'], 'win32')
    expect(plan.viaCmd).toBe(true)
    expect(plan.file).toBe('cmd.exe')
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // 整个命令行包一层引号（/s 语义下 cmd 剥掉最外层后执行内部命令）
    expect(plan.args[3]).toMatch(/^".*"$/s)
    expect(plan.args[3]).toContain('lark-cli base record-list')
  })

  it('Windows + 含空格参数：按 windowsQuote 规则内嵌引号', () => {
    const plan = buildSpawn('lark-cli', ['docs', 'create', '--title', '第 1 章 初见'], 'win32')
    expect(plan.args[3]).toContain('--title "第 1 章 初见"')
  })

  it('Windows + 显式 .exe：CreateProcess 直跑，不包装', () => {
    const plan = buildSpawn('C:\\tools\\lark-cli.exe', ['--help'], 'win32')
    expect(plan).toEqual({ file: 'C:\\tools\\lark-cli.exe', args: ['--help'], viaCmd: false })
  })

  it('Windows + .cmd/.bat 包装；扩展名判断大小写不敏感', () => {
    expect(buildSpawn('x.CMD', ['a'], 'win32').viaCmd).toBe(true)
    expect(buildSpawn('y.BAT', ['a'], 'win32').viaCmd).toBe(true)
    expect(buildSpawn('z.EXE', ['a'], 'win32').viaCmd).toBe(false)
    expect(buildSpawn('w.com', ['a'], 'win32').viaCmd).toBe(false)
  })

  it('ComSpec 环境变量优先于默认 cmd.exe', () => {
    process.env.ComSpec = 'C:\\Windows\\system32\\cmd.EXE'
    const plan = buildSpawn('lark-cli', ['a'], 'win32')
    expect(plan.file).toBe('C:\\Windows\\system32\\cmd.EXE')
  })

  it('不修改调用方传入的 argv 数组', () => {
    const argv = ['a', 'b']
    buildSpawn('lark-cli', argv, 'linux')
    expect(argv).toEqual(['a', 'b'])
  })
})
