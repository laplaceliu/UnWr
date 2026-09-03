/**
 * novel_update_summary 参数形态的契约测试（纯 mock）。
 *
 * 实机 2026-09-03 第 10 章：模型把 `newInfo` 传成对象
 * `{item, newForeshadows, endState, freeform}`，DSH schema 报
 * `"newInfo" must be an array`，模型反复重试 5+ 次都过不去。
 *
 * 修复（tools/memory.ts registerUpdateSummary）：
 *   1. 工具 description 内嵌正确扁平 JSON 示例
 *   2. schema 用 `oneOf: [array, object]` 放宽 newInfo，让对象能进 execute
 *   3. execute 入口对新对象形态抛自纠正 Error，把正确示例回吐给模型，
 *      模型下一轮能自己改对——比 "must be an array" 信息密度高一个量级
 *
 * 本文件守住以上 3 条行为，不依赖飞书。
 *
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock 必须放在静态 import 之前才会被 hoist——vi.mock 是 vitest 提供的
// 编译期预处理钩子，不影响运行时序但强制先于被 mock 的模块解析。
vi.mock('../src/domain/memory.ts', () => ({
  // 本文件唯一会执行到的导出
  updateChapterSummary: vi.fn(async (token: string, chapterNo: number, payload: Record<string, unknown>) => {
    updateCalls.push({ token, chapterNo, payload })
    return { recordId: `rec_${chapterNo}`, summaryText: 'mock-summary' }
  }),
  // 其他注册时会一并解构的导出——本文件不测但 registerMemoryTools 顶部
  // 会用到，给 stub 守住。
  queryBookSummaries: vi.fn(async () => ({ items: [] })),
  recordCharacterState: vi.fn(async () => ({ recordId: 'rec_cs' })),
  recordEvent: vi.fn(async () => ({ recordId: 'rec_ev' })),
  upsertBookSummary: vi.fn(async () => ({ recordId: 'rec_bs' })),
  // memory.ts 模块外围若干类型/辅助函数，stub 即可
  deleteStale: vi.fn(),
  getCharacterState: vi.fn(async () => ({})),
  latestSnapshot: vi.fn(async () => ({})),
}))

import { registerMemoryTools } from '../src/tools/memory.ts'

interface MinimalTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>
}

let updateCalls: Array<{ token: string; chapterNo: number; payload: Record<string, unknown> }> = []

function collectTools(): Map<string, MinimalTool> {
  const tools = new Map<string, MinimalTool>()
  registerMemoryTools({ tools: { register: (t) => tools.set(t.name, t) } } as never)
  return tools
}

beforeEach(() => {
  updateCalls = []
})

describe('novel_update_summary 参数形态', () => {
  const TOOL = 'novel_update_summary'

  it('工具注册成功，参数 schema 正确（newInfo oneOf 含 array 与 object）', () => {
    const tools = collectTools()
    const tool = tools.get(TOOL)
    expect(tool).toBeDefined()
    // DSH 会自动把 parameters 包成 { type: 'object', properties: {...}, required: [...] }
    const root = tool?.parameters as { properties?: Record<string, unknown> } | undefined
    const newInfo = root?.properties?.['newInfo'] as { oneOf?: unknown[] } | undefined
    // oneOf 必须同时含 array 和 object 两个分支——这是放宽 schema 让对象
    // 能进 execute 触发自纠正报错的关键。若误删 object 分支会复发原故障。
    expect(newInfo?.oneOf).toBeDefined()
    const branches = newInfo?.oneOf as Array<{ type?: string | string[]; items?: { type?: string } }>
    // 实际：2 branches（legal string[] + object catch-all）
    //   - legal: type=array, items:type=string — 真实数据形态
    //   - object: 让对象能进 execute，由 validateShape 在执行入口抛自纠正错误
    expect(branches.length).toBe(2)
    expect(branches.some((b) => b.type === 'array' && b.items?.type === 'string')).toBe(true)
    expect(branches.some((b) => b.type === 'object' || (Array.isArray(b.type) && b.type.includes('object')))).toBe(true)
    // 描述里必须出现"不要把 newForeshadows/endState/freeform 嵌进 newInfo"
    // 之类硬警告——模型看了 description 才有希望不重犯。
    expect(tool?.description).toMatch(/do not|不要|不能|nest|嵌套|嵌进/i)
    // 且必须给出一个扁平 JSON 示例
    expect(tool?.description).toContain('chapterNo')
    expect(tool?.description).toContain('events')
  })

  it('正确扁平形态 → 透传到 updateChapterSummary 且参数名不变', async () => {
    const tool = collectTools().get(TOOL)!
    const args = {
      workToken: 't',
      chapterNo: 11,
      scene: '景和十一年 仲春 十四 夜',
      events: ['沈独醒拘捕', '裴绛验骨'],
      characterChanges: ['檀青：转型完成'],
      newInfo: ['鸦母身份揭晓', '沈家三十七口面朝西跪'],
      newForeshadows: ['鸦九堂铭文同源'],
      endState: '沈独醒三日不出',
      freeform: '本章为合的核心',
    }
    const r = await tool.execute(args, { signal: new AbortController().signal })
    expect(r).toMatchObject({ chapterNo: 11, recordId: 'rec_11', summaryText: 'mock-summary' })
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]?.chapterNo).toBe(11)
    expect(updateCalls[0]?.payload).toEqual({
      scene: '景和十一年 仲春 十四 夜',
      events: ['沈独醒拘捕', '裴绛验骨'],
      characterChanges: ['檀青：转型完成'],
      newInfo: ['鸦母身份揭晓', '沈家三十七口面朝西跪'],
      newForeshadows: ['鸦九堂铭文同源'],
      endState: '沈独醒三日不出',
      freeform: '本章为合的核心',
    })
  })

  it('newInfo 缺省不传 → 仍能落库（缺省分支未污染）', async () => {
    const tool = collectTools().get(TOOL)!
    await tool.execute(
      { workToken: 't', chapterNo: 12, scene: '某地', events: ['e'], endState: 's' },
      { signal: new AbortController().signal },
    )
    expect(updateCalls[0]?.payload).not.toHaveProperty('newInfo')
  })

  it('【实机 2026-09-03 故障】newInfo 传成 {item,newForeshadows,endState,freeform} 对象 → 立即抛自纠正错误', async () => {
    const tool = collectTools().get(TOOL)!
    // 这正是模型在实机第 10 章传过来的形态——每个字段都被错放进 newInfo。
    await expect(
      tool.execute(
        {
          workToken: 't',
          chapterNo: 10,
          scene: '齐王府门前',
          events: ['e1'],
          characterChanges: ['c1'],
          newInfo: {
            item: '十二年前那一夜，沈家满门三十七口面朝西跪——是鸦母一只一只按下去的',
            newForeshadows: ['鸦九刃铭文同源', '鸦母冷笑—齐王夜枭仍未到头'],
            endState: '第 11 章将进入鸦母入洗骨司单独审验',
            freeform: '本章是合的核心',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/newInfo/)
    // 错误信息必须引导模型看到"这些字段应当与 newInfo 平级"，否则
    // 模型下一轮还是改不对。
    await expect(
      tool.execute(
        {
          workToken: 't',
          chapterNo: 10,
          scene: '齐王府门前',
          events: ['e1'],
          newInfo: {
            item: 'x',
            newForeshadows: ['a'],
            endState: 'b',
            freeform: 'c',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/顶层|平级|扁平|newForeshadows.*?endState.*?freeform/)
    // 自纠正抛出后，updateChapterSummary 不应被调用——避免半错误落库。
    expect(updateCalls).toHaveLength(0)
  })

  it('自纠正错误的提示要给出**可被复制**的正确 JSON 示例', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 10,
          newInfo: { item: 'x', newForeshadows: [], endState: '', freeform: '' },
        },
        { signal: new AbortController().signal },
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    const msg = caught!.message
    // 提示中必须含字段名清单（让模型一眼看出哪些是顶级字段）
    expect(msg).toContain('newForeshadows')
    expect(msg).toContain('endState')
    expect(msg).toContain('freeform')
    // 必须含一段可解析的 JSON 示例
    expect(msg).toMatch(/\{[\s\S]*"chapterNo"[\s\S]*\}/)
    // 应当引导到文档参考
    expect(msg).toMatch(/docs\/requirements|domain\/memory/i)
  })

  it('newInfo 传非数组非对象 → 抛自纠正错误（不留静默失败空间）', async () => {
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute(
        { workToken: 't', chapterNo: 10, newInfo: '一坨字符串当成数组' as unknown as string[] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/newInfo/)
    // 字符串触发后，updateChapterSummary 绝不应被调用——避免落库不一致。
    expect(updateCalls).toHaveLength(0)
  })

  it('newInfo = 空对象 {} → 抛自纠正错误而非悄悄落库为空', async () => {
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute(
        { workToken: 't', chapterNo: 10, newInfo: {} as unknown as string[] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/newInfo/)
    expect(updateCalls).toHaveLength(0)
  })

  // ===== characterChanges / events / newForeshadows 实机 2026-09-03 第 11 章同型 =====

  it('【实机 2026-09-03 第 11 章】characterChanges 嵌套同类对象 → validateShape 拒并指字段名', async () => {
    const tool = collectTools().get(TOOL)!
    // 这是模型在第 11 章传过来的形态：把全套平级顶层字段塞进 characterChanges 对象里，
    // 还嵌套了一层 `characterChanges: {...}`。
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 11,
          scene: '西市杂号柜坊门口、账房。',
          events: ['裴三错清晨回柜坊', '掌柜甩袖带飞蛾'],
          characterChanges: {
            item: '卫掌柜:面色铁青是真怕',
            characterChanges: {
              newInfo: ['西市柜坊的「未结账」栏'],
              newForeshadows: ['掌柜「笔尖朝着门口」'],
              endState: '门口青布小轿绯色袍角动了一下',
              freeform: '本章把「挂单」从口头规矩推到实质',
            },
          } as unknown as string[],
        },
        { signal: new AbortController().signal },
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    // 错误必须点 characterChanges（让模型精确定位错的字段）
    expect(caught!.message).toMatch(/characterChanges/)
    // 自纠正提示必须含可复制的正确结构
    expect(caught!.message).toMatch(/顶层/)
    // updateChapterSummary 绝不能被调——落库前拦下
    expect(updateCalls).toHaveLength(0)
  })

  it('events 误传对象 → validateShape 拒并指 events', async () => {
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute(
        {
          workToken: 't',
          chapterNo: 11,
          events: { item: 'x', newInfo: [], endState: '', freeform: '' } as unknown as string[],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/events/)
    expect(updateCalls).toHaveLength(0)
  })

  it('newForeshadows 误传对象 → validateShape 拒并指 newForeshadows', async () => {
    const tool = collectTools().get(TOOL)!
    await expect(
      tool.execute(
        {
          workToken: 't',
          chapterNo: 11,
          events: ['e'],
          newForeshadows: { item: 'x', freeform: '', endState: '' } as unknown as string[],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/newForeshadows/)
    expect(updateCalls).toHaveLength(0)
  })

  it('正常字符串数组透传（characterChanges/events/newForeshadows 都正确）', async () => {
    const tool = collectTools().get(TOOL)!
    await tool.execute(
      {
        workToken: 't',
        chapterNo: 11,
        scene: '西市杂号柜坊门口、账房。',
        events: ['裴三错清晨回柜坊', '掌柜甩袖带飞蛾'],
        characterChanges: ['卫掌柜:面色铁青是真怕', '裴三错:挂单于「未结账」栏'],
        newInfo: ['西市柜坊的「未结账」栏'],
        newForeshadows: ['万俟休提前两天'],
        endState: '门口青布小轿绯色袍角动了一下',
        freeform: '本章把「挂单」从口头推到实质',
      },
      { signal: new AbortController().signal },
    )
    expect(updateCalls).toHaveLength(1)
    const p = updateCalls[0]?.payload as Record<string, unknown>
    expect(Array.isArray(p.characterChanges)).toBe(true)
    expect(Array.isArray(p.events)).toBe(true)
    expect(Array.isArray(p.newForeshadows)).toBe(true)
  })

  // ===== scene / endState / freeform 实机 2026-09-03 第 16 章（string 字段被
  // 当作 string-array 字段包装） =====
  // 用户场景完整 payload：
  //   events: [[[[[ "..." ]]]]]  ← 5 层嵌套（多加的）
  //   characterChanges: [["..."]] ← 双层嵌套（多加的）
  //   newForeshadows: [[["..."]]]
  //   scene: ["..."]              ← string 字段误包装进数组
  //   endState: { freeform: "..." } ← string 字段误包装进对象

  it('scene 误传字符串数组 → validateShape 拒并提醒「scene 是字符串，不是数组」', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 16,
          scene: ['阿史那莺带裴三错去长安城北胡商义地——碑挤着碑、坟挤着坟。'] as unknown as string,
          events: ['裴三错看碑'],
        },
        { signal: new AbortController().signal },
      )
    } catch (e) { caught = e as Error }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/scene/)
    expect(caught!.message).toMatch(/必须是字符串/)
    expect(updateCalls).toHaveLength(0)
  })

  it('endState 误传对象 { freeform: "..." } → validateShape 拒并指 endState', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 16,
          scene: '开元四十一年 三月十五 晨,长安城北胡商义地。',
          events: ['裴三错看碑'],
          endState: { freeform: '本章把稽戛方之死的物理证据抬到裴三错面前:' } as unknown as string,
        },
        { signal: new AbortController().signal },
      )
    } catch (e) { caught = e as Error }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/endState/)
    expect(updateCalls).toHaveLength(0)
  })

  it('newForeshadows 多重嵌套 `[[["..."]]]` → 不静默（schema 或 validateShape 拒）', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 16,
          scene: '开元四十一年 三月十五 晨,长安城北胡商义地。',
          events: ['e'],
          newForeshadows: [[['三月初九这一夜:圆觉长老「坐化」']]] as unknown as string[],
        },
        { signal: new AbortController().signal },
      )
    } catch (e) { caught = e as Error }
    expect(caught).not.toBeNull()
    // DSH schema 顶层会拒（array(string) 不匹配 [[["..."]]]）→ 报 invalid arguments 字段名
    // 或我们的 validateShape 抓 → 报"嵌套"/"顶层扁平"。
    // 两者之一都可——关键是**不让数据落库**。
    expect(caught!.message).toMatch(/newForeshadows|顶层扁平|嵌套|invalid arguments|oneOf/)
    expect(updateCalls).toHaveLength(0)
  })

  it('events 多重嵌套 `[[[[["..."]]]]]`（用户 payload）→ DSH schema 直接拒（顶层拒）', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 16,
          scene: '开元四十一年 三月十五 晨,长安城北胡商义地。',
          events: [[[[['章末钩子:小坑边留了一截炭屑']]]]] as unknown as string[],
        },
        { signal: new AbortController().signal },
      )
    } catch (e) { caught = e as Error }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/events/)
    expect(updateCalls).toHaveLength(0)
  })

  it('characterChanges 多重嵌套 `[["..."]]`（用户 payload）→ DSH schema 拒（顶层拒）', async () => {
    const tool = collectTools().get(TOOL)!
    let caught: Error | null = null
    try {
      await tool.execute(
        {
          workToken: 't',
          chapterNo: 16,
          scene: '开元四十一年 三月十五 晨,长安城北胡商义地。',
          events: ['e'],
          characterChanges: [['阿史那莺:在坟前蹲得稳']] as unknown as string[],
        },
        { signal: new AbortController().signal },
      )
    } catch (e) { caught = e as Error }
    expect(caught).not.toBeNull()
    expect(caught!.message).toMatch(/characterChanges/)
    expect(updateCalls).toHaveLength(0)
  })
})
