# UnWr 飞书数据模型设计

> 阶段：需求定义。本篇定义**小说数据在飞书中怎么存**。
> 设计前提：飞书为 **source of truth**，Web 应用通过 `lark-cli` / 开放接口读写同一份数据。
> 标注 ✅ 表示该字段类型/机制已在本项目实机验证。

---

## 一、存储分工原则

| 数据性质 | 存哪里 | 理由 |
|----------|--------|------|
| **结构化、需查询/筛选/统计/关联** | 多维表格（Base） | `filter`/`sort`/`view`/`link`/`formula` 已验证 ✅ |
| **长篇非结构化正文** | 云文档（docx） | 标题层级、块 id 定位、版本历史已验证 ✅ |
| **中等正文（摘要、词条释义、状态描述）** | 表格 `text` 字段 | 8400 字符实测无截断 ✅ |
| **二进制素材（立绘、封面、附件）** | 云盘文件夹 / `attachment` 字段 | — |
| **高频临时数据（对话、运行日志）** | 本地（不进飞书） | 避免 API 频率压力，见 Q6 |

**判断口诀**：要被检索和关联 → 进表；要被逐字精读和改写 → 进文档；要被 diff 和纯文本流转 → 导出 Markdown。

---

## 二、作品资源拓扑

```
一部作品 =
  ├─ 1 个多维表格 Base（结构化数据全在这里）
  │    base_token ── 由 drive +search --doc-types bitable 发现 ✅
  ├─ 1 个 Wiki 节点子树（卷/章目录与正文文档）
  │    空间 → 作品节点 → 卷节点 → 章节点 ✅（三级已验证）
  └─ 1 个 Drive 文件夹（素材、导出物）
```

> Q3 待定：一个知识空间放多部作品（空间→作品→卷→章）还是一部作品一个空间。
> 当前环境仅有 1 个可用空间，设计按「**一个空间多部作品**」预留，即四级结构。

---

## 三、多维表格表结构

共 13 张表。字段类型均取自已验证的类型清单。

### 3.1 作品表（作品元信息与全局配置）

| 字段 | 类型 | 说明 |
|------|------|------|
| 作品名 | `text`（主字段） | — |
| 题材 | `select` | 中文网文 / 类型小说 / 纯文学 |
| 子题材 | `text` | 玄幻、悬疑、都市… |
| 规模档位 | `select` | 短篇 / 中长篇 / 长篇连载 |
| 目标字数 | `number` | — |
| 写作模式 | `select` | 协作助手 / 全自动 / 教练评审 / 协作+自动（对应 K3） |
| 风格预设 | `text` | JSON 或指向配置文档（对应 L1） |
| 叙事视角 | `select` | 第一人称 / 第三人称限知 / 第三人称全知 |
| 当前进度章节 | `number` | 已完成章节号 |
| 卷数 | `formula` | `[卷表].COUNTA()` 类统计 |
| 累计字数 | `formula` | `[章节表].[字数].SUM()` |
| 完成率 | `formula` | 累计字数 / 目标字数 |

### 3.2 卷表

| 字段 | 类型 | 说明 |
|------|------|------|
| 卷名 | `text`（主字段） | 如「第一卷 旧剑」 |
| 卷序 | `number` | 排序用 |
| 主题 | `text` | 本卷核心冲突 |
| 起止章节 | `text` | 或 link 到章节表 |
| 状态 | `select` | 待写 / 进行中 / 已完成 |
| 卷摘要 | `text` | 分层记忆的「卷级摘要」 |
| Wiki节点 | `text`（url） | 指向 wiki 节点 ✅ |

### 3.3 章节表（核心表）

