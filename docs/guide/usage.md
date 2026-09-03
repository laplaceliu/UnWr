# 使用手册

本文档面向**主编排官**（DSH 主会话内的模型）与人值守时的运维/调试人员。所有功能都以 DSH 主会话 + `novel_*` 工具调用落地；不需要浏览器。

---

## 1. 整体编排流程

```
┌──────────────────────────────────────────────────────────────────┐
│  DSH 主会话 = 主编排官（不单独注册）                               │
│  入口：用户提问 → 主会话判断意图 → 调 1 个 novel_agent_* 委托工具  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ toolFilter 是硬约束
        ┌────────┬────────┬────┴────┬────────┬────────┬────────┐
        ▼        ▼        ▼         ▼        ▼        ▼        ▼
   世界官   人物官   大纲官   起草官   改稿官   评审官   救火官
        │        │        │         │        │        │        │
        ▼        ▼        ▼         ▼        ▼        ▼        ▼
   28 个 novel_* 工具（受 persona 约束 + toolFilter 硬约束）
        │
        ▼
   飞书 bitable (13 表) + docx (章节正文)
```

**编排规则**（写在 `cordis.patch.yml` 顶层 + 各 persona）：

1. **每次调子代理前先 `novel_manage_work action=list` 确认当前作品**——不传 `workToken` 会用会话级默认作品（重启后从 `~/.unwr/work-state.json` 恢复）。
2. **子代理只能看 `toolFilter.allow` 列出的工具**——例如评审官拿不到任何写工具，救火官拿不到 `novel_write_chapter`。
3. **标签纪律**：每次调子代理传 `task` 字段时显式标注阶段标签（`# 起草` / `# 改稿` / `# 评审` / `# 沉淀`），跨子代理上下文对齐靠它。
4. **委托范围纪律**：删改已有正文 → 改稿官；跨表核对不要塞给设定官；只读查询允许任意子代理并行。
5. **chmod 沙箱**：DSH 主会话自带工具审批 + 超时；危险操作（覆盖式写入、回滚）走 `pre-execute` 钩子拦截。

---

## 2. 工具按意图分类（28 个）

### 2.1 作品管理（1 个）

| 工具 | 用途 | 备注 |
|---|---|---|
| `novel_manage_work` | 创建 / 查询 / 切换 / 列表作品 | `action: list\|create\|get\|switch`；维护会话级默认作品 |

**典型用法：**

```json
// 第一次进入：列已有作品
{ "action": "list" }

// 找不到？直接新建
{ "action": "create", "workToken": "<BASE_TOKEN>", "name": "洗骨录", "genre": "中文网文", "subgenre": "玄幻", "scale": "长篇连载", "mode": "协作助手", "pov": "第三人称限知", "targetWords": 1000000 }

// 切换默认作品
{ "action": "switch", "workToken": "<BASE_TOKEN>" }

// 后续所有工具调用都可省 workToken（除非切到新作品）
```

> **作品注册表**：`~/.unwr/work-state.json`（仓库外，隐私红线）。重启 DSH 进程后 `lastWorkToken` 自动恢复；list 时本地独有条目标 `source: 'local'` + warnings（飞书搜索索引分钟级延迟是已知现象）。

### 2.2 实体管理（3 个）

| 工具 | 用途 |
|---|---|
| `novel_manage_setting` | 设定词条 CRUD（地理 / 势力 / 规则 / 历史 / 物品 / 功法） |
| `novel_manage_character` | 人物 CRUD（姓名 / 别名 / 角色定位 / 首次出场章节） |
| `novel_manage_relation` | 人物关系 CRUD（亲属 / 师徒 / 对手 / 暧昧…） |

**典型用法：**

```json
// 新增人物
{ "action": "upsert", "name": "陆铮", "alias": "陆小侯爷", "role": "主角", "firstAppearanceChapter": 1 }

// 同一关系
{ "action": "upsert", "type": "师徒", "characterA": "陆铮", "characterB": "白衍", "intensity": 5, "note": "开篇第二章拜师" }

// 查本卷用到的设定（带 link 拉全字段本地筛）
{ "action": "query", "category": "功法" }
```

