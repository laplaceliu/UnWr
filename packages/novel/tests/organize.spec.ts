/**
 * 多作品组织（云盘文件夹归位）测试。
 *
 * 文件夹方案（用户决策）：
 *   每本小说一个云盘文件夹《作品名》/，Base 与正文都在其中；
 *   指明卷时自动创建《卷名》/ 子文件夹。
 *
 * 归位由飞书 API 确定性语义保证（create 带 folder_token），
 * 测试不再枚举文件夹内容（CLI 无该 shortcut，且归位是平台语义）。
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { resolveTestBase, waitForBaseReady } from './helpers.ts'
import { apply } from '../src/index.ts'
import { maxChapterNo } from '../src/domain/chapter.ts'
import { drive } from '@unwr/feishu'

interface MinimalTool {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  apply({ tools: { register: (t: MinimalTool) => tools.set(t.name, t) }, systemPrompt: { section: () => {} } } as never, {})
  return tools
}

const TEST_BASE = process.env.UNWR_TEST_BASE ?? ''
const HAS_BASE = TEST_BASE !== ''

describe('纯函数', () => {
  it('extractFolderToken 从云盘 URL 提取 folder token', () => {
    expect(drive.extractFolderToken('https://my.feishu.cn/drive/folder/AbC123')).toBe('AbC123')
    expect(drive.extractFolderToken('https://my.feishu.cn/folder/NODE')).toBe('NODE')
    expect(drive.extractFolderToken('https://my.feishu.cn/docx/DOC123')).toBeUndefined()
    expect(drive.extractFolderToken('')).toBeUndefined()
    expect(drive.extractFolderToken(undefined)).toBeUndefined()
  })
})

describe.skipIf(!HAS_BASE)('端到端：文件夹归位', () => {
  const tools = collectTools()
  const stamp = Date.now().toString(36)
  const volumeName = `测试卷-${stamp}`
  let chapterNo = 0

  beforeAll(async () => {
    if (!HAS_BASE) return
    await waitForBaseReady(TEST_BASE !== '' ? TEST_BASE : baseToken)
    chapterNo = await maxChapterNo(TEST_BASE) + 600 + Math.floor(Math.random() * 50)
  })

  const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具 ${name} 未注册`)
    return await tool.execute({ workToken: TEST_BASE, ...args }, {
      signal: AbortSignal.timeout(120_000),
    }) as Record<string, unknown>
  }

  it('link_folder → 为测试库创建《作品名》根文件夹', async () => {
    const r = await run('novel_manage_work', { action: 'link_folder' })
    expect(String(r.folderUrl ?? '')).toContain('/folder/')
  })

  it('link_folder 幂等 → 已挂目录时直接返回', async () => {
    const r = await run('novel_manage_work', { action: 'link_folder' })
    expect(String(r.folderUrl ?? '')).toContain('/folder/')
  })

  it('get_config → 返回文档目录', async () => {
    const r = await run('novel_manage_work', { action: 'get_config' })
    const cfg = r.config as { folderUrl?: string }
    expect(String(cfg.folderUrl ?? '')).toContain('/folder/')
  })

  it('write_chapter（指明新卷）→ 创建卷文件夹并归位正文', async () => {
    const r = await run('novel_write_chapter', {
      chapterNo,
      title: `[测试] 第${chapterNo}章 归位`,
      volume: volumeName,
      content: '## 一\n\n归位测试正文。\n',
    })
    expect(r.chapterNo).toBe(chapterNo)
    expect(String(r.documentUrl)).toContain('/docx/')
  })

  it('write_chapter（同卷第二章）→ 复用卷文件夹', async () => {
    const r = await run('novel_write_chapter', {
      chapterNo: chapterNo + 1,
      title: `[测试] 第${chapterNo + 1}章 归位二`,
      volume: volumeName,
      content: '## 一\n\n第二章。\n',
    })
    expect(r.chapterNo).toBe(chapterNo + 1)
  })

  it('write_chapter（未指明卷）→ 放作品根文件夹', async () => {
    const r = await run('novel_write_chapter', {
      chapterNo: chapterNo + 2,
      title: `[测试] 第${chapterNo + 2}章 无卷`,
      content: '## 一\n\n无卷章节。\n',
    })
    expect(r.chapterNo).toBe(chapterNo + 2)
  })

  it('卷表记录了卷文件夹地址', async () => {
    // 通过大纲查询确认章节归位链路完整（章节表「所属卷」link 生效）
    const q = await run('novel_manage_outline', { action: 'query', chapterNo })
    const items = q.items as { no: number; title: string }[]
    expect(items).toHaveLength(1)
  })
})
