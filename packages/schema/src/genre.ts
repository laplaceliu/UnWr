/**
 * 题材配置参数类型。
 *
 * 三类题材（网文 / 类型小说 / 纯文学）共用同一套维度，仅取值不同。
 * 语义复用：爽点 / 张力点 / 情感强度点 统一为 `stimulus`；
 * 伏笔回收 / 线索闭环 / 意象复现 统一为 `continuity`。
 *
 * 三套预设的具体数值见 docs/requirements/04-genre-presets.md
 * @module @unwr/schema/genre
 */

/** 题材预设标识。 */
export type PresetId = 'webnovel' | 'genre' | 'literary' | 'custom'

export type Enum_T =
  | 'rapid' | 'moderate' | 'slow'
  | 'low' | 'medium' | 'high'
  | 'rising' | 'wave' | 'flat'
  | 'suspense' | 'information' | 'aftertaste' | 'none'
  | 'hard' | 'soft' | 'implicit'
  | 'colloquial' | 'neutral' | 'elevated' | 'archaic'
  | 'uniform_short' | 'varied' | 'uniform_long'
  | 'first' | 'third_limited' | 'third_omniscient' | 'second'
  | 'linear' | 'flashback' | 'interleaved'
  | 'reliable' | 'unreliable' | 'ambiguous'
  | 'three_act' | 'kishotenketsu' | 'chapter_serial' | 'mystery'
  | 'scene_h2' | 'numbered'

/** 节奏参数。 */
export interface Pacing {
  target_words_per_chapter: number
  scene_count_per_chapter: [number, number]
  avg_paragraph_sentences: [number, number]
  dialogue_ratio: number
  description_ratio: number
  scene_switch_frequency: Extract<Enum_T, 'rapid' | 'moderate' | 'slow'>
  info_dump_tolerance: Extract<Enum_T, 'low' | 'medium' | 'high'>
}

/**
 * 情绪刺激密度。
 * 网文=爽点，类型小说=张力点，纯文学=情感强度点。
 */
export interface Stimulus {
  /** 每千字刺激点数量 */
  stimulus_density: number
  stimulus_types: string[]
  /** 压抑→释放的间隔章数 */
  pressure_release_cycle: number
  stimulus_intensity_curve: Extract<Enum_T, 'rising' | 'wave' | 'flat'>
}

/** 章末钩子。网文=悬念断章，类型小说=信息抛出，纯文学=余韵。 */
export interface Hook {
  /** 0–5，0=无钩，5=强断章 */
  hook_strength: number
  hook_style: Extract<Enum_T, 'suspense' | 'information' | 'aftertaste' | 'none'>
  force_cliffhanger: boolean
  hook_position: 'last_para' | 'last_scene' | 'mid_scene'
}

/** 可信度。类型小说重逻辑自洽，纯文学重心理/象征真实。 */
export interface Verisimilitude {
  /** 1–5，5=严格自洽 */
  worldbuilding_strictness: number
  rule_violation_tolerance: 'none' | 'rare' | 'flexible'
  explanation_style: Extract<Enum_T, 'hard' | 'soft' | 'implicit'>
  setting_check_weight: number
}

/** 前后呼应。网文=伏笔回收，类型小说=线索闭环，纯文学=意象母题复现。 */
export interface Continuity {
  /** 每隔多少章埋一次 */
  clue_plant_interval: number
  /** 期望回收窗口（章） */
  clue_payoff_window: number
  /** 1–5，推理向要求线索必须前置可见 */
  clue_fairness: number
  red_herring_density: number
  motif_recurrence: boolean
  foreshadow_check_weight: number
}

/** 语言质感。 */
export interface Language {
  imagery_density: number
  sentence_length_variance: Extract<Enum_T, 'uniform_short' | 'varied' | 'uniform_long'>
  rhetoric_density: number
  lexical_register: Extract<Enum_T, 'colloquial' | 'neutral' | 'elevated' | 'archaic'>
  psychological_depth: number
  show_dont_tell: number
}

/** 叙事视角与意象。 */
export interface Narration {
  pov_person: Extract<Enum_T, 'first' | 'third_limited' | 'third_omniscient' | 'second'>
  pov_switch_allowed: boolean
  pov_characters_per_chapter: number
  narrative_time: Extract<Enum_T, 'linear' | 'flashback' | 'interleaved'>
  narrator_reliability: Extract<Enum_T, 'reliable' | 'unreliable' | 'ambiguous'>
  /** 意象母题清单，纯文学向核心 */
  motif_list: string[]
}

/** 宏观结构。 */
export interface Structure {
  macro_structure: Extract<Enum_T, 'three_act' | 'kishotenketsu' | 'chapter_serial' | 'mystery'>
  chapter_subdivision: Extract<Enum_T, 'scene_h2' | 'numbered' | 'none'>
}

/** 一致性检查权重。 */
export interface ConsistencyWeights {
  w_setting_conflict: number
  w_character_break: number
  w_foreshadow: number
  w_timeline: number
  w_presence: number
  /** 超过此分值的问题阻断定稿 */
  blocking_threshold: number
}

/** 完整题材配置。 */
export interface GenrePreset {
  preset_id: PresetId
  preset_name: string
  description?: string
  pacing: Pacing
  stimulus: Stimulus
  hook: Hook
  verisimilitude: Verisimilitude
  continuity: Continuity
  language: Language
  narration: Narration
  structure: Structure
  consistency_weights: ConsistencyWeights
}