> **persona 限 action=query**：设定官 / 人物官子代理调 `novel_manage_character` 只能 `query`，不能 `upsert`——避免跨子代理的并发写入污染。

### 2.3 上下文构建（1 个）

| 工具 | 用途 |
|---|---|
| `novel_build_context` | 拼装分层上下文（L0 元数据 / L1 章节 / L2 卷 / L3 全书），含题材指引 `writingGuide` |

**典型用法：**

```json
{ "chapterNo": 12 }   // 返回约 30-80KB 结构化上下文
```

返回结构：

- `meta`：作品名 / 题材 / 子题材 / 写作模式 / 视角
- `writingGuide`：根据题材预设生成的写作指引（节奏 / 爽点密度 / 钩子强度 / 红线）
- `chapters[]`：当前章前后各 3 章的标题 + 字数 + 大纲 + 摘要
- `volumes[]`：当前卷及相邻卷的主题 + 章节范围 + 状态
- `activeCharacters`：当前章出场人物的状态快照 + 关系网络
- `pendingForeshadows`：未回收的伏笔清单
- `recentEvents`：最近 10 条剧情事件
- `recalledMemories`：与当前章相关的 L1 / L2 / L3 记忆

> **不传 `chapterNo`** 自动取作品表 `current_chapter` 字段。

### 2.4 章节正文（4 个）

| 工具 | 用途 |
|---|---|
| `novel_write_chapter` | 起草新章（含 `cast` 参数→双向写入章节表.出场人物 + 人物表.出场章节） |
| `novel_read_chapter` | 读章节正文（`mode: full\|outline\|search`） |
| `novel_append_chapter` | 追加正文到章末（分批起草 / 救火补全） |
| `novel_list_scenes` | 列本章场景（按段落 / 空行切分，含 sceneId） |

**典型用法：**

```json
// 写第 12 章
{
  "chapterNo": 12,
  "title": "陆铮初入听剑阁",
  "content": "## 场景一：入门考核\n\n陆铮踏进听剑阁的正门……\n\n## 场景二：剑诀初试\n\n……",
  "cast": ["陆铮", "白衍", "周长老"]   // 双向写入；写章优先于 cast 警告
}

// 读章节大纲
{ "chapterNo": 12, "mode": "outline" }

// 搜章节正文（关键词高亮）
{ "chapterNo": 12, "mode": "search", "query": "听剑阁" }

// 列场景（先看再改）
{ "chapterNo": 12 }
```

> **写章前先 `novel_build_context`**——`writingGuide` 是题材约束的唯一来源，违反它会触发评审官的红线。
> **正文首行必须是 H1 章标题**（`# 第12章 ……`）——工具会规范化；其余段落以 `## 场景N:……` 划分。
> **`cast` 必传**——人物官子代理靠这个反向更新人物表.出场章节；名字尾随括号（`陆铮（不在场）`）自动拆分。

### 2.5 改稿与版本（4 个）

| 工具 | 用途 |
|---|---|
| `novel_revise_chapter` | 改稿（`action: patch\|insert_after\|expand`）；按段落 / 块 / 块区间定位 |
| `novel_list_scenes` | 同上（与改稿配套：先看场景再改） |
| `novel_get_chapter_history` | 列章节修订历史（含 revisionId） |
| `novel_restore_chapter` | 一键回滚到任一历史版本（改稿安全网） |

**典型用法：**