| 字段 | 类型 | 说明 |
|------|------|------|
| 章节标题 | `text`（主字段） | ✅ |
| 所属卷 | `link` → 卷表 | ✅ |
| 章节号 | `number` | 全局序号，排序与记忆分层依据 ✅ |
| 字数 | `number` | ✅ |
| 状态 | `select` | 大纲 / 草稿 / 修订 / 定稿 ✅ |
| 大纲要点 | `text` | 起草前的规划 ✅ |
| **章节摘要** | `text` | **分层记忆 G1**，实测可存 8400+ 字 ✅ |
| 张力评分 | `number`（rating） | 节奏曲线 D9 |
| 出场人物 | `link`（反向） | 由人物表双向关联自动生成 ✅ |
| 关联伏笔 | `link`（反向） | 由伏笔表双向关联自动生成 ✅ |
| 正文文档 | `text`（url） | 指向该章 docx |
| Wiki节点 | `text`（url） | 指向 wiki 章节点 |
| 故事内时间 | `text` | 时间线 D7 |
| 更新时间 | `updated_at` | ✅ |

### 3.4 人物表

| 字段 | 类型 | 说明 |
|------|------|------|
| 姓名 | `text`（主字段） | ✅ |
| 别名/称谓 | `text` | 供 H6 称谓一致性检查 |
| 身份 | `text` | ✅ |
| 性格标签 | `select` multiple | ✅ |
| 口癖 | `text` | 用于 C10 对白一致性 ✅ |
| 核心动机 | `text` | ✅ |
| 外貌 | `text` | — |
| 人物弧光阶段 | `select` | C8 |
| 出场章节 | `link` → 章节表（双向） | **C4 人物出场追踪** ✅ |
| 小传文档 | `text`（url） | 长文走独立云文档 |
| 立绘 | `attachment` | C9 |

### 3.5 人物状态表（分层记忆 G3 的核心）

> **主键语义**：（人物 × 章节）一条记录，记录「本章结束时该人物的状态」。

| 字段 | 类型 | 说明 |
|------|------|------|
| 人物 | `link` → 人物表 | ✅ |
| 章节 | `link` → 章节表 | ✅ |
| 所在位置 | `text` | H5 方位矛盾检查依据 |
| 身体状况 | `text` | 伤势、疲劳 |
| 情绪状态 | `text` | — |
| 持有物品 | `text` | — |
| 关系变化 | `text` | 与其他人物的关系变动 |
| 状态摘要 | `text` | 一句话概括 |

### 3.6 人物关系表

| 字段 | 类型 | 说明 |
|------|------|------|
| 人物A | `link` → 人物表 | — |
| 人物B | `link` → 人物表 | — |
| 关系类型 | `select` | 师徒 / 血亲 / 敌对 / 爱慕 / 同盟 / 利用 |
| 关系描述 | `text` | — |
| 起始章节 | `link` → 章节表 | — |
| 当前状态 | `select` | 存续 / 已破裂 / 已转化 |

### 3.7 设定表

| 字段 | 类型 | 说明 |
|------|------|------|
| 词条名 | `text`（主字段） | — |
| 分类 | `select` multiple | 地理 / 势力 / 规则 / 历史 / 物品 / 功法 / 习俗 ✅ |
| 释义 | `text` | 中等长度直接存字段（长文本已验证）✅ |
| 重要度 | `number`（rating） | ✅ |
| 首次出现章节 | `link` → 章节表 | ✅ |
| 关联设定 | `link` → 设定表（自关联） | 设定之间的引用网络 |
| 长文文档 | `text`（url） | 超长设定走独立云文档 |
| 状态 | `select` | 生效 / 已废弃 / 待定 |

### 3.8 伏笔表（类型小说核心）

| 字段 | 类型 | 说明 |
|------|------|------|
| 伏笔内容 | `text`（主字段） | ✅ |
| 类型 | `select` | 主线 / 支线 / 人物 / 物品 ✅ |
| 状态 | `select` | 已埋设 / 已回收 / 已作废 ✅ |
| 埋设章节 | `link` → 章节表 | ✅ |
| 计划回收章节 | `link` → 章节表 | — |
| 实际回收章节 | `link` → 章节表 | — |
| 重要度 | `number`（rating 1–5） | ✅ |
| **埋设章节标题** | `formula` | `[埋设章节].[章节标题].ARRAYJOIN("、")` ✅ 已验证输出正确 |
| 备注 | `text` | — |

### 3.9 剧情线表

