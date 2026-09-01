# UnWr 题材配置与三套预设参数

> 阶段：需求定义。本篇定义**三类题材的差异如何抽象为可配置项**（功能点 L1–L9）。
> 不涉及模型与提示词实现细节。

---

## 一、核心设计原则：**统一维度，差异化取值**

三类题材（网文 / 类型小说 / 纯文学）**不是三套割裂流程**，而是：

```
同一批智能体  +  同一套参数维度  +  不同取值  =  三种写作风格
```

### 1.1 统一维度的关键技巧：语义复用

某些概念表面上三类题材各说各话，实质是同一维度。统一建模后可共用代码与存储：

| 统一维度 | 网文语义 | 类型小说语义 | 纯文学语义 |
|----------|----------|-------------|-----------|
| `stimulus` 情绪刺激密度 | **爽点**（打脸/升级/收获） | **张力点**（危机/反转/信息冲击） | **情感强度点**（情绪涌动/顿悟） |
| `hook` 章末牵引 | **悬念钩子**（断章留扣） | **信息钩子**（抛出新疑点） | **余韵**（意象收束，情绪回响） |
| `continuity` 前后呼应 | **伏笔回收**（情节性） | **线索闭环**（逻辑性） | **意象母题复现**（诗学性） |
| `verisimilitude` 可信度 | 设定服务爽点即可 | **逻辑自洽**（最高优先级） | **心理/象征真实**优先于逻辑 |

> 这样做的好处：新建题材（如"历史正剧""轻小说"）只需新增一组参数值，无需新增字段或改流程。

### 1.2 参数作用域

每个参数标注它影响哪些角色：

| 标记 | 含义 |
|------|------|
| 🎯 | 起草官（生成时直接生效） |
| ✏️ | 改稿官（改写时生效） |
| 🔍 | 评审官（诊断时的评估标尺） |
| 📋 | 大纲官（规划时生效） |
| 🧭 | 人物官 / 设定官（档案与词条维护） |

---

## 二、参数 Schema（统一维度定义）

配置以 JSON 存于**作品表「风格预设」字段**（或独立配置文档，见 L9）。

### L1 预设标识

| 参数 | 类型 | 说明 |
|------|------|------|
| `preset_id` | `select` | `webnovel` / `genre` / `literary` / `custom` |
| `preset_name` | `text` | 展示名 |
| `description` | `text` | 预设说明 |

### L2 节奏参数 `pacing`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `target_words_per_chapter` | `number` | 1500–6000 | 🎯📋 |
| `scene_count_per_chapter` | `number[min,max]` | 1–5 | 🎯📋 |
| `avg_paragraph_sentences` | `number[min,max]` | 1–8 | 🎯✏️ |
| `dialogue_ratio` | `number` | 0–1（对话占正文比例） | 🎯✏️ |
| `description_ratio` | `number` | 0–1（描写占比） | 🎯✏️ |
| `scene_switch_frequency` | `enum` | `rapid` / `moderate` / `slow` | 🎯 |
| `info_dump_tolerance` | `enum` | `low` / `medium` / `high` | 🎯✏️ |

### L3 情绪刺激密度 `stimulus`（原"爽点密度"）

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `stimulus_density` | `number` | 每千字刺激点数量，0–3 | 🎯🔍📋 |
| `stimulus_types` | `select[]` | 见下方语义映射 | 🎯📋 |
| `pressure_release_cycle` | `number` | 压抑→释放的间隔章数，2–10 | 📋🔍 |
| `stimulus_intensity_curve` | `enum` | `rising` / `wave` / `flat` | 📋🔍 |

**`stimulus_types` 语义映射**

| 网文 | 类型小说 | 纯文学 |
|------|----------|--------|
| 打脸、升级、收获、装逼、被认可、情感推进 | 危机、反转、新线索、逼近真相、时间压力 | 情绪涌动、顿悟、关系质变、意象击中 |

### L4 章末钩子 `hook`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `hook_strength` | `number` | 0–5（0=无钩，5=强断章） | 🎯✏️🔍 |
| `hook_style` | `enum` | `suspense` / `information` / `aftertaste` / `none` | 🎯✏️ |
| `force_cliffhanger` | `boolean` | 是否强制章末中断 | 🎯 |
| `hook_position` | `enum` | `last_para` / `last_scene` / `mid_scene` | 🎯 |