```json
// 精确替换某段（in-paragraph str_replace；含 \n 必败，走 patch + startBlockId/endBlockId）
{
  "action": "patch",
  "chapterNo": 12,
  "match": "陆铮踏进听剑阁的正门",
  "substitute": "陆铮踏进听剑阁的东侧门",
  "scene": "场景一：入门考核"
}

// 跨段落改：startParagraph/endParagraph（按段落定位）
{
  "action": "patch",
  "chapterNo": 12,
  "match": "陆铮应了一声，转身离去。\n\n周长老目送他远去。",
  "substitute": "陆铮沉默片刻，点了点头。\n\n周长老轻轻叹了口气。",
  "startParagraph": 5,
  "endParagraph": 6
}

// 块区间（推荐）：按 block_id 兄弟块区间定位
{
  "action": "patch",
  "chapterNo": 12,
  "match": "……",
  "substitute": "……",
  "startBlockId": "blk_abc",
  "endBlockId": "blk_def"
}

// 在某块后插入（expand 不支持区间）
{
  "action": "insert_after",
  "chapterNo": 12,
  "blockId": "blk_abc",
  "newBlock": "……新增段落……"
}

// 整段扩写（保留 + 在末尾追加）
{
  "action": "expand",
  "chapterNo": 12,
  "scene": "场景一：入门考核",
  "appendix": "（续）……"
}

// 看历史
{ "chapterNo": 12 }

// 回滚
{ "chapterNo": 12, "revisionId": "rev_20260903_xxx" }
```

> **零 I/O 守卫**（执行前拒错的典型）：
> - `match` 含 `\n` 但未指定 `startBlockId/endBlockId/startParagraph` → "match 跨段落，请改用块区间"
> - `startBlockId/endBlockId` 与 `startParagraph/endParagraph` 混用 → 拒错
> - `expand` + 区间 → 拒错（expand 是单点插入）
> - 区间顺序倒置 → 拒错
>
> **改稿完成后必须 `novel_mark_chapter_memories_stale`**——L1 章节级记忆与正文不一致会让后续一致性检查误报。

### 2.6 记忆沉淀（5 个）

| 工具 | 用途 |
|---|---|
| `novel_update_summary` | 更新章节摘要（L1：章节级记忆） |
| `novel_record_character_state` | 章末人物状态快照（地点 / 状态 / 持有物品） |
| `novel_record_event` | 剧情事件（含 `chapter` link；`is_turning_point` 标记转折） |
| `novel_upsert_book_summary` | 卷 / 全书摘要 query\|upsert 合一（按标题去重） |
| `novel_mark_chapter_memories_stale` | 章节改稿后批量标记忆陈旧 |

**典型用法：**

```json
// 章节摘要（扁平字段，不是数组）
{
  "chapterNo": 12,
  "scene": "听剑阁入门",
  "events": [{ "summary": "陆铮通过入门考核" }, { "summary": "白衍暗访听剑阁" }],
  "characterChanges": [
    { "character": "陆铮", "from": "民间游侠", "to": "听剑阁外门弟子" }
  ],
  "newInfo": "听剑阁入门考分三关：剑意、剑招、剑心",
  "newForeshadows": ["陆铮的剑心藏有异象"],
  "endState": "陆铮正式入门，白衍在暗处观察",
  "freeform": ""
}

// 章末人物状态（人物官子代理调用）
{ "chapterNo": 12, "character": "陆铮", "location": "听剑阁", "physicalState": "轻微疲劳", "mentalState": "警觉", "inventory": ["灰布剑", "周长老手令"] }

// 事件
{ "chapterNo": 12, "name": "陆铮通过入门考核", "summary": "三关皆过", "participants": ["陆铮", "周长老"], "isTurningPoint": true }

// 卷摘要（先查再写，避免堆重复行）
{ "action": "query", "level": "卷", "titleContains": "听剑卷" }

// 标记忆陈旧
{ "chapterNo": 12 }
```

> **`newInfo` 必须是扁平对象**（不是数组，不是嵌套）；常见错误形态 `{item, newForeshadows, endState, freeform}`——工具 description 末尾给了可复制的正确 JSON 示例。
> **事件并发写入会丢 link**——5 条 record_event 同 step 发出时 link 回填 60% 静默失败（已实测）；**必须串行或走 selfheal 退避**。

### 2.7 一致性检查（3 个）

