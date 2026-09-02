/**
 * 题材 → 评审侧差异化（docs/requirements/03-agent-matrix.md 第六节）。
 *
 * 三类题材不是三套流程，而是**同一批角色 + 不同参数**。对评审官而言，
 * 差异化体现在三处：
 *   1. 检查项排序 —— consistency_weights 的 w_* 决定先看什么
 *   2. 阻断阈值 —— blocking_threshold 决定什么算「可能阻断定稿」
 *   3. 专项评估重点 —— 网文看爽点追读、类型看诡计公平、纯文学看语言心理
 *
 * 为什么是运行时渲染而不是 persona：7 个 persona 是静态 YAML，
 * 不随作品的题材字段变化；评审重点必须由工具按作品配置实时产出。
 * （起草官的差异化走 novel_build_context 的 writingGuide，与本模块互补。）
 *
 * @module @unwr/novel/genre/review-focus
 */

import type { GenrePreset } from '@unwr/schema'
import { ISSUE_TYPE } from '../domain/consistency.ts'

/** 评审重点包（novel_get_review_focus 的返回形状）。 */
export interface ReviewFocus {
  presetId: GenrePreset['preset_id']
  presetName: string
  /** 题材专项评估重点（一句话，评审时优先看） */
  genreFocus: string
  /** 检查权重（短标签），按降序排列 */
  weights: { key: string; label: string; weight: number }[]
  /** 严重度 ≥ 此值的问题视为可能阻断定稿 */
  blockingThreshold: number
  /** 语义检查清单，按权重降序（H7 无题材权重，固定末位） */
  checklist: string[]
}

/** 语义检查项：清单文案与对应的权重键。 */
const CHECK_ITEMS: { key: keyof GenrePreset['consistency_weights']; label: string }[] = [
  { key: 'w_setting_conflict', label: 'H1 设定冲突：本章描写是否与设定词条矛盾？' },
  { key: 'w_character_break', label: 'H2 人设崩坏：性格标签、口癖、核心动机、知识边界是否被违背？' },
  { key: 'w_foreshadow', label: 'H3 伏笔埋收：未回收伏笔是否逾期？本章是否兑现前文承诺？' },
  { key: 'w_timeline', label: 'H4 时序：本章故事内时间与事件顺序是否自洽？' },
  { key: 'w_presence', label: 'H5 方位/状态：人物位置与身体状况是否与既有快照衔接？' },
]

/** 权重键 → 短标签（weights 数组展示用）。 */
const WEIGHT_LABELS: Record<string, string> = {
  w_setting_conflict: '设定冲突',
  w_character_break: '人设崩坏',
  w_foreshadow: '伏笔埋收',
  w_timeline: '时序',
  w_presence: '方位/状态',
}

/** 题材专项评估重点（03 文档第六节「评审官」行）。 */
function genreFocusOf(p: GenrePreset): string {
  switch (p.preset_id) {
    case 'webnovel':
      return `评估爽点密度与追读性：每千字约 ${p.stimulus.stimulus_density} 个刺激点`
        + `（${p.stimulus.stimulus_types.join('、')}），章末钩子强度 ${p.hook.hook_strength}/5`
        + `${p.hook.force_cliffhanger ? '，必须留悬念' : ''}`
    case 'genre':
      return `评估诡计公平性与自洽性：线索公平性 ${p.continuity.clue_fairness}/5，`
        + `伏笔回收窗口约 ${p.continuity.clue_payoff_window} 章，`
        + `设定自洽严格度 ${p.verisimilitude.worldbuilding_strictness}/5（最高优先级）`
    case 'literary':
      return `评估语言、叙事视角、心理深度：意象密度 ${p.language.imagery_density}/5，`
        + `心理深度 ${p.language.psychological_depth}/5`
        + `${p.narration.motif_list.length > 0 ? `，意象母题需复现：${p.narration.motif_list.join('、')}` : ''}`
    default:
      return p.description ?? ''
  }
}

/** 按作品题材渲染评审重点。 */
export function renderReviewFocus(p: GenrePreset): ReviewFocus {
  const weighted = CHECK_ITEMS
    .map((it) => ({ ...it, weight: p.consistency_weights[it.key] }))
    .sort((a, b) => b.weight - a.weight)

  return {
    presetId: p.preset_id,
    presetName: p.preset_name,
    genreFocus: genreFocusOf(p),
    weights: weighted.map((it) => ({
      key: it.key,
      label: WEIGHT_LABELS[it.key] ?? it.key,
      weight: it.weight,
    })),
    blockingThreshold: p.consistency_weights.blocking_threshold,
    checklist: [
      ...weighted.map((it) => `[权重 ${it.weight.toFixed(2)}] ${it.label}`),
      'H7 前后矛盾：本章陈述是否与历史章节摘要冲突？（无题材权重，固定检查）',
    ],
  }
}

/**
 * 规则型问题类型 → 该题材下的检查权重。
 *
 * 用于两处：问题列表的跨类型排序（权重降序）、以及让模型感知
 * 「在当前题材下这类问题有多重要」。称谓不一致按人设崩坏计权。
 */
export function weightForIssueType(type: string, p: GenrePreset): number {
  const w = p.consistency_weights
  switch (type) {
    case ISSUE_TYPE.SETTING_CONFLICT: return w.w_setting_conflict
    case ISSUE_TYPE.CHARACTER_BREAK:
    case ISSUE_TYPE.ADDRESS: return w.w_character_break
    case ISSUE_TYPE.FORESHADOW: return w.w_foreshadow
    case ISSUE_TYPE.TIMELINE: return w.w_timeline
    default: return w.w_presence
  }
}
