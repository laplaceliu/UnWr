/**
 * novel_write_chapter 输出契约（纯 mock）：
 * nextHint 必须携带**完整的收尾沉淀清单**。
 *
 * 实机 2026-09-03：人物表 / 人物关系表只在用户追问后才被更新。根因之一是
 * 写章工具的 nextHint 只提醒了摘要一项；persona 第 5 步也只列了
 * 摘要/状态/事件三件套，人物建档与关系登记从未进任何清单，且起草官
 * toolFilter 里根本没有 novel_manage_character / novel_manage_relation。
 *
 * 修复后 nextHint 是「写作过程中」模型必然看到的输出——在此守住它
 * 覆盖沉淀五件套（摘要 / 状态 / 新人物 / 关系 / 事件），防止将来改文案时漏项。
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'

// mock 必须放在静态 import 之前（vitest 自动 hoist）。
// tools/chapter.ts 顶层 import @unwr/feishu / domain/chapter / domain/revision，
// 全部替掉以保证本文件不发起任何真实 CLI 调用。
vi.mock('@unwr/feishu', () => ({ base: {}, docs: {} }))
vi.mock('../src/domain/chapter.ts', () => ({
  writeChapter: vi.fn(async () => ({
    chapterNo: 9,
    title: '第九章 巷战',
    documentId: 'docX',
    documentUrl: 'https://example.feishu.cn/docx/docX',
    recordId: 'rec_ch9',
    words: 1200,
    warnings: [],
  })),
  countWords: vi.fn(() => 0),
  findChapterRecord: vi.fn(),
  maxChapterNo: vi.fn(),
}))
vi.mock('../src/domain/revision.ts', () => ({
  listChapterBlocks: vi.fn(),
}))

import { registerChapterTools } from '../src/tools/chapter.ts'

interface MinimalTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  registerChapterTools({ tools: { register: (t: MinimalTool) => tools.set(t.name, t) } } as never)
  return tools
}

describe('novel_write_chapter nextHint 收尾清单', () => {
  it('写章成功后 nextHint 覆盖沉淀五件套的全部工具名', async () => {
    const tool = collectTools().get('novel_write_chapter')!
    expect(tool).toBeDefined()

    const out = (await tool.execute(
      { workToken: 't', title: '第九章 巷战', content: '## 巷口\n刀光一闪。' },
      { signal: new AbortController().signal },
    )) as { nextHint?: string }

    expect(typeof out.nextHint).toBe('string')
    const hint = out.nextHint ?? ''
    // 五件套逐项断言——漏掉任何一项，人物表/关系表就会回到
    // 「用户追问后才更新」的老问题。
    expect(hint).toContain('novel_update_summary')
    expect(hint).toContain('novel_record_character_state')
    expect(hint).toContain('novel_manage_character')
    expect(hint).toContain('novel_manage_relation')
    expect(hint).toContain('novel_record_event')
  })

  it('清单强调「全部做完才算写完」，并把新人物/关系写成因检查项', async () => {
    const tool = collectTools().get('novel_write_chapter')!
    const out = (await tool.execute(
      { workToken: 't', title: '第九章', content: '正文' },
      { signal: new AbortController().signal },
    )) as { nextHint?: string }
    const hint = out.nextHint ?? ''
    expect(hint).toMatch(/才算写完|务必|漏/)
    // 新人物建档与关系登记要有动作语义（upsert），不只是工具名罗列
    expect(hint).toMatch(/novel_manage_character\(action=upsert\)/)
    expect(hint).toMatch(/novel_manage_relation\(action=upsert/)
  })

  it('工具仍暴露 cast 参数且描述含双向出场登记（不回退）', () => {
    // cast 是人物侧沉淀的地基：出场人物写不进章节表，状态/关系登记也失锚。
    // cast 的传参要求在**参数描述**里，不在工具顶层 description。
    const tool = collectTools().get('novel_write_chapter')! as unknown as {
      parameters: { properties: Record<string, { description?: string }> }
    }
    const cast = tool.parameters.properties['cast']
    expect(cast).toBeDefined()
    expect(cast?.description).toContain('出场人物')
    expect(cast?.description).toContain('出场章节')
  })
})
