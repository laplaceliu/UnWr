/**
 * 内容红线（genre/taboos.ts）单元测试。
 *
 * 覆盖三件事：
 *   1. 目录自身的完整性（编码唯一、字段非空）——code 是外部稳定标识，
 *      写进 ISSUE 表与日志后被引用，重复或缺失都会让历史数据无法反查。
 *   2. 两个渲染器的**内容契约**：起草简报给规则+改写方向（防负面样例诱导），
 *      评审清单给规则+违规样例（要能判定）。
 *   3. 落库类型与表 schema 的 select 选项一致——新增问题类型时两处必须同改。
 *
 * 不做的事：不校验红线条目的**具体表述**。那是内容决策，随平台规则演进，
 * 不应被测试钉死；测试只守住结构与接线。
 */

import { describe, expect, it } from 'vitest'
import { ISSUE_F, TABLE, TABLE_SCHEMAS } from '@unwr/schema'
import type { Issue } from '../src/domain/consistency.ts'
import { ISSUE_TYPE, normalizeIssueSeverity } from '../src/domain/consistency.ts'
import { renderReviewFocus } from '../src/genre/review-focus.ts'
import { GENRE, LITERARY, WEBNOVEL } from '../src/genre/presets.ts'
import type { TabooTierRule } from '../src/genre/taboos.ts'
import {
  TABOO_BY_CODE, TABOO_CATALOG, TABOO_TIER_RULES, renderTabooBrief, renderTabooChecklist,
  tabooTierFromType,
} from '../src/genre/taboos.ts'

