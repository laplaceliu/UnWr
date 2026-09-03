/**
 * lark-cli 路径四级解析的测试（configureLark / env / Windows 探测 / 裸名）。
 *
 * 背景（Windows 实机 2026-09-03）：DSH 沙箱不传播用户级环境变量，
 * UNWR_LARK_BIN 形同虚设——新增插件配置 larkBin + npm/pnpm/yarn 全局
 * bin 目录自动探测作为免 env 的通用解析路径。
 *
 * @module
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureLark, discoverWindowsLarkCli, resolveLarkBin, resolveLarkBinDetailed,
  resolveWindowsBareBin,
} from '../src/cli.ts'

/** 测试前状态快照，afterEach 恢复，防止污染同进程其他用例。 */
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'UNWR_LARK_BIN', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'ProgramFiles', 'ChocolateyInstall', 'SCOOP', 'PATH', 'Path',
] as const
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

afterEach(() => {
  configureLark({ bin: undefined }) // 清除配置态
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  try { rmSync(fixtureDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

let fixtureDir = ''

/** 造一个假的 Windows 全局 bin 布局，返回 fixture 根目录。 */
function makeFixture(layout: Array<{ dir: string, file: string }>): string {
  fixtureDir = mkdtempSync(join(tmpdir(), 'unwr-lark-probe-'))
  for (const { dir, file } of layout) {
    const full = join(fixtureDir, dir)
    mkdirSync(full, { recursive: true })
    writeFileSync(join(full, file), '@echo off\r\n')
  }
  return fixtureDir
}

describe('discoverWindowsLarkCli', () => {
  it('非 win32 平台恒为 undefined（不探测）', () => {
    expect(discoverWindowsLarkCli('linux')).toBeUndefined()
    expect(discoverWindowsLarkCli('darwin')).toBeUndefined()
  })

  it('win32：npm 全局目录的 .cmd shim 被发现', () => {
    const root = makeFixture([{ dir: 'npm', file: 'lark-cli.cmd' }])
    process.env.APPDATA = root
    delete process.env.LOCALAPPDATA
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'npm', 'lark-cli.cmd'))
  })

  it('win32：npm 与 pnpm 同时存在时 npm 优先（探测顺序）', () => {
    const root = makeFixture([
      { dir: 'npm', file: 'lark-cli.cmd' },
      { dir: 'pnpm', file: 'lark-cli.cmd' },
    ])
    process.env.APPDATA = root
    process.env.LOCALAPPDATA = root
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'npm', 'lark-cli.cmd'))
  })

  it('win32：只有 pnpm 目录时回落到 pnpm shim', () => {
    const root = makeFixture([{ dir: 'pnpm', file: 'lark-cli.cmd' }])
    process.env.APPDATA = root
    process.env.LOCALAPPDATA = root
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'pnpm', 'lark-cli.cmd'))
  })

  it('win32：scoop 用户目录（%USERPROFILE%\\scoop\\shims）被发现', () => {
    const root = makeFixture([{ dir: 'scoop/shims', file: 'lark-cli.exe' }])
    process.env.USERPROFILE = root
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'scoop', 'shims', 'lark-cli.exe'))
  })

  it('win32：chocolatey 缺省路径（%ChocolateyInstall% 未设时探测 C:\\ProgramData）', () => {
    // C:\ProgramData 在 CI/容器不可写也不存在 fixture，只断言不抛错且回落 PATH/undefined
    delete process.env.ChocolateyInstall
    process.env.PATH = ''
    expect(() => discoverWindowsLarkCli('win32')).not.toThrow()
  })

  it('win32：进程 PATH 扫描——自定义目录（msys2 风格）里的 shim 被发现', () => {
    const root = makeFixture([{ dir: 'ucrt64/bin', file: 'lark-cli.cmd' }])
    process.env.PATH = `${join(root, 'ucrt64', 'bin')};C:\\Windows\\system32`
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'ucrt64', 'bin', 'lark-cli.cmd'))
  })

  it('win32：PATH 段带引号（含空格目录）被剥引号后扫描', () => {
    const root = makeFixture([{ dir: 'my tools', file: 'lark-cli.cmd' }])
    process.env.PATH = `"${join(root, 'my tools')}"`
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'my tools', 'lark-cli.cmd'))
  })

  it('win32：白名单目录优先于 PATH 扫描', () => {
    const root = makeFixture([
      { dir: 'npm', file: 'lark-cli.cmd' },
      { dir: 'elsewhere', file: 'lark-cli.cmd' },
    ])
    process.env.APPDATA = root
    process.env.PATH = join(root, 'elsewhere')
    expect(discoverWindowsLarkCli('win32')).toBe(join(root, 'npm', 'lark-cli.cmd'))
  })

  it('win32：什么都不存在 → undefined，最终回落裸名走 PATH', () => {
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBeUndefined()
    expect(resolveLarkBin('win32')).toBe('lark-cli')
  })

  it('win32：APPDATA/LOCALAPPDATA 均未设置 → undefined 不抛错', () => {
    delete process.env.APPDATA
    delete process.env.LOCALAPPDATA
    process.env.PATH = ''
    expect(discoverWindowsLarkCli('win32')).toBeUndefined()
  })
})