### L5 设定自洽 `verisimilitude`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `worldbuilding_strictness` | `number` | 1–5（5=严格自洽） | 🎯🧭🔍 |
| `rule_violation_tolerance` | `enum` | `none` / `rare` / `flexible` | 🎯🔍 |
| `explanation_style` | `enum` | `hard` / `soft` / `implicit` | 🎯✏️ |
| `setting_check_weight` | `number` | 一致性检查 H1 的权重，0–1 | 🔍 |

> `explanation_style`：`hard`=直接说明规则；`soft`=通过情节展示；`implicit`=只呈现不解释。

### L6 线索埋收 `continuity`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `clue_plant_interval` | `number` | 每隔多少章埋一次，1–5 | 📋🎯 |
| `clue_payoff_window` | `number` | 期望回收窗口（章），5–30 | 📋🔍 |
| `clue_fairness` | `number` | 1–5，线索是否必须前置可见（推理向要求高） | 🎯🔍 |
| `red_herring_density` | `number` | 干扰线索密度，0–1 | 📋 |
| `motif_recurrence` | `boolean` | 是否启用意象母题复现（纯文学向） | 🎯✏️🔍 |
| `foreshadow_check_weight` | `number` | 一致性检查 H3 的权重，0–1 | 🔍 |

### L7 语言质感 `language`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `imagery_density` | `number` | 意象密度，0–5 | 🎯✏️🔍 |
| `sentence_length_variance` | `enum` | `uniform_short` / `varied` / `uniform_long` | 🎯✏️ |
| `rhetoric_density` | `number` | 修辞密度，0–5 | 🎯✏️ |
| `lexical_register` | `enum` | `colloquial` / `neutral` / `elevated` / `archaic` | 🎯✏️ |
| `psychological_depth` | `number` | 心理描写深度，0–5 | 🎯✏️🧭 |
| `show_dont_tell` | `number` | 呈现 vs 讲述，0–5 | 🎯✏️🔍 |

### L8 叙事视角与意象 `narration`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `pov_person` | `enum` | `first` / `third_limited` / `third_omniscient` / `second` | 🎯✏️ |
| `pov_switch_allowed` | `boolean` | 章内是否允许换视角 | 🎯✏️ |
| `pov_characters_per_chapter` | `number` | 每章视角人物数上限 | 🎯📋 |
| `narrative_time` | `enum` | `linear` / `flashback` / `interleaved` | 🎯📋 |
| `narrator_reliability` | `enum` | `reliable` / `unreliable` / `ambiguous` | 🎯🧭 |
| `motif_list` | `text[]` | 意象母题清单（纯文学向核心） | 🎯✏️🔍 |

### 结构 `structure`

| 参数 | 类型 | 取值域 | 作用域 |
|------|------|--------|--------|
| `macro_structure` | `enum` | `three_act` / `kishotenketsu` / `chapter_serial` / `mystery` | 📋🔍 |
| `chapter_subdivision` | `enum` | `scene_h2` / `numbered` / `none` | 🎯📋 |

### 一致性检查权重 `consistency_weights`

| 参数 | 类型 | 说明 |
|------|------|------|
| `w_setting_conflict` | `number` | H1 设定冲突权重 |
| `w_character_break` | `number` | H2 人设崩坏权重 |
| `w_foreshadow` | `number` | H3 伏笔未回收权重 |
| `w_timeline` | `number` | H4 时间线矛盾权重 |
| `w_presence` | `number` | H5 人物方位矛盾权重 |
| `blocking_threshold` | `number` | 超过此分值的问题阻断定稿 |

---

## 三、三套预设参数（L1）

### 3.1 预设 A：中文网文 `webnovel`

> 适用：玄幻、都市、言情等。**目标：追读友好、日更可持续。**

