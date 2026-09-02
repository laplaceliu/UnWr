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

  it('checklist 按权重降序，H7 固定末位', () => {
    const f = renderReviewFocus(GENRE)
    expect(f.checklist.at(-1)).toContain('H7')
    const weights = f.checklist.slice(0, -1)
      .map((line) => Number(/\[权重 ([\d.]+)\]/.exec(line)?.[1]))
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!)
    }
  })

  it('语义包与评审重点共用同一份权重（不再有硬编码清单）', () => {
    // 若有人把 semantic pack 的 reviewChecklist 改回硬编码 6 条，
    // 这里只能靠 review-focus 自身兜底——该断言守住清单与权重同源
    const f = renderReviewFocus(WEBNOVEL)
    expect(f.checklist.length).toBe(6) // 5 个加权项 + H7
    expect(f.checklist.some((l) => l.includes('H1'))).toBe(true)
    expect(f.checklist.some((l) => l.includes('H2'))).toBe(true)
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
})