| 工具 | 用途 |
|---|---|
| `novel_run_consistency_check` | 跑设定 / 人设 / 伏笔 / 时间线 / 红线 全量检查 |
| `novel_get_semantic_check_pack` | 取本章的语义检查包（送评审官用） |
| `novel_get_review_focus` | 取本作题材的评审重点（权重 + 阻断阈值 + 题材专项） |

**典型用法：**

```json
// 全量检查（耗时 5-15s，按章节数据量）
{ "chapterNo": 12 }   // 不传则全作品

// 取评审重点（开评前必调）
{}

// 取语义检查包（送评审官 persona 阅）
{ "chapterNo": 12 }
```

返回结构：

- `issues[]`：按题材权重排序；`blocking = severity >= blockingThreshold`
- `genreFocus`：题材专项评估点（webnovel=爽点/钩子；literary=人物/主题；scriptwriting=场景节拍/对白节奏）
- `contentRedLines`：三档（严禁 / 高危 / 审慎），前两档全题材阻断定稿

> **三档红线**：
> - 严禁（呈现即违规，无合法框架）
> - 高危（可写但须满足强约束）
> - 审慎（技巧规避即可，仅提示不阻断）
>
> 完整清单见 `packages/novel/src/genre/taboos.ts`。

### 2.8 大纲 / 伏笔 / 剧情线 / 分支（4 个）

| 工具 | 用途 |
|---|---|
| `novel_manage_outline` | 章节大纲 CRUD |
| `novel_manage_foreshadow` | 伏笔 CRUD；类型（主线 / 支线 / 人物 / 物品）；状态（已埋设 / 已回收 / 已作废） |
| `novel_manage_plotline` | 剧情线 CRUD；推进状态（铺垫 / 推进 / 高潮 / 收束 / 完结） |
| `novel_manage_branch` | 候选分支 CRUD（写章前的多版本规划；状态：候选 / 已采用 / 已否决） |

> **大纲官子代理同时持有这 4 个工具**——卷规划场景下与 `novel_build_context` 配合使用。

### 2.9 字数与节奏（1 个）

| 工具 | 用途 |
|---|---|
| `novel_calculate` | 字数 / 节奏 / 爽点密度 / 线索公平 等组合指标 |

```json
{ "chapterNo": 12 }
// 或：
{ "metrics": ["words", "dialogue_ratio", "stimulus_density", "clue_fairness"] }
```

### 2.10 高阶规划（3 个）

| 工具 | 用途 |
|---|---|
| `novel_breakthrough_planning` | 突破性章节规划（爽点密度突变 / 视角切换 / 时间跳跃） |
| `novel_advance_character_arc` | 推进人物弧光（成长 / 转折 / 黑化 / 救赎） |
| `novel_record_chapter_tension` | 记录本章张力评级（1-5 星）+ 备注 |

---

## 3. 7 个子代理的职责与编排规则

### 世界官（`novel_agent_worldkeeper`）

- **职责**：设定 / 伏笔 / 剧情线 增删改
- **调用时机**：主编排官发现需要新增/修订设定或伏笔时
- **toolFilter.allow**：`novel_manage_setting`、`novel_manage_work`、`novel_manage_foreshadow`、`novel_manage_plotline`
- **persona 关键词**：`# 设定`、`# 伏笔`、`# 剧情线`

### 人物官（`novel_agent_characterkeeper`）

- **职责**：人物 / 关系 CRUD；章末状态快照
- **调用时机**：起草官完成一章后录入人物快照；需新增人物时
- **toolFilter.allow**：`novel_manage_character`、`novel_manage_relation`、`novel_record_character_state`、`novel_manage_work`（仅 query）
- **persona 限 `action=query`**：调 `novel_manage_character` / `novel_manage_relation` 时只能 `query`，不能 `upsert`——避免跨子代理并发写入
- **persona 关键词**：`# 人物`、`# 关系`、`# 章末状态`

### 大纲官（`novel_agent_outliner`）

