# 使用手册

面向**主编排官**（DSH 主会话内的模型）。所有功能都通过 `novel_*` 工具调用落地。

---

## 1. 编排流程

```
DSH 主会话 = 主编排官（不单独注册）
    │
    │ 调 1 个 novel_agent_* 委托工具
    ▼
7 个子代理（受 persona 约束 + toolFilter 硬约束）
    │
    │ 调 novel_* 工具（28 个）
    ▼
飞书 bitable (13 表) + docx (章节正文)
```

**核心规则**：

1. **每次调子代理前先 `novel_manage_work action=list`**——不传 `workToken` 时用会话级默认作品
2. **子代理只能看 `toolFilter.allow` 列出的工具**——是硬约束（DSH 引擎层过滤），即使 persona 写了也调不到
3. **`novel_manage_work` 进一步限到 `list` / `get_config`**——子代理只能查不能切 / 创；切创必须主会话
4. **委托范围纪律**：删改已有正文 → 改稿官（toolFilter 有 `novel_revise_chapter`）；跨表核对不要塞给设定官

---

## 2. 28 工具快速索引

### 作品管理（1）

```json
novel_manage_work { "action": "list" }
novel_manage_work { "action": "create", "workToken": "<BASE_TOKEN>", "name": "洗骨录", "genre": "中文网文", "subgenre": "玄幻", "scale": "长篇连载", "mode": "协作助手", "pov": "第三人称限知", "targetWords": 1000000 }
novel_manage_work { "action": "switch", "workToken": "<BASE_TOKEN>" }
```

> 作品注册表存在 `~/.unwr/work-state.json`（仓库外），重启 DSH 进程后默认作品自动恢复。**新建 bitable 在飞书搜索索引里分钟级延迟**——list 时本地独有条目标 `source: 'local'` + warnings。

### 实体管理（3）

```json
novel_manage_character { "action": "upsert", "name": "陆铮", "alias": "陆小侯爷", "role": "主角", "firstAppearanceChapter": 1 }
novel_manage_relation  { "action": "upsert", "type": "师徒", "characterA": "陆铮", "characterB": "白衍", "intensity": 5 }
novel_manage_setting   { "action": "query", "category": "功法" }
```

> 跨子代理并发 upsert 容易丢 link（飞书服务端静默丢 link 字段）。

### 上下文构建（1）

```json
novel_build_context { "chapterNo": 12 }
```

返回：`meta`（题材/视角）+ `writingGuide`（题材约束的唯一来源）+ 前后各 3 章 + 当前卷 + 出场人物 + 伏笔 + 最近事件 + 相关记忆。**写章前必调**。

### 章节正文（4）

```json
// 写第 12 章
{
  "chapterNo": 12,
  "title": "陆铮初入听剑阁",
  "content": "## 场景一：入门考核\n\n陆铮踏进听剑阁的正门……\n\n## 场景二：剑诀初试\n\n……",
  "cast": ["陆铮", "白衍", "周长老"]
}

// 读章节
novel_read_chapter { "chapterNo": 12, "mode": "outline" }   // full | outline | search
novel_read_chapter { "chapterNo": 12, "mode": "search", "query": "听剑阁" }

// 追加
novel_append_chapter { "chapterNo": 12, "content": "……" }

// 列场景（先看再改）
novel_list_scenes { "chapterNo": 12 }
```

> - 正文首行必须是 H1 章标题（`# 第12章 ……`），工具会规范化
> - `cast` 必传——双向写入章节表.出场人物 + 人物表.出场章节
> - 名字尾随括号（`陆铮（不在场）`）自动拆分

### 改稿（3）

```json
// 块内精确替换
{
  "action": "patch",
  "chapterNo": 12,
  "match": "陆铮踏进听剑阁的正门",
  "substitute": "陆铮踏进听剑阁的东侧门",
  "scene": "场景一：入门考核"
}

// 跨段落（按段落定位）
{
  "action": "patch",
  "chapterNo": 12,
  "match": "……应了一声，转身离去。\n\n周长老目送他远去。",
  "substitute": "……沉默片刻，点了点头。\n\n周长老轻轻叹了口气。",
  "startParagraph": 5, "endParagraph": 6
}

// 块区间（推荐）
{
  "action": "patch",
  "chapterNo": 12,
  "match": "……",
  "substitute": "……",
  "startBlockId": "blk_abc", "endBlockId": "blk_def"
}

// 块后插入（expand 不支持区间）
{ "action": "insert_after", "chapterNo": 12, "blockId": "blk_abc", "newBlock": "……" }

// 整段扩写
{ "action": "expand", "chapterNo": 12, "scene": "场景一", "appendix": "（续）……" }

// 看历史 + 回滚
novel_get_chapter_history { "chapterNo": 12 }
novel_restore_chapter { "chapterNo": 12, "revisionId": "rev_20260903_xxx" }
```