describe('resolveWindowsBareBin（裸名 → 绝对路径）', () => {
  it('非 win32 原样返回', () => {
    expect(resolveWindowsBareBin('lark-cli', 'linux')).toBe('lark-cli')
  })

  it('含分隔符的路径原样返回（用户显式指定，尊重之）', () => {
    expect(resolveWindowsBareBin('H:\\dev\\msys64\\ucrt64\\bin\\lark-cli.cmd', 'win32'))
      .toBe('H:\\dev\\msys64\\ucrt64\\bin\\lark-cli.cmd')
    expect(resolveWindowsBareBin('tools/lark-cli', 'win32')).toBe('tools/lark-cli')
  })

  it('已带扩展名的裸文件名原样返回（分流是 buildSpawn 的职责）', () => {
    expect(resolveWindowsBareBin('lark-cli.cmd', 'win32')).toBe('lark-cli.cmd')
    expect(resolveWindowsBareBin('lark-cli.exe', 'win32')).toBe('lark-cli.exe')
  })

  it('裸名在 PATH 目录里找到 .cmd → 返回绝对路径', () => {
    const root = makeFixture([{ dir: 'bin', file: 'lark-cli.cmd' }])
    process.env.PATH = join(root, 'bin')
    expect(resolveWindowsBareBin('lark-cli', 'win32')).toBe(join(root, 'bin', 'lark-cli.cmd'))
  })

  it('裸名在 PATH 里找不到 → 原样返回（由 cmd 包装层报可读错误）', () => {
    process.env.PATH = join(makeFixture([]), 'empty')
    expect(resolveWindowsBareBin('lark-cli', 'win32')).toBe('lark-cli')
  })
})

describe('resolveLarkBin 四级优先级（含来源标签）', () => {
  it('优先级 1：configureLark 的 larkBin 压过 env 与探测，来源 config', () => {
    process.env.UNWR_LARK_BIN = 'C:\\from-env\\lark-cli.cmd'
    configureLark({ bin: 'D:\\from-config\\lark-cli.cmd' })
    expect(resolveLarkBin('win32')).toBe('D:\\from-config\\lark-cli.cmd')
    expect(resolveLarkBinDetailed('win32')).toEqual({ bin: 'D:\\from-config\\lark-cli.cmd', source: 'config' })
  })

  it('优先级 2：env 压过探测，来源 env', () => {
    delete process.env.UNWR_LARK_BIN
    process.env.UNWR_LARK_BIN = '/usr/local/bin/lark-cli'
    expect(resolveLarkBin('linux')).toBe('/usr/local/bin/lark-cli')
    expect(resolveLarkBinDetailed('linux')).toEqual({ bin: '/usr/local/bin/lark-cli', source: 'env' })
  })

  it('优先级 2.5：config 里的裸名在 Windows 上解析为绝对路径', () => {
    const root = makeFixture([{ dir: 'npm', file: 'lark-cli.cmd' }])
    process.env.APPDATA = root
    process.env.PATH = ''
    configureLark({ bin: 'lark-cli' })
    expect(resolveLarkBinDetailed('win32')).toEqual({
      bin: join(root, 'npm', 'lark-cli.cmd'),
      source: 'config',
    })
  })

  it('优先级 3：无 env 有探测命中，来源 discovered', () => {
    delete process.env.UNWR_LARK_BIN
    const root = makeFixture([{ dir: 'npm', file: 'lark-cli.exe' }])
    process.env.APPDATA = root
    process.env.PATH = ''
    expect(resolveLarkBinDetailed('win32')).toEqual({
      bin: join(root, 'npm', 'lark-cli.exe'),
      source: 'discovered',
    })
  })

  it('优先级 4：全部缺失回落裸名，来源 path', () => {
    delete process.env.UNWR_LARK_BIN
    process.env.PATH = ''
    expect(resolveLarkBinDetailed('linux')).toEqual({ bin: 'lark-cli', source: 'path' })
  })

  it('configureLark 传空白串 = 清除配置（回落后续层级）', () => {
    configureLark({ bin: '  ' })
    delete process.env.UNWR_LARK_BIN
    expect(resolveLarkBin('linux')).toBe('lark-cli')
  })

  it('configureLark 的值去除首尾空白', () => {
    configureLark({ bin: '  D:\\bin\\lark-cli.cmd ' })
    expect(resolveLarkBin('win32')).toBe('D:\\bin\\lark-cli.cmd')
  })
})
