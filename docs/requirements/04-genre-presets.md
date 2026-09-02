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

## 五、不参与差异化取值的内容红线

### 5.1 为什么红线不进预设参数

本篇全篇在讲「同一批维度 + 不同取值」。**内容红线是这个原则的例外与边界**：
它跨题材恒定，任何题材下都取同一个值（禁止），不写进 `GenrePreset` 的任何字段。

放进预设会出两类事故：

- **题材切换导致红线漂移**：把红线写进网文预设，切到纯文学时红线就"消失"了，
  而领导人负面在纯文学里一样封书。
- **被当成可权衡的权重**：`consistency_weights` 是 0–1 的相对权重，各项之间
  可以互相 pk（"设定冲突 0.90 比方位矛盾 0.15 重要"）。红线不能 pk——
  命中即阻断，不与文笔、爽点、一致性做任何权衡。

> 判据：**这条约束是"做得好不好"还是"会不会死"？** 前者进预设参数，
> 后者进红线目录。涉黄擦边是"会不会死"，爽点密度是"做得好不好"。
> 命中判定还要过第二关，见 5.4。

实现落点：`packages/novel/src/genre/taboos.ts`（目录 + 两个渲染器），
与 `presets.ts` 平级但互不引用。

### 5.2 红线清单

来源：知乎专栏《网文新手训练营基础篇：网文禁忌》(zhuanlan.zhihu.com/p/85711550)，
并参照起点/番茄/晋江公开审核标准归纳。

**按严重程度分三档**（分档依据见 5.5）：

| 编码 | 红线 | 档位 | 规则 | 合规改写方向 |
|------|------|------|------|-------------|
| `TB_POLITICS` | 政治题材 | **严禁** | 不写现实政治体制、政党、政策评价及现任/历史领导人（含化名影射） | 整体搬进架空世界，冲突落在人物野心与利益分配 |
| `TB_ETHNIC` | 民族与历史 | **严禁** | 不贬损民族与地域群体；不歪曲英雄烈士与既定历史结论 | 冲突写在个体之间，不上升为群体属性 |
| `TB_OFFICIAL` | 公职人员形象 | **严禁** | 军警法消防等不得作为系统性反派，不描写整体腐败 | 可以有坏个体，但必须有同系统正面力量纠正；机构名架空 |
| `TB_SEXUAL` | 涉黄擦边 | **严禁** | 不做露骨性描写、性暗示、低俗擦边（封书最多的原因） | 写到情绪与心理即止，用留白代替过程 |
| `TB_DRUGS` | 毒品 | **严禁** | 不美化、不教授毒品；不写制毒贩毒流程与吸毒快感 | 只作反派罪行与受害者悲剧，且必须被惩处 |
| `TB_MINOR` | 未成年人 | **严禁** | 不写未成年人恋爱与不伦关系；不写未成年人犯罪细节 | 主角设为成年人；校园情节写友情、成长、竞争 |
| `TB_RELIGION` | 宗教宣扬 | **高危** | 不宣扬、不传教、不贬损现实宗教；不出现邪教组织及教义 | 宗教只做背景与动机，不做教义论证；体系化信仰用架空神系 |
| `TB_VIOLENCE` | 暴力血腥 | **高危** | 不写酷刑、肢解、虐杀过程；不传授犯罪手法 | 写结果与人物反应，不写过程；犯罪写动机与破绽 |
| `TB_GAMBLING` | 赌博 | **高危** | 不美化赌博，不写赌术教程与赌场经营细节 | 赌局只写抉择与后果，不写手法；主角靠能力而非运气 |
| `TB_CRIME` | 黑恶势力 | **高危** | 不美化黑社会帮派；不写入会仪式与组织运作细节 | 涉黑必有法律后果；江湖感架空为门派、商会、佣兵团 |
| `TB_SUICIDE` | 自杀自残 | **高危** | 不美化、不鼓励，不写具体方法与过程 | 写危机心理与被救回的转折，落点在他人伤痛 |
| `TB_REAL_ENTITY` | 真实地名国名 | 审慎 | 不使用真实地名、真实国名作为故事舞台 | 一律架空化（燕京/金陵/江城、大夏/龙国/联邦）——改名即可，情节不动 |
| `TB_INTL` | 国际关系 | 审慎 | 不煽动对他国、他民族的仇恨 | 国际冲突搬进架空世界，用虚构邻国承载 |
| `TB_PLAGIARISM` | 抄袭洗稿 | 审慎 | 不复制、不洗稿他人作品的人物、设定与段落 | 可借鉴方向，具体设定必须重设；致敬化为对话式彩蛋 |