> **零 I/O 守卫**（执行前拒错）：
> - `match` 含 `\n` 但未指定 `startBlockId/endBlockId` 或 `startParagraph` → "match 跨段落，请改用块区间"
> - `startBlockId/endBlockId` 与 `startParagraph/endParagraph` 混用 → 拒错
> - `expand` + 区间 → 拒错（expand 是单点插入）

### 记忆沉淀（5）

```json
// 章节摘要（扁平字段，不是数组）
{
  "chapterNo": 12,
  "scene": "听剑阁入门",
  "events": [{ "summary": "陆铮通过入门考核" }],
  "characterChanges": [{ "character": "陆铮", "from": "民间游侠", "to": "听剑阁外门弟子" }],
  "newInfo": "听剑阁入门考分三关：剑意、剑招、剑心",
  "newForeshadows": ["陆铮的剑心藏有异象"],
  "endState": "陆铮正式入门，白衍在暗处观察",
  "freeform": ""
}

// 章末状态
{ "chapterNo": 12, "character": "陆铮", "location": "听剑阁", "physicalState": "轻微疲劳", "mentalState": "警觉", "inventory": ["灰布剑"] }

// 事件
{ "chapterNo": 12, "name": "陆铮通过入门考核", "summary": "三关皆过", "participants": ["陆铮", "周长老"], "isTurningPoint": true }

// 卷/全书摘要（先查再写，避免堆重复行）
{ "action": "query", "level": "卷", "titleContains": "听剑卷" }

// 改稿后标陈旧
{ "chapterNo": 12 }
```

> **`newInfo` 必须是扁平对象**（不是数组、不是嵌套）；常见错误形态 `{item, newForeshadows, endState, freeform}`——工具 description 里有正确示例。
> **事件并发写入会丢 link**——5 条 record_event 同 step 发出时 link 回填 60% 静默失败（已实测）；必须串行。

### 一致性检查（3）

```json
novel_run_consistency_check     { "chapterNo": 12 }
novel_get_semantic_check_pack   { "chapterNo": 12 }
novel_get_review_focus          {}    // 开评前必调
```

返回 `issues[]`（按题材权重排序）、`genreFocus`（题材专项评估点）、`contentRedLines`（三档：严禁 / 高危 / 审慎）。

### 大纲 / 伏笔 / 剧情线 / 分支（4）

```json
novel_manage_foreshadow { "action": "upsert", "type": "人物", "content": "陆铮的剑心藏有异象", "plantChapter": 12, "status": "已埋设" }
novel_manage_plotline   { "action": "upsert", "name": "听剑卷主线", "stage": "铺垫", "chapters": [12, 13, 14] }
novel_manage_outline    { "action": "upsert", "chapterNo": 12, "title": "...", "keyPoints": ["通过考核", "暗访白衍"] }
novel_manage_branch     { "action": "upsert", "chapterNo": 12, "branchName": "冲突版", "divergence": "...", "status": "候选" }
```

### 节奏 / 规划（4）

```json
novel_calculate                  { "chapterNo": 12 }
novel_breakthrough_planning      { "chapterNo": 12, "strategy": "爽点密度突变" }
novel_advance_character_arc      { "character": "陆铮", "from": "游侠", "to": "弟子", "triggerChapter": 12 }
novel_record_chapter_tension     { "chapterNo": 12, "level": 4, "note": "高潮起势" }
```

---

## 3. 7 个子代理

实际 `dsh --profile web --dump-config` 输出（手测）：