| 字段 | 类型 | 说明 |
|------|------|------|
| 线名 | `text`（主字段） | — |
| 类型 | `select` | 主线 / 支线 |
| 状态 | `select` | 铺垫 / 推进 / 高潮 / 收束 / 完结 |
| 描述 | `text` | — |
| 关联章节 | `link` → 章节表 | — |
| 关联人物 | `link` → 人物表 | — |
| 关联伏笔 | `link` → 伏笔表 | — |

### 3.10 事件表（分层记忆 G2 事件索引）

| 字段 | 类型 | 说明 |
|------|------|------|
| 事件名 | `text`（主字段） | — |
| 章节 | `link` → 章节表 | ✅ |
| 故事内时间 | `text` | D7 时间线排序依据 |
| 地点 | `text` | — |
| 参与人物 | `link` → 人物表 | — |
| 事件摘要 | `text` | — |
| 影响 | `text` | 对后续剧情的因果影响 |
| 是否关键转折 | `checkbox` | 节奏曲线取样点 |

### 3.11 记忆索引表（分层记忆 G1/G7 的统一索引）

> 将「章摘要 / 卷摘要 / 全书摘要」统一建模，便于按层级与范围检索。

| 字段 | 类型 | 说明 |
|------|------|------|
| 摘要标题 | `text`（主字段） | — |
| 层级 | `select` | 章节 / 卷 / 全书 |
| 覆盖起始章节 | `number` | — |
| 覆盖结束章节 | `number` | — |
| 摘要内容 | `text` | 长文本 ✅ |
| 关联章节 | `link` → 章节表 | — |
| 生成时间 | `created_at` | ✅ |
| 是否已过期 | `checkbox` | 正文改动后置真，触发 G6 重生成 |

### 3.12 候选分支表（卡文救援 J4）

| 字段 | 类型 | 说明 |
|------|------|------|
| 分支标题 | `text`（主字段） | — |
| 卡点章节 | `link` → 章节表 | — |
| 分支描述 | `text` | — |
| 采用状态 | `select` | 候选 / 已采用 / 已否决 |
| 评估备注 | `text` | — |

### 3.13 检查问题表（一致性检查 H8 报告落库）

| 字段 | 类型 | 说明 |
|------|------|------|
| 问题标题 | `text`（主字段） | — |
| 问题类型 | `select` | 设定冲突 / 人设崩坏 / 伏笔未回收 / 时间线矛盾 / 方位矛盾 / 称谓不一致 |
| 严重度 | `number`（rating） | — |
| 关联章节 | `link` → 章节表 | — |
| 关联人物 | `link` → 人物表 | — |
| 定位描述 | `text` | 可存 block_id 便于跳转 ✅ |
| 处理状态 | `select` | 待处理 / 已修复 / 已忽略 |

---

## 四、关联关系图

```
                    ┌──────────┐
                    │  作品表   │
                    └────┬─────┘
                         │ 1:N
                    ┌────▼─────┐        ┌──────────┐
        ┌───────────┤  卷表    ├────────┤ Wiki 卷节点│
        │           └────┬─────┘        └──────────┘
        │                │ 1:N
        │           ┌────▼─────┐        ┌──────────┐
        │           │  章节表   ├────────┤ Wiki 章节点│
        │           └──┬─┬─┬─┬─┘        └────┬─────┘
        │              │ │ │ │               │ 1:1
        │    ┌─────────┘ │ │ └──────────┐    ▼
        │    │           │ │            │  正文文档
        │    ▼           │ │            │   (docx)
   ┌────┴─────┐   ┌──────▼─▼──┐   ┌─────▼──────┐
   │ 人物状态表│   │   事件表   │   │   伏笔表    │
   └────┬─────┘   └──────┬────┘   └─────┬──────┘
        │                │              │
        ▼                ▼              ▼
   ┌─────────┐     ┌──────────┐   ┌──────────┐
   │  人物表  │◄───►│ 人物关系表│   │  剧情线表 │
   └────┬────┘     └──────────┘   └─────┬────┘
        │                               │
        └──────────►┌──────────┐◄────────┘
                    │  设定表   │（自关联：设定→设定）
                    └──────────┘

旁路表：记忆索引表 ──► 章节表
        候选分支表 ──► 章节表
        检查问题表 ──► 章节表 / 人物表
```