describe('TABOO_CATALOG 结构完整性', () => {
  it('编码唯一且不为空', () => {
    const codes = TABOO_CATALOG.map((t) => t.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) {
      expect(c).toMatch(/^TB_[A-Z_]+$/)
    }
  })

  it('每条都有标题、规则、违规样例与改写方向', () => {
    for (const t of TABOO_CATALOG) {
      expect(t.title.length, `${t.code} 缺标题`).toBeGreaterThan(0)
      expect(t.rule.length, `${t.code} 缺规则`).toBeGreaterThan(0)
      expect(t.examples.length, `${t.code} 缺违规样例`).toBeGreaterThan(0)
      expect(t.workaround.length, `${t.code} 缺改写方向`).toBeGreaterThan(0)
    }
  })

  it('TABOO_BY_CODE 索引与目录一致', () => {
    expect(TABOO_BY_CODE.size).toBe(TABOO_CATALOG.length)
    for (const t of TABOO_CATALOG) {
      expect(TABOO_BY_CODE.get(t.code)).toBe(t)
    }
  })

  it('notTaboo 若存在则非空（空数组会被渲染成无意义的「非违例——」后缀）', () => {
    for (const t of TABOO_CATALOG) {
      if (t.notTaboo !== undefined) {
        expect(t.notTaboo.length, `${t.code} 的 notTaboo 为空`).toBeGreaterThan(0)
        for (const line of t.notTaboo) {
          expect(line.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

/**
 * 防过杀。
 *
 * 这是本模块最容易犯、后果最严重的错：红线写成「见黑帮即报、见鬼即报」，
 * 把末日、黑帮、灵异、玄幻这些**合法类型小说**全判死。尤其要防住自相矛盾——
 * webnovel 预设的第一个题材就是「玄幻」，若红线对神魔/修炼体系误报，
 * 本模块与 presets.ts 就互相打架。
 */
describe('红线不得过杀合法题材', () => {
  const brief = renderTabooBrief()
  const checklist = renderTabooChecklist().join('\n')

  it('宗教红线明确豁免神话、志怪与架空神系（防玄幻被误报）', () => {
    const religion = TABOO_BY_CODE.get('TB_RELIGION')
    expect(religion?.notTaboo?.join('')).toContain('神话')
    expect(religion?.notTaboo?.join('')).toContain('志怪')
    expect(religion?.notTaboo?.join('')).toContain('修仙')
  })

  it('黑恶势力红线明确豁免「反派涉黑且被惩处」与反讽式处理', () => {
    const crime = TABOO_BY_CODE.get('TB_CRIME')
    const text = crime?.notTaboo?.join('') ?? ''
    expect(text).toContain('惩处')
    expect(text).toContain('黑色幽默')
  })

  it('公职红线明确豁免末日题材的「秩序崩坏」设定', () => {
    const official = TABOO_BY_CODE.get('TB_OFFICIAL')
    expect(official?.notTaboo?.join('')).toContain('末日')
  })

  it('起草简报给出可写边界（只讲禁区会让模型不敢下笔）', () => {
    expect(brief).toContain('可写边界')
  })

  it('评审清单同时给出正反样例（判定是双向的）', () => {
    expect(checklist).toContain('违规样例')
    expect(checklist).toContain('非违例')
  })
})

describe('renderTabooBrief（起草官）', () => {
  it('给规则与改写方向，不给违规样例（避免负面样例诱导模型）', () => {
    const brief = renderTabooBrief()
    for (const t of TABOO_CATALOG) {
      expect(brief).toContain(t.title)
      expect(brief).toContain(t.workaround)
    }
    // 关键不变量：起草阶段不注入违规样例
    for (const t of TABOO_CATALOG) {
      for (const ex of t.examples) {
        expect(brief).not.toContain(ex)
      }
    }
  })

  it('首行点明这是否决项', () => {
    expect(renderTabooBrief().split('\n')[0]).toContain('红线')
  })
})

describe('renderTabooChecklist（评审官）', () => {
  it('每条都带编码·档位与违规样例（评审需要判定而非回避）', () => {
    const list = renderTabooChecklist()
    expect(list.length).toBe(TABOO_CATALOG.length)
    // 清单按档位重排过，不能按下标对号入座——按编码回查
    for (const line of list) {
      const code = /\[(TB_[A-Z_]+)·/.exec(line)?.[1]
      expect(code, `清单项缺少「编码·档位」标记：${line}`).toBeTruthy()
      const t = TABOO_BY_CODE.get(code!)
      expect(t).toBeTruthy()
      expect(line).toContain(t!.rule)
      expect(line).toContain(TABOO_TIER_RULES[t!.severity].label)
      for (const ex of t!.examples) {
        expect(line).toContain(ex)
      }
    }
  })

  it('清单按档位从重到轻排列，并注明上报方式', () => {
    const list = renderTabooChecklist()
    const tiers = list.map((line) => {
      const label = /\[TB_[A-Z_]+·(.+?)\]/.exec(line)?.[1]
      return (Object.values(TABOO_TIER_RULES) as TabooTierRule[]).find((r) => r.label === label)!
    })
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]!.sortWeight).toBeLessThanOrEqual(tiers[i - 1]!.sortWeight)
    }
    // 每条都要告诉评审官按哪个类型上报，否则它只能靠猜严重度
    for (const line of list) {
      expect(line).toMatch(/按「内容红线·(严禁|高危|审慎)」上报/)
    }
  })
})

describe('落库接线', () => {
  it('ISSUE_TYPE 的值都在 ISSUE 表「问题类型」的 select 选项里', () => {
    const field = TABLE_SCHEMAS[TABLE.ISSUE]?.find((f) => f.name === ISSUE_F.TYPE)
    const options = (field?.options ?? []).map((o) => o.name)
    // 所有问题类型都应预置；缺一个就要多一次 800030005 自愈往返
    for (const v of Object.values(ISSUE_TYPE)) {
      expect(options, `检查问题表缺少选项「${v}」`).toContain(v)
    }
  })
})

/**
 * 等级的核心不变量。
 *
 * 分级的意义全在「阻断与否」上，而这个判断是
 * `blocking = severity >= threshold`，阈值随题材变化（网文 3 / 类型 2 / 纯文学 4）。
 * 所以档位的严重度必须满足一组不等式，否则分级会**随题材漂移**——
 * 同一条红线在网文下阻断、在纯文学下不阻断，这就是 bug。
 *
 * 这些断言直接把三套题材的真实阈值引进来（不写死数字），
 * 这样以后调阈值时若破坏了不等式会立刻报错。
 */
describe('分级不变量', () => {
  const THRESHOLDS = [WEBNOVEL, GENRE, LITERARY].map(
    (p) => p.consistency_weights.blocking_threshold,
  )
  const MIN_THRESHOLD = Math.min(...THRESHOLDS)
  const MAX_THRESHOLD = Math.max(...THRESHOLDS)

  it('三套题材的阈值确实不同（否则本组断言失去意义）', () => {
    expect(new Set(THRESHOLDS).size).toBeGreaterThan(1)
  })

  it('严禁与高危档：在任何题材下都阻断', () => {
    for (const tier of ['fatal', 'high'] as const) {
      expect(TABOO_TIER_RULES[tier].issueSeverity).toBeGreaterThanOrEqual(MAX_THRESHOLD)
      expect(TABOO_TIER_RULES[tier].blocks).toBe(true)
    }
  })

  it('审慎档：在任何题材下都不阻断（仅提示）', () => {
    expect(TABOO_TIER_RULES.caution.issueSeverity).toBeLessThan(MIN_THRESHOLD)
    expect(TABOO_TIER_RULES.caution.blocks).toBe(false)
  })

  it('排序权重：严禁 > 高危 > 每一条一致性问题 > 审慎', () => {
    const allWeights = [WEBNOVEL, GENRE, LITERARY].flatMap(
      (p) => renderReviewFocus(p).weights.map((w) => w.weight),
    )
    const maxConsistencyWeight = Math.max(...allWeights)
    const minConsistencyWeight = Math.min(...allWeights)
    expect(TABOO_TIER_RULES.fatal.sortWeight).toBeGreaterThan(TABOO_TIER_RULES.high.sortWeight)
    expect(TABOO_TIER_RULES.high.sortWeight).toBeGreaterThan(maxConsistencyWeight)
    // 用最小值：审慎档必须低于所有一致性项，而不只是低于最高的那条
    expect(TABOO_TIER_RULES.caution.sortWeight).toBeLessThan(minConsistencyWeight)
  })

  it('每条红线都指定了档位，且三档都非空', () => {
    const tiers = new Set(TABOO_CATALOG.map((t) => t.severity))
    expect([...tiers].sort()).toEqual(['caution', 'fatal', 'high'])
    for (const t of TABOO_CATALOG) {
      expect(TABOO_TIER_RULES[t.severity], `${t.code} 档位非法`).toBeTruthy()
    }
  })

  it('用户点名的三类（政治/军警/毒品）都在严禁档', () => {
    expect(TABOO_BY_CODE.get('TB_POLITICS')?.severity).toBe('fatal')
    expect(TABOO_BY_CODE.get('TB_OFFICIAL')?.severity).toBe('fatal')
    expect(TABOO_BY_CODE.get('TB_DRUGS')?.severity).toBe('fatal')
  })

  it('可豁免的题材元素不在严禁档（防过杀：黑帮/暴力/赌博/宗教/自杀）', () => {
    for (const code of ['TB_CRIME', 'TB_VIOLENCE', 'TB_GAMBLING', 'TB_RELIGION', 'TB_SUICIDE']) {
      expect(TABOO_BY_CODE.get(code)?.severity, `${code} 被误置为严禁档`).not.toBe('fatal')
    }
  })
})

describe('严重度归一化', () => {
  const base: Issue = { type: '', severity: 2, title: 't', location: 'l', confidence: 0.9 }

  it('红线问题的严重度由档位裁决，不采信模型自报', () => {
    // 模型把「严禁」填成 2 → 必须被纠正为 5，否则在网文（阈值 3）下悄悄不阻断
    const fixed = normalizeIssueSeverity({ ...base, type: ISSUE_TYPE.TABOO_FATAL, severity: 2 })
    expect(fixed.severity).toBe(TABOO_TIER_RULES.fatal.issueSeverity)
    // 反向：模型把「审慎」填成 5 → 必须压回 1，否则会误阻断
    const lowered = normalizeIssueSeverity({ ...base, type: ISSUE_TYPE.TABOO_CAUTION, severity: 5 })
    expect(lowered.severity).toBe(TABOO_TIER_RULES.caution.issueSeverity)
  })

  it('非红线问题原样返回（不越权改动）', () => {
    const issue = { ...base, type: ISSUE_TYPE.TIMELINE, severity: 3 }
    expect(normalizeIssueSeverity(issue)).toBe(issue)
  })

  it('类型名反查档位，无法识别时不误伤', () => {
    expect(tabooTierFromType(ISSUE_TYPE.TABOO_FATAL)).toBe('fatal')
    expect(tabooTierFromType(ISSUE_TYPE.TABOO_HIGH)).toBe('high')
    expect(tabooTierFromType(ISSUE_TYPE.TABOO_CAUTION)).toBe('caution')
    // 非红线类型 → undefined，归一化时才会原样放行
    expect(tabooTierFromType(ISSUE_TYPE.TIMELINE)).toBeUndefined()
  })
})
