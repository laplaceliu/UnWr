/**
 * 题材 → 评审差异化（renderReviewFocus / weightForIssueType）。
 *
 * 验证三套题材预设确实产生可区分的评审行为——这是 03 文档第六节
 * 「同一批角色 + 不同参数」的最低要求：阈值互不相同、权重排序
 * 随题材变化、专项评估线按题材切换。
 */

import { describe, expect, it } from 'vitest'
import { ISSUE_TYPE } from '../src/domain/consistency.ts'
import { GENRE, LITERARY, WEBNOVEL } from '../src/genre/presets.ts'
import { renderReviewFocus, weightForIssueType } from '../src/genre/review-focus.ts'
import { TABOO_CATALOG } from '../src/genre/taboos.ts'

describe('renderReviewFocus', () => {
  it('网文：专项是爽点密度与追读性，阻断阈值 3', () => {
    const f = renderReviewFocus(WEBNOVEL)
    expect(f.presetId).toBe('webnovel')
    expect(f.genreFocus).toContain('爽点')
    expect(f.genreFocus).toContain('追读')
    expect(f.blockingThreshold).toBe(3)
  })

  it('类型小说：专项是诡计公平性，设定冲突权重最高', () => {
    const f = renderReviewFocus(GENRE)
    expect(f.genreFocus).toContain('公平')
    expect(f.weights[0]?.key).toBe('w_setting_conflict')
    expect(f.blockingThreshold).toBe(2)
  })

  it('纯文学：专项是语言与心理深度，人设权重最高', () => {
    const f = renderReviewFocus(LITERARY)
    expect(f.genreFocus).toContain('心理')
    expect(f.weights[0]?.key).toBe('w_character_break')
    expect(f.blockingThreshold).toBe(4)
  })

  it('三套题材的阻断阈值互不相同（差异化的最低要求）', () => {
    const thresholds = new Set(
      [WEBNOVEL, GENRE, LITERARY].map((p) => renderReviewFocus(p).blockingThreshold),
    )
    expect(thresholds.size).toBe(3)
  })

  it('加权检查项按权重降序，H7 固定末位', () => {
    const f = renderReviewFocus(GENRE)
    expect(f.checklist.at(-1)).toContain('H7')
    const weights = f.checklist
      .filter((line) => line.includes('[权重 '))
      .map((line) => Number(/\[权重 ([\d.]+)\]/.exec(line)?.[1]))
    expect(weights.length).toBeGreaterThan(1)
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!)
    }
  })

  it('语义包与评审重点共用同一份权重（不再有硬编码清单）', () => {
    // 若有人把 semantic pack 的 reviewChecklist 改回硬编码 6 条，
    // 这里只能靠 review-focus 自身兜底——该断言守住清单与权重同源
    const f = renderReviewFocus(WEBNOVEL)
    const weighted = f.checklist.filter((l) => l.includes('[权重 '))
    expect(weighted.length).toBe(5)
    expect(f.checklist.some((l) => l.includes('H1'))).toBe(true)
    expect(f.checklist.some((l) => l.includes('H2'))).toBe(true)
  })

  it('内容红线排在加权项之前，且每条都带编码·档位', () => {
    const f = renderReviewFocus(WEBNOVEL)
    const firstWeighted = f.checklist.findIndex((l) => l.includes('[权重 '))
    const lastTaboo = f.checklist.findLastIndex((l) => /\[TB_[A-Z_]+·/.test(l))
    expect(lastTaboo).toBeGreaterThanOrEqual(0)
    // 红线整体前置：最后一条红线也必须早于第一条加权项
    expect(lastTaboo).toBeLessThan(firstWeighted)
    // 编码是外部稳定标识（ISSUE 表历史记录引用它），必须逐条带上
    expect(f.checklist.filter((l) => /\[TB_[A-Z_]+·/.test(l)).length)
      .toBe(TABOO_CATALOG.length)
  })

  it('红线不随题材增减（跨题材恒定）', () => {
    const counts = [WEBNOVEL, GENRE, LITERARY].map(
      (p) => renderReviewFocus(p).checklist.filter((l) => /\[TB_[A-Z_]+·/.test(l)).length,
    )
    expect(new Set(counts).size).toBe(1)
  })
})

describe('weightForIssueType', () => {
  it('问题类型 → 题材权重映射（对照各预设真实字段）', () => {
    expect(weightForIssueType(ISSUE_TYPE.SETTING_CONFLICT, WEBNOVEL)).toBe(WEBNOVEL.consistency_weights.w_setting_conflict)
    expect(weightForIssueType(ISSUE_TYPE.CHARACTER_BREAK, WEBNOVEL)).toBe(WEBNOVEL.consistency_weights.w_character_break)
    // 称谓不一致按人设崩坏计权
    expect(weightForIssueType(ISSUE_TYPE.ADDRESS, WEBNOVEL)).toBe(WEBNOVEL.consistency_weights.w_character_break)
    expect(weightForIssueType(ISSUE_TYPE.FORESHADOW, GENRE)).toBe(GENRE.consistency_weights.w_foreshadow)
    expect(weightForIssueType(ISSUE_TYPE.TIMELINE, GENRE)).toBe(GENRE.consistency_weights.w_timeline)
    expect(weightForIssueType(ISSUE_TYPE.PRESENCE, LITERARY)).toBe(LITERARY.consistency_weights.w_presence)
  })

  it('未知类型回落到方位权重而不是 0（防新枚举漏配被沉底）', () => {
    expect(weightForIssueType('不存在的问题类型', GENRE)).toBe(GENRE.consistency_weights.w_presence)
  })

  it('严禁/高危档红线在三套题材下都排在最前（排序权重）', () => {
    for (const p of [WEBNOVEL, GENRE, LITERARY]) {
      const maxWeighted = Math.max(...renderReviewFocus(p).weights.map((w) => w.weight))
      expect(weightForIssueType(ISSUE_TYPE.TABOO_FATAL, p)).toBeGreaterThan(maxWeighted)
      expect(weightForIssueType(ISSUE_TYPE.TABOO_HIGH, p)).toBeGreaterThan(maxWeighted)
      expect(weightForIssueType(ISSUE_TYPE.TABOO_FATAL, p))
        .toBeGreaterThan(weightForIssueType(ISSUE_TYPE.TABOO_HIGH, p))
    }
  })

  it('审慎档低于该题材下每一条一致性问题（是提示不是告警）', () => {
    // 用**最小值**而非最大值：审慎档必须排在所有一致性问题之后，
    // 只比最大值小的话，它仍会盖住低权重的一致性项。
    for (const p of [WEBNOVEL, GENRE, LITERARY]) {
      const minWeighted = Math.min(...renderReviewFocus(p).weights.map((w) => w.weight))
      expect(weightForIssueType(ISSUE_TYPE.TABOO_CAUTION, p)).toBeLessThan(minWeighted)
    }
  })
})
