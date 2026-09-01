/**
 * 三套题材预设。
 *
 * 设计原则：**统一维度，差异化取值**。三类题材共用同一套参数维度，
 * 语义复用（爽点/张力点/情感强度点 统一为 stimulus），
 * 因此新增题材只需加一组数值，无需新增字段或改流程。
 *
 * 参数定义见 docs/requirements/04-genre-presets.md
 * @module @unwr/novel/genre/presets
 */

import type { GenrePreset, PresetId } from '@unwr/schema'

/**
 * 预设 A：中文网文。目标：追读友好、日更可持续。
 * 快、爽、勾人，设定服务情绪。
 */
export const WEBNOVEL: GenrePreset = {
  preset_id: 'webnovel',
  preset_name: '中文网文',
  description: '玄幻/都市/言情等。重节奏、爽点、章末钩子，日更友好。',
  pacing: {
    target_words_per_chapter: 2500,
    scene_count_per_chapter: [2, 4],
    avg_paragraph_sentences: [1, 3],
    dialogue_ratio: 0.45,
    description_ratio: 0.20,
    scene_switch_frequency: 'rapid',
    info_dump_tolerance: 'low',
  },
  stimulus: {
    stimulus_density: 1.5,
    stimulus_types: ['打脸', '升级', '收获', '被认可', '情感推进'],
    pressure_release_cycle: 3,
    stimulus_intensity_curve: 'rising',
  },
  hook: {
    hook_strength: 5,
    hook_style: 'suspense',
    force_cliffhanger: true,
    hook_position: 'last_para',
  },
  verisimilitude: {
    worldbuilding_strictness: 3,
    rule_violation_tolerance: 'flexible',
    explanation_style: 'soft',
    setting_check_weight: 0.3,
  },
  continuity: {
    clue_plant_interval: 2,
    clue_payoff_window: 20,
    clue_fairness: 2,
    red_herring_density: 0.2,
    motif_recurrence: false,
    foreshadow_check_weight: 0.4,
  },
  language: {
    imagery_density: 1,
    sentence_length_variance: 'uniform_short',
    rhetoric_density: 1,
    lexical_register: 'colloquial',
    psychological_depth: 2,
    show_dont_tell: 3,
  },
  narration: {
    pov_person: 'third_limited',
    pov_switch_allowed: false,
    pov_characters_per_chapter: 1,
    narrative_time: 'linear',
    narrator_reliability: 'reliable',
    motif_list: [],
  },
  structure: {
    macro_structure: 'chapter_serial',
    chapter_subdivision: 'scene_h2',
  },
  consistency_weights: {
    w_setting_conflict: 0.3,
    w_character_break: 0.5,
    w_foreshadow: 0.4,
    w_timeline: 0.3,
    w_presence: 0.4,
    blocking_threshold: 3,
  },
}

/**
 * 预设 B：类型小说。目标：逻辑自洽、线索公平、诡计成立。
 * 严、密、公平，一切服务逻辑。
 */