### 5.3 三个消费方与注入点

红线本身不随题材变，但**注入方式**随角色变——这是本模块与预设体系的唯一交点：

| 消费方 | 注入点 | 形态 | 为什么 |
|--------|--------|------|--------|
| 起草官 | `novel_build_context` 的 `writingGuide` | **只给规则 + 改写方向 + 可写边界**，不给违规样例 | 起草时注入负面样例会诱导模型往那个方向写（"不要想白熊"效应）。给替代方案即可 |
| 评审官 | `novel_get_review_focus` 的 `checklist` | **带稳定编码 + 违规样例 + 非违例样例**，排在加权项之前 | 评审需要**判定**而非**回避**，要能对照正文对号入座 |
| 主编排官 | `WRITING_CONVENTIONS` 第 13 条 | 不列清单，只讲三条纪律 | 清单由上述两个工具自动下发，编排层只需要知道"委托时必须把红线作为约束带上" |

### 5.4 防过杀：每条红线都要给正反两面样例

红线模块最容易犯、后果最严重的错不是漏报，是**误报**——把合法类型小说全判死。

成因很直接：末日、黑帮、灵异、玄幻、刑侦这些题材**天然包含**暴力、犯罪、
鬼神元素。只给违规样例的清单，会让评审官见「黑帮」就报、见「鬼」就报。
误报与漏报一样有害——误报多了，作者会直接关掉红线检查，红线就形同虚设。

更硬的自洽性问题：**webnovel 预设的第一个题材就是「玄幻」**。若红线对神魔、
修炼体系误报，本模块与 `presets.ts` 直接互相打架。

因此 `TabooEntry` 除 `rule` / `examples` / `workaround` 外还有 `notTaboo`

（**不属于**本条红线的情形），两个渲染器都输出它：

| 红线 | 必须豁免（否则过杀） |
|------|---------------------|
| `TB_RELIGION` | 神话人物（玉帝、阎王、龙王、哪吒）属传统文化；志怪/灵异/鬼怪题材本身可写；玄幻/修仙的架空神系与修炼体系 |
| `TB_CRIME` | 角色是帮派成员本身不违规——违规的是**美化**；反派涉黑且被法律惩处是合规落点；黑色幽默/反讽式处理 |
| `TB_VIOLENCE` | 写结果而非过程；末日/悬疑/刑侦/战争的正当暴力描写；危险氛围营造 |
| `TB_OFFICIAL` | 末日题材「秩序崩坏、无人救援」的设定；虚构机构名写负面情节 |
| `TB_SUICIDE` | 为保护他人而牺牲（见义勇为）是正面描写，与自杀两回事；危机心理与被救回的转折 |

> **判据补充（5.1 的判据只分了"好不好" vs "会不会死"）**：
> 判定命中时要再问一句——**这段是在"呈现"还是在"宣扬/美化/教授"？**
> 呈现黑帮的荒诞 ≠ 美化黑道；写鬼怪故事 ≠ 宣扬封建迷信；
> 写角色的求生挣扎 ≠ 鼓励自杀。禁的是后者。

### 5.5 三档分级：为什么中间那档不能省

最容易想到的分法是「红线 / 审慎」两档。**不够用**——中间那一档才是改写
工作量最大的地方，把它并入任一端都会出错：

- **并入严禁** → 模型拒绝写黑帮、暴力、赌博、灵异，连合法类型小说都不敢下笔。
- **并入审慎** → 模型当建议听，写出「美化黑道」后被封书。