**关键关联（已实机验证 ✅）**
- 人物表 ←双向→ 章节表：章节表自动获得「出场人物」，人物表获得「出场章节」
- 伏笔表 → 章节表：埋设章节 / 计划回收章节 / 实际回收章节（三条独立 link）
- 伏笔表 `formula` 字段自动展开埋设章节标题

---

## 五、云文档与目录组织

### 5.1 Wiki 目录树

```
知识空间（space_id 见作品配置）
└── 《作品名》                    docx：作品总览 + 全书摘要
    ├── 设定集                    docx：长篇设定正文（分类分节）
    ├── 人物志                    docx：全体人物小传（一人一节 h2）
    ├── 第一卷 旧剑                docx：卷纲
    │   ├── 第一章 雨夜叩门        docx：正文 ✅
    │   ├── 第二章 旧庙疗伤        docx：正文
    │   └── …
    └── 第二卷 …
```

> 三级树（作品→卷→章）已实机验证 ✅。加一层作品节点即为四级。

### 5.2 章节正文文档内部规范

> ⚠️ **技术选型阶段实测修正**：原设计让正文首行写 `# 章标题`，
> 但 `docs +create` 的 `--title` 会覆盖同名 h1（CLI 文档：
> "the title wins over later content titles"）。而我们的用法恰好
> `--title` = 章标题 = 内容首行，导致 **h1 被吞、outline 丢失章标题**。
>
> **修正约定：章标题由 `--title` 承担，正文只用 `##` 做场景分节。**

```
文档标题（--title）= 第一章 雨夜叩门
─────────────────────────────
## 一、入城                ← h2，场景分节 ✅
段落…
## 二、交锋                ← h2
段落…
```

- 章标题体现为飞书文档名（便于文档列表浏览），正文不重复写 h1
- 每个 h2 = 一个场景，便于 `outline` 导航与 `block_id` 精确定位 ✅
- 改写一律以 **h2 场景块**为最小操作单位：`fetch --detail with-ids` → `block_replace`
- 细粒度改动用 `str_replace`，跨段落用 `block_replace`
- 验证方式：`docs +fetch --scope outline --doc-format xml`，
  断言 h2 数量 === 场景数（**markdown 格式下 outline 返回 `##` 文本而非标签，不能用于断言**）

### 5.3 Drive 文件夹

```
《作品名》/
├── 素材/        立绘、封面、参考资料（`attachment` 或独立文件）
├── 导出/        成稿 Markdown / Word / PDF（`drive +export`）
└── 报告/        评审报告、一致性检查报告（docx）
```

---

## 六、读写边界与数据流

### 6.1 Source of Truth

**飞书是唯一真源**。Web 应用本地仅保留缓存与临时态（当前编辑草稿、智能体会话、运行日志）。

### 6.2 写入者分工

| 写入者 | 写什么 | 通过 |
|--------|--------|------|
| 用户（Web 编辑器） | 章节正文、人物档案、设定词条、大纲 | 应用 → `lark-cli` |
| 起草官 | 新建章节正文、章节摘要、伏笔记录 | `docs +create/update`、`record-batch-create` |
| 改稿官 | 正文片段改写 | `docs +update str_replace/block_replace` |
| 人物官 | 人物状态快照 | `record-batch-create/update` |
| 评审官 | 检查问题记录、评审报告 | `record-batch-create`、`docs +create` |
| 系统 | 字数统计、章节号、时间戳 | `formula` / `updated_at`（自动，不落库） |

### 6.3 读取路径（起草时的上下文组装 E2）

```
起草第 N 章时：
1. 章节表：取本章大纲要点                    → record-list --filter 章节号==N
2. 章节表：取前 N-K 章的摘要（远期记忆）      → record-list --filter 章节号<N-K
3. 章节表：取前 K 章正文文档 token（近距原文）→ 同上取「正文文档」url 字段
4. 伏笔表：取未回收且重要度高的伏笔           → record-list --filter 状态==已埋设 --sort 重要度 desc ✅
5. 人物表：取出场人物档案 + 状态快照          → link 反向字段 / 人物状态表查询
6. 设定表：取本章相关设定词条                 → filter 分类 / keyword 检索
7. 需要细节时回溯原文                        → docs +fetch --scope keyword ✅
```