- **职责**：大纲 / 分支规划
- **调用时机**：主编排官做卷规划时
- **toolFilter.allow**：`novel_manage_outline`、`novel_manage_branch`、`novel_manage_foreshadow`、`novel_manage_plotline`、`novel_manage_work`（仅 query）
- **persona 关键词**：`# 大纲`、`# 分支`

### 起草官（`novel_agent_drafter`）

- **职责**：写章正文 + 配套场景 / 记忆 / 计算
- **调用时机**：主编排官决定起草某章时
- **toolFilter.allow**：`novel_build_context` + 全套 chapter / revision / memory / 上下文 / 计算 / 规划工具 + `novel_manage_work`（仅 query）
- **关键约束**：写章前必须 `novel_build_context` 取 `writingGuide`；`cast` 必传
- **persona 关键词**：`# 起草`

### 改稿官（`novel_agent_reviser`）

- **职责**：微调刚写完的章节（局部改写 / 扩写 / 润色 / 整段重写）
- **调用时机**：起草官完成后主编排官认为需打磨细节
- **toolFilter.allow**：`novel_revise_chapter`、`novel_list_scenes`、`novel_read_chapter`、`novel_get_chapter_history`、`novel_restore_chapter`、`novel_manage_work`（仅 query）
- **persona 关键词**：`# 改稿`

### 评审官（`novel_agent_critic`）

- **职责**：一致性 / 红线评审（只读 + 写检查记录）
- **调用时机**：章稿完成后 / 主编排官认为需要审稿时
- **toolFilter.allow**：`novel_run_consistency_check`、`novel_get_semantic_check_pack`、`novel_get_review_focus`、`novel_read_chapter`、`novel_manage_work`（仅 query）
- **persona 关键词**：`# 评审`
- **关键约束**：开评前先 `novel_get_review_focus` 拿本作题材的评审重点

### 救火官（`novel_agent_rescuer`）

- **职责**：兜底修复（重写 / 回滚 / 标记忆陈旧）
- **调用时机**：评审官发现重大问题、救火官介入
- **toolFilter.allow**：全套查询工具 + `novel_restore_chapter` + `novel_mark_chapter_memories_stale` + `novel_manage_work`（仅 query）
- **persona 关键词**：`# 救火`

---

## 4. 工作流示例：一次性写完一章

```
1. 主编排官
   ├─ novel_manage_work action=get    # 确认当前作品
   └─ novel_build_context chapterNo=12  # 拿分层上下文 + writingGuide

2. 起草官（novel_agent_drafter）
   ├─ novel_list_scenes chapterNo=11   # 看前一章场景衔接
   ├─ novel_write_chapter chapterNo=12 title=… content=… cast=[…]
   └─ novel_mark_chapter_memories_stale chapterNo=11  # 上章记忆标陈旧（因为要补录）

3. 人物官（novel_agent_characterkeeper）
   ├─ novel_record_character_state chapterNo=12 character=陆铮 …  # 多次
   └─ novel_record_event chapterNo=12 name=… isTurningPoint=true   # 多次

4. 主编排官（沉淀 L1 记忆）
   └─ novel_update_summary chapterNo=12 …   # 扁平字段

5. 评审官（novel_agent_critic）
   ├─ novel_get_review_focus                # 拿评审重点
   ├─ novel_run_consistency_check chapterNo=12
   └─ 如有 blocking：反馈主编排官 → 救火官介入

6. 主编排官（定稿）
   └─ novel_manage_work action=get → 设 current_chapter=12
```

---

## 5. 端到端验证（`pnpm test:agent`）

564s 实测跑通一部短篇（含 5 章 / 10 人物 / 3 卷），无需 playwright。

**流程：**

```
1. pnpm test:agent
2. → scripts/run-e2e.mjs --agent
3. → build bundle + setup-test-base.mjs --install-agent-profile
4. → npx @deepseek-ai/dsh --profile unwr-agent "<任务>"
5. → 报告尾行 UNWR_WORK_BASE=<token>
6. → packages/novel/scripts/agent-verify.ts 落库验收
   - 验证人物状态 / 事件 / 伏笔是否真实入库
   - 不轻信模型自报
```