export const GENRE: GenrePreset = {
  preset_id: 'genre',
  preset_name: '类型小说',
  description: '悬疑/推理/科幻/奇幻。重诡计逻辑、设定自洽、线索埋设与回收。',
  pacing: {
    target_words_per_chapter: 4000,
    scene_count_per_chapter: [2, 3],
    avg_paragraph_sentences: [3, 5],
    dialogue_ratio: 0.35,
    description_ratio: 0.30,
    scene_switch_frequency: 'moderate',
    info_dump_tolerance: 'medium',
  },
  stimulus: {
    stimulus_density: 0.8,
    stimulus_types: ['危机', '反转', '新线索', '逼近真相', '时间压力'],
    pressure_release_cycle: 5,
    stimulus_intensity_curve: 'rising',
  },
  hook: {
    hook_strength: 3,
    hook_style: 'information',
    force_cliffhanger: false,
    hook_position: 'last_scene',
  },
  verisimilitude: {
    worldbuilding_strictness: 5,
    rule_violation_tolerance: 'none',
    explanation_style: 'hard',
    setting_check_weight: 0.9,
  },
  continuity: {
    clue_plant_interval: 2,
    clue_payoff_window: 15,
    clue_fairness: 5,
    red_herring_density: 0.5,
    motif_recurrence: false,
    foreshadow_check_weight: 0.9,
  },
  language: {
    imagery_density: 2,
    sentence_length_variance: 'varied',
    rhetoric_density: 2,
    lexical_register: 'neutral',
    psychological_depth: 3,
    show_dont_tell: 4,
  },
  narration: {
    pov_person: 'first',
    pov_switch_allowed: false,
    pov_characters_per_chapter: 1,
    narrative_time: 'flashback',
    narrator_reliability: 'unreliable',
    motif_list: [],
  },
  structure: {
    macro_structure: 'mystery',
    chapter_subdivision: 'scene_h2',
  },
  consistency_weights: {
    w_setting_conflict: 0.9,
    w_character_break: 0.7,
    w_foreshadow: 0.9,
    w_timeline: 0.8,
    w_presence: 0.7,
    blocking_threshold: 2,
  },
}

/**
 * 预设 C：纯文学。目标：语言质感、心理真实、意象统一。
 * 慢、厚、有余韵，一切服务语言与心理真实。
 */
export const LITERARY: GenrePreset = {
  preset_id: 'literary',
  preset_name: '纯文学',
  description: '严肃文学。重语言质感、叙事视角、意象与人物心理深度。',
  pacing: {
    target_words_per_chapter: 3000,
    scene_count_per_chapter: [1, 2],
    avg_paragraph_sentences: [3, 8],
    dialogue_ratio: 0.25,
    description_ratio: 0.45,
    scene_switch_frequency: 'slow',
    info_dump_tolerance: 'low',
  },
  stimulus: {
    stimulus_density: 0.5,
    stimulus_types: ['情绪涌动', '顿悟', '关系质变', '意象击中'],
    pressure_release_cycle: 8,
    stimulus_intensity_curve: 'wave',
  },
  hook: {
    hook_strength: 1,
    hook_style: 'aftertaste',
    force_cliffhanger: false,
    hook_position: 'last_para',
  },
  verisimilitude: {
    worldbuilding_strictness: 3,
    rule_violation_tolerance: 'rare',
    explanation_style: 'implicit',
    setting_check_weight: 0.4,
  },
  continuity: {
    clue_plant_interval: 3,
    clue_payoff_window: 25,
    clue_fairness: 2,
    red_herring_density: 0,
    motif_recurrence: true,
    foreshadow_check_weight: 0.5,
  },
  language: {
    imagery_density: 5,
    sentence_length_variance: 'varied',
    rhetoric_density: 4,
    lexical_register: 'elevated',
    psychological_depth: 5,
    show_dont_tell: 5,
  },
  narration: {
    pov_person: 'first',
    pov_switch_allowed: true,
    pov_characters_per_chapter: 2,
    narrative_time: 'interleaved',
    narrator_reliability: 'ambiguous',
    motif_list: [],
  },
  structure: {
    macro_structure: 'kishotenketsu',
    chapter_subdivision: 'none',
  },
  consistency_weights: {
    w_setting_conflict: 0.4,
    w_character_break: 0.6,
    w_foreshadow: 0.5,
    w_timeline: 0.4,
    w_presence: 0.5,
    blocking_threshold: 4,
  },
}

/** 全部预设。 */
export const PRESETS: Record<Exclude<PresetId, 'custom'>, GenrePreset> = {
  webnovel: WEBNOVEL,
  genre: GENRE,
  literary: LITERARY,
}

/** 取预设，未知 id 回落到网文预设。 */
export function getPreset(id: PresetId): GenrePreset {
  if (id === 'custom') return WEBNOVEL
  return PRESETS[id] ?? WEBNOVEL
}