### 6.4 同步策略（Q2 待定）

倾向：**本地缓存 + 按需同步**，飞书为真源。
- 打开章节时拉取正文与相关结构化数据入本地缓存
- 编辑时本地即时响应，落盘/定时/切换时回写飞书
- 冲突以飞书版本为准（或弹出对比，用 `markdown +diff` / `docs +history-list` 展示差异）

> 注意硬约束：`drive +sync` **不同步云文档** ✅，因此正文同步必须走 `docs +fetch/+update`，不能依赖 `drive +sync`。

---

## 七、建库操作序列（已验证命令骨架）

创建一部作品的标准流程，全部命令均已实机跑通：

```bash
# 1. 建库
lark-cli base +base-create --name "《作品名》" --time-zone Asia/Shanghai --as user

# 2. 建表（复杂 schema 必须走 @file，相对路径）
cd <工作目录>
lark-cli base +table-create --base-token <bt> --name "章节表" --fields @chapter_fields.json --as user
lark-cli base +table-create --base-token <bt> --name "人物表" --fields @char_fields.json --as user
lark-cli base +table-create --base-token <bt> --name "伏笔表" --fields @foreshadow_fields.json --as user
# …其余各表

# 3. 建双向关联（人物 ↔ 章节）
lark-cli base +field-create --base-token <bt> --table-id <人物表> \
  --json '[{"name":"出场章节","type":"link","link_table":"<章节表id>",
            "bidirectional":true,"bidirectional_link_field_name":"出场人物"}]' --as user

# 4. 建公式字段（必须带 --i-have-read-guide）
lark-cli base +field-create --base-token <bt> --table-id <伏笔表> \
  --json '[{"name":"埋设章节标题","type":"formula",
            "expression":"[埋设章节].[章节标题].ARRAYJOIN(\"、\")"}]' \
  --i-have-read-guide --as user

# 5. 建视图
lark-cli base +view-create --base-token <bt> --table-id <章节表> \
  --json '[{"name":"章节进度看板","type":"kanban"},{"name":"待修订章节","type":"grid"}]' --as user
lark-cli base +view-set-filter --base-token <bt> --table-id <章节表> \
  --view-id <vid> --json '{"logic":"and","conditions":[["状态","intersects",["草稿","修订"]]]}' --as user

# 6. 建 Wiki 目录树
lark-cli wiki +node-create --space-id <sid> --title "《作品名》" --obj-type docx --as user
lark-cli wiki +node-create --space-id <sid> --parent-node-token <卷父> --title "第一卷" --obj-type docx --as user
lark-cli wiki +node-create --space-id <sid> --parent-node-token <卷> --title "第一章" --obj-type docx --as user

# 7. 写章节正文（必须文件传参，保证换行与标题层级）
lark-cli docs +create --title "第一章" --doc-format markdown --content @./ch01.md --as user

# 8. 改稿
lark-cli docs +update --doc <docid> --command str_replace \
  --pattern "原文片段" --content "改写片段" --as user
lark-cli docs +update --doc <docid> --command block_replace \
  --block-id <bid> --doc-format markdown --content @./new_para.md --as user

# 9. 版本对比
lark-cli docs +history-list --doc <docid> --as user
lark-cli markdown +diff --file-token <ft> --from-version <v1> --to-version <v2> --as user
```

---

## 八、本模型的已知取舍

| 取舍 | 选择 | 代价 |
|------|------|------|
| 正文存 docx 而非 Markdown 文件 | 获得块级检索、原生版本、评论批注 | 失去 `drive +sync` 能力、diff 需走 `docs +history-list` |
| 摘要/词条存表字段而非独立文档 | 检索与关联方便、一次查询带出 | 极长内容（>万字）需拆分到文档 |
| 人物状态独立成表而非人物表加字段 | 保留完整历史轨迹，支撑 H5 检查 | 记录数随章节线性增长 |
| 一部作品一个 Base | 数据隔离清晰、权限简单 | 跨作品复用设定需冗余（Q8/多部曲 P2 再解） |