| 子代理 | toolFilter.allow | 职责 | 调用时机 |
|---|---|---|---|
| **世界官** | `novel_manage_setting` / `novel_manage_foreshadow` / `novel_manage_plotline` / `novel_manage_character` / `novel_manage_relation` / `novel_read_chapter` / `novel_manage_work` | 设定 / 伏笔 / 剧情线 + 必要时补人物 | 需新增/修订设定或伏笔时 |
| **人物官** | `novel_manage_character` / `novel_manage_relation` / `novel_record_character_state` / `novel_read_chapter` / `novel_manage_work` | 人物 / 关系 / 章末状态快照 | 起草官完成一章后录状态；需新增人物 |
| **大纲官** | `novel_manage_outline` / `novel_manage_foreshadow` / `novel_manage_plotline` / `novel_record_event` / `novel_build_context` / `novel_read_chapter` / `novel_manage_work` | 大纲 / 伏笔 / 剧情线 + 事件挂载 | 主编排官做卷规划 |
| **起草官** | `novel_build_context` / `novel_write_chapter` / `novel_append_chapter` / `novel_update_summary` / `novel_record_character_state` / `novel_record_event` / `novel_manage_outline` / `novel_revise_chapter` / `novel_list_scenes` / `novel_read_chapter` / `novel_manage_work` | 写章 + 配套记忆 / 改稿 / 场景 | 主编排官决定起草某章 |
| **改稿官** | `novel_revise_chapter` / `novel_list_scenes` / `novel_read_chapter` / `novel_get_chapter_history` / `novel_manage_character` | 微调刚写完的章节；可调人物档案辅助 | 起草官完成后需打磨细节 |
| **评审官** | `novel_run_consistency_check` / `novel_get_semantic_check_pack` / `novel_get_review_focus` / `novel_list_scenes` / `novel_read_chapter` / `novel_get_chapter_history` | 一致性 / 红线评审（只读） | 章稿完成 / 主编排官需审稿 |
| **救火官**（卡文救援） | `novel_build_context` / `novel_manage_branch` / `novel_manage_foreshadow` / `novel_manage_character`（仅 query） / `novel_read_chapter` | 写不下去时生成 3+ 条候选分支到 `novel_manage_branch` | 用户明确说"卡住了" / 起草中断 |

**写章前**起草官必调 `novel_build_context` 取 `writingGuide`；**开评前**评审官必调 `novel_get_review_focus`。

---

## 4. 一次性写完一章

```
1. 主编排官
   ├─ novel_manage_work action=get             # 确认当前作品
   └─ novel_build_context chapterNo=12         # 拿分层上下文 + writingGuide

2. 起草官
   ├─ novel_list_scenes chapterNo=11           # 看上一章衔接
   ├─ novel_write_chapter chapterNo=12 cast=[…]
   └─ novel_mark_chapter_memories_stale chapterNo=11

3. 人物官
   ├─ novel_record_character_state … (多次)
   └─ novel_record_event … (多次，串行)

4. 主编排官（沉淀 L1 记忆）
   └─ novel_update_summary chapterNo=12 …      # 扁平字段

5. 评审官
   ├─ novel_get_review_focus                   # 拿评审重点
   └─ novel_run_consistency_check chapterNo=12
   → 如有 blocking：反馈主编排官 → 起草官用 novel_revise_chapter 修复

6. 主编排官
   └─ 推进 current_chapter=12
```

---

## 5. 题材预设

| preset_id | 中文名 | 节奏 | 爽点密度 | 钩子 | 线索公平 | 红线阈值 |
|---|---|---|---|---|---|---|
| `webnovel` | 中文网文 | 2500 字 / 章；2-4 场景 | 高（1.5） | 强制 last_para 钩子 | 2 | 3 |
| `genre_fiction` | 类型小说 | 3500 字 / 章；3-5 场景 | 中（1.0） | 选配 | 3 | 2 |
| `literary` | 纯文学 | 5000 字 / 章；4-6 场景 | 低（0.5） | 不强制 | 4 | 4 |

**新增题材**：在 `packages/novel/src/genre/presets.ts` 加一组 `GenrePreset` 值——统一维度，差异化取值。

---

## 6. 故障排查

| 现象 | 解决 |
|---|---|
| 工具报 `未知参数` | 看 `tests/tool-schema.spec.ts`（静态契约） |
| `novel_revise_chapter` 报 `match 跨段落` | 改用 `startBlockId/endBlockId` 区间 |
| `novel_update_summary` 报 `newInfo must be array` | 必须是扁平对象不是数组 |
| `novel_manage_work action=list` 看不到刚建的作品 | 飞书搜索索引延迟；用 `~/.unwr/work-state.json` 兜底 |
| 章稿写完发现 link 没回填 | selfheal 退避自动重试（3s/6s/9s）；严重时 `pnpm repair-dup-fields <BASE_TOKEN>` |
| 一致性检查红了一堆 | 先 `novel_get_review_focus` 看题材权重；按权重排序处理 |
| 子代理报 `unknown tool` | 该工具不在子代理 `toolFilter.allow` 里——不要越权；改用其他子代理或升到主会话调 |