**实测暴露过的问题**（已修）：
- 主会话起草后把记忆沉淀整套重做（人物状态同章同人重复 4 条）→ WRITING_CONVENTIONS 加"区分委托已沉淀"语义
- 主会话虚报"补 3 条辅线伏笔"（起草官 toolFilter 无 foreshadow）→ 验收脚本只信落库抓到
- 并发 5 条 record_event 同 step 发出，link 回填全失败 → selfheal 退避 + 编排层避免同表并发

---

## 6. 题材预设（三套）

| preset_id | 中文名 | 节奏 | 爽点密度 | 钩子强度 | 线索公平 | 红线阈值 |
|---|---|---|---|---|---|---|
| `webnovel` | 中文网文 | 2500 字 / 章；2-4 场景 | 高（1.5） | 强制 last_para 钩子 | 2 | 3 |
| `genre_fiction` | 类型小说 | 3500 字 / 章；3-5 场景 | 中（1.0） | 选配 | 3 | 2 |
| `literary` | 纯文学 | 5000 字 / 章；4-6 场景 | 低（0.5） | 不强制 | 4 | 4 |

**新增题材**：在 `packages/novel/src/genre/presets.ts` 加一组 `GenrePreset` 值——**统一维度，差异化取值**，无需新增字段或改流程。

**题材指引（`writingGuide`）** 由 `novel_build_context` 实时生成，包含：目标字数 / 场景数 / 对话占比 / 描述占比 / 钩子策略 / 红线阈值。**所有写作决策以此为准**。

---

## 7. 故障排查指引

| 现象 | 看哪里 |
|---|---|
| 工具报 `未知参数` | `packages/novel/tests/tool-schema.spec.ts`（静态契约） |
| 工具报 `执行失败 cli exit code 1` | `pnpm typecheck` + `pnpm test` 看 vitest 回归 |
| `novel_revise_chapter` 报 `match 跨段落` | 看 install.md §9；改用 `startBlockId/endBlockId` 区间 |
| `novel_update_summary` 报 `newInfo must be array` | 看 usage.md §2.6；必须是扁平对象不是数组 |
| `novel_manage_work action=list` 看不到刚建的作品 | 飞书搜索索引分钟级延迟；用 `~/.unwr/work-state.json` 兜底 |
| 章稿写完发现 link 没回填 | 看 selfheal 退避日志；`pnpm repair-dup-fields <BASE_TOKEN>` 兜底 |
| 一致性检查红了一堆但不知道从哪开始 | 先调 `novel_get_review_focus` 看题材权重；按权重排序处理 |
| DSH 主会话给了模型一个看不见的工具名 | persona / WRITING_CONVENTIONS 提到的 `novel_*` 必须真实存在；看 `tests/tool-registry.spec.ts` |
| 子代理报 `unknown tool` | 该工具不在子代理 `toolFilter.allow` 里——不要试图越权；改用其他子代理或升到主会话调 |

---

## 8. 进阶阅读

- 数据模型：`../requirements/02-feishu-data-model.md`（13 张表 + link 关系 + 字段定义）
- 智能体矩阵：`../requirements/03-agent-matrix.md`（7 子代理详细 toolFilter + persona）
- 题材预设：`../requirements/04-genre-presets.md`（维度定义 + 数值表）
- 记忆与一致性：`../requirements/05-memory-and-consistency.md`（分层记忆模型 + 红线清单）
- 飞书 CLI 硬坑：`../requirements/01-features-and-verification.md` 第三节（@file 仅相对路径 / batch-create 不支持 link / write-then-read 延迟 / record-get 必须传表 id 不传表名 / etc）
- 技术决策：`../tech/01-tech-selection.md` + `../tech/02-dsh-integration.md`