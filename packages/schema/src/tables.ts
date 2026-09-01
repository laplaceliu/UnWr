/**
 * 飞书多维表格的表名与字段名常量。
 *
 * 为什么必须常量化：飞书 Base API 对字段名极其敏感——写错时不会报错，
 * 而是静默返回空值或忽略该字段，属于最难排查的失败模式之一。
 * 所有涉及表名/字段名的地方必须引用本文件的常量，禁止字符串字面量。
 *
 * 表结构定义见 docs/requirements/02-feishu-data-model.md
 * @module @unwr/schema/tables
 */

/** 一部作品对应一个多维表格（Base），内含以下 13 张表。 */
export const TABLE = {
  /** 作品元信息与全局配置（题材、模式、风格预设） */
  WORK: '作品表',
  /** 分卷：主题、起止、状态、卷摘要 */
  VOLUME: '卷表',
  /** 章节索引：核心表，含大纲要点与章节摘要 */
  CHAPTER: '章节表',
  /** 人物档案：性格、口癖、动机 */
  CHARACTER: '人物表',
  /** 人物状态快照：（人物 × 章节）一条记录，分层记忆的核心 */
  CHARACTER_STATE: '人物状态表',
  /** 人物关系网 */
  RELATION: '人物关系表',
  /** 世界观设定词条 */
  SETTING: '设定表',
  /** 伏笔：埋设与回收追踪 */
  FORESHADOW: '伏笔表',
  /** 主线/支线剧情线 */
  PLOTLINE: '剧情线表',
  /** 事件索引：分层记忆的事件条目 */
  EVENT: '事件表',
  /** 记忆索引：章节/卷/全书摘要的统一索引 */
  MEMORY: '记忆索引表',
  /** 卡文救援的候选分支 */
  BRANCH: '候选分支表',
  /** 一致性检查问题 */
  ISSUE: '检查问题表',
} as const

/** 章节表字段。 */
export const CHAPTER_F = {
  TITLE: '章节标题',
  VOLUME: '所属卷',
  NO: '章节号',
  WORDS: '字数',
  STATUS: '状态',
  OUTLINE: '大纲要点',
  SUMMARY: '章节摘要',
  TENSION: '张力评分',
  CAST: '出场人物',
  FORESHADOWS: '关联伏笔',
  DOC_URL: '正文文档',
  WIKI_URL: 'Wiki节点',
  STORY_TIME: '故事内时间',
  UPDATED_AT: '更新时间',
} as const

/** 章节状态流转：大纲 → 草稿 → 修订 → 定稿。 */
export const CHAPTER_STATUS = {
  OUTLINE: '大纲',
  DRAFT: '草稿',
  REVISING: '修订',
  FINAL: '定稿',
} as const

/** 人物表字段。 */
export const CHARACTER_F = {
  NAME: '姓名',
  ALIAS: '别名/称谓',
  ROLE: '身份',
  TRAITS: '性格标签',
  CATCHPHRASE: '口癖',
  MOTIVE: '核心动机',
  APPEARANCE: '外貌',
  ARC_STAGE: '人物弧光阶段',
  APPEARANCES: '出场章节',
  BIO_URL: '小传文档',
  PORTRAIT: '立绘',
} as const

/** 人物状态表字段。 */
export const CHARACTER_STATE_F = {
  CHARACTER: '人物',
  CHAPTER: '章节',
  LOCATION: '所在位置',
  PHYSICAL: '身体状况',
  EMOTION: '情绪状态',
  BELONGINGS: '持有物品',
  RELATION_CHANGE: '关系变化',
  SUMMARY: '状态摘要',
} as const

/** 设定表字段。 */
export const SETTING_F = {
  TERM: '词条名',
  CATEGORY: '分类',
  DEFINITION: '释义',
  IMPORTANCE: '重要度',
  FIRST_CHAPTER: '首次出现章节',
  RELATED: '关联设定',
  DOC_URL: '长文文档',
  STATUS: '状态',
} as const