| 维度 | 参数 | 值 |
|------|------|-----|
| **pacing** | target_words_per_chapter | **2500** |
| | scene_count_per_chapter | 2–4 |
| | avg_paragraph_sentences | 1–3（短段落，适合手机阅读） |
| | dialogue_ratio | **0.45** |
| | description_ratio | 0.20 |
| | scene_switch_frequency | `rapid` |
| | info_dump_tolerance | `low`（设定边打边说） |
| **stimulus** | stimulus_density | **1.5**（每千字约 1.5 个） |
| | stimulus_types | 打脸、升级、收获、被认可、情感推进 |
| | pressure_release_cycle | **3**（三章一爽） |
| | stimulus_intensity_curve | `rising` |
| **hook** | hook_strength | **5** |
| | hook_style | `suspense` |
| | force_cliffhanger | **true** |
| | hook_position | `last_para` |
| **verisimilitude** | worldbuilding_strictness | 3 |
| | rule_violation_tolerance | `flexible`（服务爽点优先） |
| | explanation_style | `soft` |
| | setting_check_weight | 0.3 |
| **continuity** | clue_plant_interval | 2 |
| | clue_payoff_window | 20 |
| | clue_fairness | 2 |
| | red_herring_density | 0.2 |
| | motif_recurrence | false |
| | foreshadow_check_weight | 0.4 |
| **language** | imagery_density | 1 |
| | sentence_length_variance | `uniform_short` |
| | rhetoric_density | 1 |
| | lexical_register | `colloquial` |
| | psychological_depth | 2 |
| | show_dont_tell | 3 |
| **narration** | pov_person | `third_limited` |
| | pov_switch_allowed | false（主角视角锁定） |
| | pov_characters_per_chapter | 1 |
| | narrative_time | `linear` |
| | narrator_reliability | `reliable` |
| **structure** | macro_structure | `chapter_serial` |
| | chapter_subdivision | `scene_h2` |

---

### 3.2 预设 B：类型小说 `genre`

> 适用：悬疑、推理、科幻、奇幻。**目标：逻辑自洽、线索公平、诡计成立。**

| 维度 | 参数 | 值 |
|------|------|-----|
| **pacing** | target_words_per_chapter | **4000** |
| | scene_count_per_chapter | 2–3 |
| | avg_paragraph_sentences | 3–5 |
| | dialogue_ratio | **0.35** |
| | description_ratio | 0.30 |
| | scene_switch_frequency | `moderate` |
| | info_dump_tolerance | `medium`（设定可适度说明） |
| **stimulus** | stimulus_density | **0.8** |
| | stimulus_types | 危机、反转、新线索、逼近真相、时间压力 |
| | pressure_release_cycle | **5** |
| | stimulus_intensity_curve | `rising`（持续加压至真相） |
| **hook** | hook_strength | **3** |
| | hook_style | `information` |
| | force_cliffhanger | false |
| | hook_position | `last_scene` |
| **verisimilitude** | worldbuilding_strictness | **5** |
| | rule_violation_tolerance | **`none`** |
| | explanation_style | `hard` |
| | setting_check_weight | **0.9** |
| **continuity** | clue_plant_interval | **2** |
| | clue_payoff_window | **15** |
| | clue_fairness | **5**（线索必须前置可见，保证公平） |
| | red_herring_density | 0.5（适量误导） |
| | motif_recurrence | false |
| | foreshadow_check_weight | **0.9** |
| **language** | imagery_density | 2 |
| | sentence_length_variance | `varied` |
| | rhetoric_density | 2 |
| | lexical_register | `neutral` |
| | psychological_depth | 3 |
| | show_dont_tell | 4 |
| **narration** | pov_person | `first` 或 `third_limited` |
| | pov_switch_allowed | false（限知视角是诡计前提） |
| | pov_characters_per_chapter | 1 |
| | narrative_time | `flashback`（可用倒叙） |
| | narrator_reliability | `unreliable`（可选，视诡计设计） |
| **structure** | macro_structure | `mystery` |
| | chapter_subdivision | `scene_h2` |

---

### 3.3 预设 C：纯文学 `literary`

> 适用：严肃文学、纯文学短长篇。**目标：语言质感、心理真实、意象统一。**