三档的划分依据是**是否存在合法的呈现方式**（可豁免程度），不是题材类别：

| 档位 | 判据 | 处置 | 严重度 | 排序权重 |
|------|------|------|--------|----------|
| **严禁** `fatal` | 违禁内容本身**无合法呈现方式**，出现即违规 | 必须改掉，**不接受任何权衡** | 5 | 99 |
| **高危** `high` | 内容**可写**，但必须满足强约束（反面呈现 / 只写结果 / 架空化） | 按改写方向改完即可放行 | 4 | 90 |
| **审慎** `caution` | 主要靠技巧规避，后果相对轻（改名 / 重写即可） | **仅提示，不阻断创作** | 1 | 0.1 |

严重度取值受制于 `blocking = severity >= threshold`，而阈值随题材变化
（网文 3 / 类型小说 2 / 纯文学 4）。因此这两个数是**算出来的**，不是拍的：

- 严禁 5、高危 4 → 恒 ≥ 最大阈值 4，**三套题材下都阻断**。
- 审慎 1 → 恒 < 最小阈值 2，**三套题材下都不阻断**。

排序权重同理：高危 90 恒高于最大一致性权重 0.9；审慎 0.1 恒低于最小一致性
权重 0.3（网文的设定冲突与时间线）——审慎档要排在**每一条**一致性问题之后，
而不只是排在最高的那条之后。

> 这三个不等式的成立由 `taboos.spec.ts` 的「分级不变量」用三套题材的
> **真实阈值与真实权重**断言，不写死数字。日后调阈值若破坏了不等式会立刻报错。

**严重度由档位裁决，不采信模型自报。** `blocking` 取决于 `severity`，
若让模型自由填 1–5，「严禁」档被填成 2，在网文（阈值 3）下就悄悄不阻断了。
模型对数字约定遵循得很差，但选「严禁/高危/审慎」这档判断很稳，所以
`normalizeIssueSeverity()` 在**排序算阻断之前**和**落库时**两处收口校正。

### 5.6 落库

评审命中红线 → 写入检查问题表，问题类型按档位取 **`内容红线·严禁`** /
**`内容红线·高危`** / **`内容红线·审慎`**（`ISSUE_TYPE.TABOO_FATAL` /
`TABOO_HIGH` / `TABOO_CAUTION`）。严重度由档位自动裁定，见 5.5。

> 两处必须同改：`domain/consistency.ts` 的 `ISSUE_TYPE` 与
> `schema/src/work-schema.ts` 中 `ISSUE.TYPE` 的 select 选项
> （有 `taboos.spec.ts` 断言守着；写入侧另有 800030005 自愈兜底）。

---

## 六、配置在飞书中的落点

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

## 七、L9 自定义风格

| 功能点 | 说明 | 分档 |
|--------|------|------|
| L9-1 | 基于三套预设派生自定义预设（改参数后另存） | P2 |
| L9-2 | 从既有作品反向提取风格参数（"照着这章的感觉写"） | P2 |
| L9-3 | 预设导入导出（JSON） | P2 |
| L9-4 | 单章临时覆盖全局预设（如某章刻意慢节奏） | P1 |

> L9-4 建议实现为：章节表增加「风格覆盖」`text`（JSON）字段，起草时与全局预设做深合并。

---

## 八、待确认

| # | 问题 | 说明 |
|---|------|------|
| GC-1 | 三套预设是否足够？是否要细分（如网文下再分玄幻/都市/言情）？ | 首版先做粗粒度三套，子题材靠 `stimulus_types` 等数组参数微调 |
| GC-2 | 参数是否对用户可见可调？ | 建议：高级模式暴露全部，普通模式只给三选一 + 少量滑杆 |
| GC-3 | `motif_list` 由用户手动填还是 AI 从正文提取？ | 两者都要，P2 |
| GC-4 | 参数变更是否影响已写章节？ | 建议：不影响既有正文，仅影响后续生成；评审时可回看历史章节是否"跑偏" |