/** 伏笔表字段。 */
export const FORESHADOW_F = {
  CONTENT: '伏笔内容',
  TYPE: '类型',
  STATUS: '状态',
  PLANT_CHAPTER: '埋设章节',
  PLAN_PAYOFF_CHAPTER: '计划回收章节',
  ACTUAL_PAYOFF_CHAPTER: '实际回收章节',
  IMPORTANCE: '重要度',
  PLANT_CHAPTER_TITLES: '埋设章节标题',
  NOTE: '备注',
} as const

/** 伏笔状态。 */
export const FORESHADOW_STATUS = {
  PLANTED: '已埋设',
  PAID_OFF: '已回收',
  VOID: '已作废',
} as const

/** 事件表字段。 */
export const EVENT_F = {
  NAME: '事件名',
  CHAPTER: '章节',
  STORY_TIME: '故事内时间',
  LOCATION: '地点',
  PARTICIPANTS: '参与人物',
  SUMMARY: '事件摘要',
  IMPACT: '影响',
  IS_TURNING_POINT: '是否关键转折',
} as const

/** 记忆索引表字段。 */
export const MEMORY_F = {
  TITLE: '摘要标题',
  LEVEL: '层级',
  FROM_CHAPTER: '覆盖起始章节',
  TO_CHAPTER: '覆盖结束章节',
  CONTENT: '摘要内容',
  CHAPTERS: '关联章节',
  CREATED_AT: '生成时间',
  STALE: '是否已过期',
} as const

/** 记忆层级。 */
export const MEMORY_LEVEL = {
  CHAPTER: '章节',
  VOLUME: '卷',
  BOOK: '全书',
} as const

/** 卷表字段。 */
export const VOLUME_F = {
  NAME: '卷名',
  ORDER: '卷序',
  THEME: '主题',
  CHAPTER_RANGE: '起止章节',
  STATUS: '状态',
  SUMMARY: '卷摘要',
  WIKI_URL: 'Wiki节点',
} as const

/** 作品表字段。 */
export const WORK_F = {
  NAME: '作品名',
  GENRE: '题材',
  SUBGENRE: '子题材',
  SCALE: '规模档位',
  TARGET_WORDS: '目标字数',
  MODE: '写作模式',
  STYLE_PRESET: '风格预设',
  POV: '叙事视角',
  CURRENT_CHAPTER: '当前进度章节',
} as const

/** 检查问题表字段。 */
export const ISSUE_F = {
  TITLE: '问题标题',
  TYPE: '问题类型',
  SEVERITY: '严重度',
  CHAPTER: '关联章节',
  CHARACTER: '关联人物',
  LOCATION: '定位描述',
  STATUS: '处理状态',
} as const

/** 剧情线表字段。 */
export const PLOTLINE_F = {
  NAME: '线名',
  TYPE: '类型',
  STATUS: '状态',
  DESCRIPTION: '描述',
  CHAPTERS: '关联章节',
  CHARACTERS: '关联人物',
  FORESHADOWS: '关联伏笔',
} as const

/** 候选分支表字段。 */
export const BRANCH_F = {
  TITLE: '分支标题',
  STUCK_CHAPTER: '卡点章节',
  DESCRIPTION: '分支描述',
  ADOPT_STATUS: '采用状态',
  NOTE: '评估备注',
} as const

/** 人物关系表字段。 */
export const RELATION_F = {
  A: '人物A',
  B: '人物B',
  TYPE: '关系类型',
  DESCRIPTION: '关系描述',
  START_CHAPTER: '起始章节',
  STATUS: '当前状态',
} as const

/** 全部表名。 */
export const ALL_TABLES = Object.values(TABLE)

export type TableName = (typeof TABLE)[keyof typeof TABLE]
export type ChapterStatus = (typeof CHAPTER_STATUS)[keyof typeof CHAPTER_STATUS]
export type ForeshadowStatus = (typeof FORESHADOW_STATUS)[keyof typeof FORESHADOW_STATUS]
export type MemoryLevel = (typeof MEMORY_LEVEL)[keyof typeof MEMORY_LEVEL]