| 维度 | 参数 | 值 |
|------|------|-----|
| **pacing** | target_words_per_chapter | **3000**（可浮动 1500–5000） |
| | scene_count_per_chapter | 1–2 |
| | avg_paragraph_sentences | 3–8（允许长段） |
| | dialogue_ratio | **0.25** |
| | description_ratio | **0.45** |
| | scene_switch_frequency | `slow` |
| | info_dump_tolerance | `low` |
| **stimulus** | stimulus_density | **0.5** |
| | stimulus_types | 情绪涌动、顿悟、关系质变、意象击中 |
| | pressure_release_cycle | 8 |
| | stimulus_intensity_curve | `wave` |
| **hook** | hook_strength | **1** |
| | hook_style | **`aftertaste`** |
| | force_cliffhanger | **false** |
| | hook_position | `last_para` |
| **verisimilitude** | worldbuilding_strictness | 3 |
| | rule_violation_tolerance | `rare` |
| | explanation_style | **`implicit`** |
| | setting_check_weight | 0.4 |
| **continuity** | clue_plant_interval | 3 |
| | clue_payoff_window | 25 |
| | clue_fairness | 2 |
| | red_herring_density | 0 |
| | motif_recurrence | **true** |
| | foreshadow_check_weight | 0.5 |
| **language** | imagery_density | **5** |
| | sentence_length_variance | **`varied`** |
| | rhetoric_density | **4** |
| | lexical_register | `elevated` |
| | psychological_depth | **5** |
| | show_dont_tell | **5** |
| **narration** | pov_person | `first` / `third_limited` |
| | pov_switch_allowed | **true**（允许多视角） |
| | pov_characters_per_chapter | **2** |
| | narrative_time | **`interleaved`** |
| | narrator_reliability | `ambiguous` |
| | motif_list | **需作者指定**（如：水、镜子、锈） |
| **structure** | macro_structure | `kishotenketsu`（起承转合） |
| | chapter_subdivision | `none` 或 `numbered` |

---

## 四、三套预设横向对比

| 参数 | 网文 | 类型小说 | 纯文学 |
|------|------|----------|--------|
| 章节字数 | 2500 | 4000 | 3000 |
| 对话占比 | 0.45（高） | 0.35 | 0.25（低） |
| 描写占比 | 0.20（低） | 0.30 | 0.45（高） |
| 刺激点密度/千字 | **1.5** | 0.8 | **0.5** |
| 章末钩子强度 | **5** | 3 | **1** |
| 钩子风格 | 悬念断章 | 信息抛出 | **余韵** |
| 设定自洽严格度 | 3 | **5** | 3 |
| 线索公平性 | 2 | **5** | 2 |
| 意象密度 | 1 | 2 | **5** |
| 心理描写深度 | 2 | 3 | **5** |
| 视角切换 | 禁止 | 禁止（限知） | **允许** |
| 叙事时间 | 线性 | 可倒叙 | **交错** |
| 宏观结构 | 章回连载 | 谜题结构 | 起承转合 |

**一句话概括**
- **网文**：快、爽、勾人，设定服务情绪
- **类型小说**：严、密、公平，一切服务逻辑
- **纯文学**：慢、厚、有余韵，一切服务语言与心理真实

---

## 五、配置在飞书中的落点

| 配置项 | 存储位置 | 说明 |
|--------|----------|------|
| 预设整体（JSON） | 作品表「风格预设」`text` 字段 | 或独立配置文档，存 url |
| `preset_id` | 作品表「题材」`select` | 与 A3 作品元信息共用 |
| `target_words_per_chapter` | 章节表「字数」比对基准 | 起草后校验 |
| `stimulus_density` | 章节表「张力评分」评估标尺 | 评审官打分依据 |
| `motif_list` | 设定表或独立文档 | 纯文学向母题清单 |
| `consistency_weights` | 检查问题表「严重度」计算权重 | H8 报告 |
| `pov_person` | 作品表「叙事视角」`select` | 与 A3 共用 |

---

## 六、L9 自定义风格

| 功能点 | 说明 | 分档 |
|--------|------|------|
| L9-1 | 基于三套预设派生自定义预设（改参数后另存） | P2 |
| L9-2 | 从既有作品反向提取风格参数（"照着这章的感觉写"） | P2 |
| L9-3 | 预设导入导出（JSON） | P2 |
| L9-4 | 单章临时覆盖全局预设（如某章刻意慢节奏） | P1 |

> L9-4 建议实现为：章节表增加「风格覆盖」`text`（JSON）字段，起草时与全局预设做深合并。

---

## 七、待确认

| # | 问题 | 说明 |
|---|------|------|
| GC-1 | 三套预设是否足够？是否要细分（如网文下再分玄幻/都市/言情）？ | 首版先做粗粒度三套，子题材靠 `stimulus_types` 等数组参数微调 |
| GC-2 | 参数是否对用户可见可调？ | 建议：高级模式暴露全部，普通模式只给三选一 + 少量滑杆 |
| GC-3 | `motif_list` 由用户手动填还是 AI 从正文提取？ | 两者都要，P2 |
| GC-4 | 参数变更是否影响已写章节？ | 建议：不影响既有正文，仅影响后续生成；评审时可回看历史章节是否"跑偏" |
