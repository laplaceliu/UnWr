# UnWr

**Un**limited **Wr**iting —— 小说写作 AI 智能体，以 DeepSeek Harness（DSH）插件形态交付。

小说数据统一存放在飞书：多维表格存结构化数据，云文档存章节正文。
飞书为 source of truth，本插件通过 `lark-cli` 读写同一份数据。

## 当前状态

需求阶段与技术选型已完成，骨架已搭建并通过实机验证。

| 阶段 | 文档 |
|------|------|
| 功能清单与飞书实现验证 | `docs/requirements/01-features-and-verification.md` |
| 飞书数据模型（13 张表） | `docs/requirements/02-feishu-data-model.md` |
| 多智能体角色矩阵 | `docs/requirements/03-agent-matrix.md` |
| 题材配置三套预设 | `docs/requirements/04-genre-presets.md` |
| 分层记忆与一致性检查 | `docs/requirements/05-memory-and-consistency.md` |
| 技术选型（含实测数据） | `docs/tech/01-tech-selection.md` |

## 架构

```
Layer 3  DSH Tool 层     @unwr/novel  —— 语义化工具，模型唯一可见的界面
Layer 2  领域服务层       @unwr/novel  —— 业务语义，纯 TS，可 mock 单测
Layer 1  飞书适配层       @unwr/feishu —— spawn lark-cli，屏蔽全部参数陷阱
         lark-cli（Go 二进制，47MB，仅可 spawn）
共享类型  @unwr/schema   —— 表名/字段名常量、题材参数类型
```

**关键设计：工具按「智能体意图」定义，不按「CLI 命令」定义。**
200+ CLI 命令不能直接暴露给模型（命令爆炸、参数陷阱、高危操作无拦阻）。

## 包结构

```
packages/
├── schema/   共享类型与常量（表名常量化，防拼写错误）
├── feishu/   飞书适配层（纯库，非插件）
├── novel/    领域服务 + DSH 工具插件
└── （预留）  后续工具包
```

## 开发

### 前置依赖

- Node.js v24（DSH 要求 ^22.19 或 >=24）
- pnpm 11.7+
- `lark-cli` v1.0.92（飞书认证配置于 `~/.lark-cli/config.json`）
- DSH：源码版或 npx 版均可

设置 DSH 源码位置（若与 UnWr 不在同级目录）：

```bash
export UNWR_ROOT=/path/to/UnWr          # cordis.yml 用它定位插件
pnpm setup:dsh /path/to/deepseek-harness # 重新指向 DSH 源码（可选）
```

### 常用命令

```bash
# 安装依赖
pnpm install

# 类型检查（含 DSH 类型推导验证）
npx tsc --noEmit -p tsconfig.json

# 测试（含真实飞书端到端用例）
npx vitest run

# 飞书适配层冒烟测试
node --import tsx/esm packages/feishu/scripts/smoke.ts

# 为一部作品建齐 13 张表
node --import tsx/esm packages/schema/scripts/init-work.ts <base_token>

# 启动工作台（http://127.0.0.1:3311，PORT 可覆盖）
pnpm workbench
```

### 工作台（packages/web）

零新依赖的本地驾驶舱：Node 内置 `http` 起服务，领域函数直连飞书；
前端为原生 HTML/CSS/JS 单页（无构建步骤），视觉走「墨韵纸感」。

| 界面 | 内容 |
|---|---|
| S0 作品总览 | 云盘扫描作品卡（题材/模式/进度）、新建作品（目录 + Base + 13 表） |
| S1 写作台 | 卷/章树 · 正文阅读 · 章节状态流转 · 起草上下文面板（章纲/人物状态/相关设定/伏笔/记忆/题材指引） |
| S2 智能体 | 8 角色卡（persona/toolFilter 直读 cordis.patch.yml，与 orchestration.spec 同源）· 委托指令生成器 |
| S3 一致性检查 | 题材评审重点与权重条 · 规则检查（w_* 排序 + 阈值）· 语义清单 · 伏笔时限追踪 |
| S4 记忆与数据 | 设定/人物/关系/剧情线/伏笔/事件/记忆索引/候选分支/人物状态时间线（只读） |

职责边界：工作台**只读为主**，写操作仅限新建作品、写作模式切换、章节状态流转；
正文起草与结构化数据写入仍由 DSH 智能体完成（评审官只读、起草官落库的
权限模型不在工作台侧重复实现）。智能体面板的「委托指令生成器」产出符合
主会话约定第 5 条的显式上下文委托文本，粘贴到 DSH 会话执行。

角色展示数据直读 `profiles/web/cordis.patch.yml`（与编排层测试同一份真值），
修改角色后刷新页面即生效，无需构建。

### 在 DSH 中运行

UnWr 打包为单文件 bundle，源码版与 npx 版 DSH 通用。详见 `docs/tech/02-dsh-integration.md`。

```bash
# 1. 构建（npx 版 DSH 不含 tsx，必须打包）
pnpm build              # 产出 dist/unwr-novel.mjs
pnpm build:watch        # 开发期热重建

# 2. 挂载到 profile 的用户层 patch
#    写入 ~/.dsh/profiles/<profile>/cordis.patch.yml：
#
#    - insert:
#        - id: unwr-novel
#          name: <UNWR_ROOT>/dist/unwr-novel.mjs   # 必须绝对路径
#          config:
#            readOnlySafeMode: true
#            verbose: true
#
#    DSH 要求 name 为绝对路径，故该文件需填你的实际路径；
#    它在 ~/.dsh 下（不入 git），不会外泄。

# 3. 验证配置层被解析
dsh --profile web --dump-config | grep -A3 unwr

# 4. 重启 DSH 实例（配置改动不会热生效）
npx @deepseek-ai/dsh web      # 端口 3080

# 启动日志出现以下内容即表示插件生效：
#   [unwr] 插件已加载: unwr-novel
#   [unwr] 已注册工具 (1): novel_build_context
```

**源码版 DSH**（可加载 `.ts`，适合开发）：

```bash
export UNWR_ROOT=/path/to/UnWr

cd /path/to/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts web --profile unwr \
  --patch $UNWR_ROOT/dist/cordis.local.yml
```

## 已实现的工具（25 个）

| 工具 | 说明 |
|------|------|
| `novel_build_context` | 组装起草某章所需的分层上下文（五层记忆 + 人物状态 + 相关设定 + 题材指引），内部并行拉取 |
| `novel_write_chapter` | **新建章节**：建正文文档 + 写章节索引 + 可选建 Wiki 节点 |
| `novel_read_chapter` | 读章节正文，支持 full / outline / keyword 三种模式 |
| `novel_append_chapter` | 续写已有章节，并回写字数 |
| `novel_update_summary` | **沉淀章节摘要**（分层记忆写入侧） |
| `novel_record_character_state` | 记录人物章末状态快照（位置/伤势/情绪/持有物） |
| `novel_record_event` | 记录事件索引（时间线、因果链） |
| `novel_upsert_book_summary` | 写入卷级 / 全书摘要（长程压缩记忆） |
| `novel_record_chapter_tension` | 记录本章张力曲线（开局/中段/结尾三档） |
| `novel_mark_chapter_memories_stale` | 当章被大幅修订时，标记下游章节摘要为"陈旧" |
| `novel_run_consistency_check` | **一致性检查（规则型）**：伏笔逾期、方位跳变、伤势突变、事件时序；可落库去重 |
| `novel_get_semantic_check_pack` | 备齐语义型检查所需材料（人物档案/设定/伏笔/历史摘要），交给模型审阅 |
| `novel_get_review_focus` | 题材化评审重点：检查权重排序、阻断阈值、题材专项评估线（03 文档第六节差异化的入口），并附**跨题材恒定的内容红线** |

| `novel_revise_chapter` | **改稿**：按场景/块/精确文本定位，支持 replace / expand / patch |
| `novel_list_scenes` | 列出章节的场景分节与 block id（改稿前探查用） |
| `novel_get_chapter_history` | 章节版本历史（改稿留痕，可回溯每次改动） |

| `novel_manage_work` | 作品管理：list / create / get_config / update_config（工具链入口） |
| `novel_manage_setting` | 设定词条：query / upsert（设定官） |
| `novel_manage_character` | 人物档案：query / upsert（人物官） |
| `novel_manage_outline` | 大纲：query / set_chapter_outline / upsert_volume（大纲官） |
| `novel_manage_foreshadow` | 伏笔：query / upsert，含埋设与回收状态 |
| `novel_manage_plotline` | 主线/支线剧情线：query / upsert |
| `novel_manage_branch` | 卡文救援的候选分支：query / upsert（救援官） |
| `novel_manage_relation` | 人物关系：query / upsert（含关系图检索） |
| `novel_advance_character_arc` | 推进人物弧光曲线（魂牵梦绕→觉醒→抉择→牺牲→新生） |
| `novel_breakthrough_planning` | 卡文时的突破性规划（与 `novel_manage_branch` 配合，思路→走向→成本） |

工具落点（哪个能力由谁负责）见 `docs/requirements/01-features-and-verification.md` 的 B/C/D/E/F/I/J 各组；
角色职责与权限边界见 `docs/requirements/03-agent-matrix.md`。

> 工具归属：
> - `novel_manage_*` / `novel_revise_*` / `novel_read_*` 等高频读和改工具会被 7 个 `novel_agent_*` 子代理在各自白名单内复用（见 §编排）。
> - 4 个相对低频工具（`novel_breakthrough_planning` / `novel_advance_character_arc` / `novel_record_chapter_tension` / `novel_mark_chapter_memories_stale`）目前由主会话（主编排官）按需直接调用，未来可按需拆出独立子代理。

### 工具粒度：为什么用 action 而不是拆成 12 个工具

实体管理类工具都用 `action`（query/upsert）区分读写，而非一个操作一个工具。
原因：**工具越多，「选对工具」本身越容易成为模型的失败来源**。
同类 CRUD 收敛到一个工具、用 action 区分，选择面小得多。
（读上下文/写章节/改稿这类核心动作仍是独立工具——它们语义差异大，
合并反而增加参数复杂度。）

### 改稿的定位策略

`novel_revise_chapter` 支持三种定位，推荐优先用 `scene`：

| 方式 | 适用 | 稳定性 |
|------|------|--------|
| `scene` | **推荐**。按 `## ` 场景标题定位，如「二、交锋」 | 高——标题是内容的一部分 |
| `blockId` | 已知确切块 id | 低——**文档结构一变就失效** |
| `match` | 精确文本替换（patch 动作） | 取决于文本是否唯一 |

场景匹配分三级：精确相等 → 剥离序号（「二、交锋」→「交锋」）→ 子串包含。

### 一致性检查的设计取舍

检查项分两类，实现策略完全不同：

| 类型 | 检查项 | 实现 |
|------|--------|------|
| **规则型** | H3 伏笔逾期、H5 方位/伤势、H4 时序 | 查表判定，**不需要模型**，结果确定、零成本 |
| **语义型** | H1 设定冲突、H2 人设崩坏、H7 前后矛盾 | 工具只**备齐材料**，由模型在会话中判断 |

理由：在工具里二次调用模型既贵又慢且难验证；而"人设崩了没有"这类
判断本就该由正在写作的模型来做——它手上有完整正文上下文。

**阈值与顺序随题材**（消费 `consistency_weights`，此前定义了无人用）：
问题列表按对应 `w_*` 权重降序排列；`blocking` 判定用题材预设的
`blocking_threshold`（网文 3 / 类型小说 2 / 纯文学 4），不再是写死的 4。
评审侧的题材差异（网文看爽点追读、类型看诡计公平、纯文学看语言心理）
用 `novel_get_review_focus` 按作品题材实时渲染——persona 是静态的，
不随题材变，所以差异必须走工具返回值。

## 编排（novel_agent_* 多智能体）

**主编排官 = 主会话模型本身**（不单独注册）；它把任务委托给 7 个专职子代理。
每个子代理拥有独立上下文、只看自己的工具白名单（`toolFilter.allow` 是硬约束），
prompt 与规矩由子代理各自的 `persona` 字段约束，与主会话 system prompt 解耦。

7 个 subagent 实例由仓内 `profiles/web/cordis.patch.yml` 注册，不入 git，
由 `pnpm sync:patch`（`scripts/sync-cordis-patch.mjs`）生成实机副本到
`~/.dsh/profiles/web/cordis.patch.yml`。**路径机制**：仓内 canonical 的
`name` 用 `__UNWR_ROOT__` 占位符（保持零个人路径），sync 时替换为
`UNWR_ROOT` 绝对路径。不能用 `!!js` 表达式在 YAML 里拼路径——
loader（cordis-plugin-loader ≥ 1.0.3）只对 `config` / `disabled` 字段
做 `!!js` 求值，`name` 会原样传给 `import()`，报
`name.startsWith is not a function`（实机踩坑 2026-09-02）。

| 子代理（toolName） | 角色 | 何时被委托 | 工具白名单 |
|---|---|---|---|
| `novel_agent_worldkeeper` | 世界观设定官 | 新增/修改设定、设计体系、查设定冲突 | `novel_manage_setting`, `novel_read_chapter`, `novel_manage_work`（只读） |
| `novel_agent_characterkeeper` | 人物官 | 建/改人物档案、人物立不住、记章末状态 | `novel_manage_character`, `novel_manage_relation`, `novel_record_character_state`, `novel_read_chapter`, `novel_manage_work`（只读） |
| `novel_agent_outliner` | 大纲官 | 列卷章大纲、伏笔埋收、剧情线与事件索引 | `novel_manage_outline`, `novel_manage_foreshadow`, `novel_manage_plotline`, `novel_record_event`, `novel_build_context`, `novel_read_chapter`, `novel_manage_work`（只读） |
| `novel_agent_drafter` | 起草官 | 写第 N 章、续写、自动写完本卷 | `novel_build_context`, `novel_read_chapter`, `novel_write_chapter`, `novel_append_chapter`, `novel_update_summary`, `novel_record_character_state`, `novel_record_event`, `novel_manage_outline`（只读）, `novel_manage_work`（只读） |
| `novel_agent_reviser` | 改稿官 | 改写/扩缩/换视角·人称·文风 | `novel_read_chapter`, `novel_list_scenes`, `novel_revise_chapter`, `novel_get_chapter_history`, `novel_manage_character`（只读） |
| `novel_agent_critic` | 评审官 | 评审诊断、定稿前检查 | `novel_get_review_focus`, `novel_read_chapter`, `novel_list_scenes`, `novel_run_consistency_check`, `novel_get_semantic_check_pack`, `novel_get_chapter_history` |
| `novel_agent_rescuer` | 卡文救援官 | 卡住了、要候选分支 | `novel_build_context`, `novel_manage_branch`, `novel_manage_foreshadow`, `novel_manage_character`（只读）, `novel_read_chapter` |

**硬约束**：评审官的白名单里**没有任何写工具**——它只诊断不代笔。

**软约束**：`toolFilter` 粒度只到「工具」级，而 `novel_manage_*` 是 query/upsert 合一。
改稿官与救援官拿到 `novel_manage_character` 只为**读**口癖与破局素材，其写权限由
persona 里的「只读约束」限制。同理，4 个建设型角色（设定/人物/大纲/起草）都拿到
`novel_manage_work`，只为 `action=list|get_config` 确认「自己在给哪部作品干活」——
子代理继承会话默认作品却**无法核对**，实机 2026-09-02 大纲官因此直接报
`unknown tool "novel_manage_work"`。真要硬隔离，需要把 `novel_manage_*` 拆成
`novel_query_*` / `novel_upsert_*` 两组工具——代价是工具数从 25 涨到 30+，
与「工具越少越好选」的取舍相冲突，暂不做。

**白名单缺工具 = 硬失败**：子代理调白名单外的工具会拿到
`Error: unknown tool "<name>"`（`ToolNotFoundError`），且它**没有任何自救手段**。
因此「子代理该能看到什么」必须一次性配够——宁可多给一个靠 persona 限只读的读工具，
也不要让它在关键路径上撞墙。

详见 `docs/requirements/03-agent-matrix.md`（角色职责与权限）。

启用：
```bash
export UNWR_ROOT=<仓库根绝对路径>
pnpm build                       # 构建 dist/unwr-novel.mjs
pnpm sync:patch                  # 占位符 → 绝对路径，生成两份实机副本：
                                 #   ~/.dsh/profiles/web/cordis.patch.yml （npx 版）
                                 #   dist/cordis.local.yml                （--patch overlay）
node --import tsx/esm apps/cli/src/bin.ts web --profile unwr \
  --patch $UNWR_ROOT/dist/cordis.local.yml
# 启动日志出现 7 个 unwr-agent-* 插件即表示编排注册成功
```

修改 persona / toolFilter：编辑 `profiles/web/cordis.patch.yml` → `pnpm sync:patch` → 重启实例。
构建产物 `dist/unwr-novel.mjs` 不变，无需 `pnpm build`。

### 路由契约（改一处必须同步另一处）

DSH 的 `tool-subagent` Config **没有 `description` 字段**，父模型看到的 7 个委托工具
描述是同一份通用文案，只能靠 `toolName` 区分。因此「什么意图该派给谁」写在两处：

1. `packages/novel/src/index.ts` → `WRITING_CONVENTIONS` 第 4 条的**意图→角色路由表**
   （主会话系统提示词，改它需要 `pnpm build`）
2. `profiles/web/cordis.patch.yml` → 每个 persona 首行的**「何时被委托」**
   （改它只需 `pnpm sync:patch` + 重启）

### 委托时的上下文传递

spawn provider 的 `inheritsParentContext = false`：子代理是**全新会话，看不到主对话**。
委托 prompt 必须自带作品名或 workToken、章节号、涉及的人物/场景、用户的原始约束
（见 `WRITING_CONVENTIONS` 第 5 条）。只写「改一下第三章」会让子代理选错作品或章节。

## 开发期踩坑记录

技术选型与实现阶段实测，均已由适配层屏蔽：

1. `@file` 只接受**相对路径**，绝对路径报 `unsafe file path`
2. `--json` **不支持 stdin**，仅 `--content`/`--pattern` 支持
3. 长 JSON **禁止内联**（伏笔表 schema 内联直接失败）
4. shell 单引号里 `\n` 是字面量，正文**必须**文件传参
5. `record-batch-update` 用 **map**，`batch-create` 用 **array**
6. `docs` 域响应比 `base` 域多一层 `data.document` 包裹
7. `docs +update` 的 `document` 与 `result` 是**平级**的
8. `--limit` 上限 200（非 ndjson 格式），长篇连载需分页
9. `--title` 会覆盖内容中同名的 `#` 标题（章标题由 title 承担，正文只用 `##`）
10. `record-list` 返回 `record_id_list`，与 `data` 逐行对应
11. `field-list` 的字段在 `data.fields`（不是 `data.items`）
12. `link` 字段**只能用 table_id**，不能用表名；且需在建表后单独创建
13. link 字段创建**偶发瞬时失败**，重跑即成功（脚本内已加 3 次退避重试）
14. 字段名不属于该表时报 `800030201 not_found`——以 `init-work.ts` 为单一真源，勿在飞书手工改名
15. **link 字段读回只有 record id**（`[{id:'recXX'}]`），不含可读值；
    要拿"第几章"必须先建立 `record_id → 章节号` 映射（一致性检查踩过此坑）
16. **Base 写入后有约 1 秒索引延迟**：实测 27 条记录时 t+668ms 查不到、t+1675ms 才查到。
    后果：创建章节后立刻做冲突检测会误判"无冲突"，导致重复创建同一章节号。
    `writeChapter` 已内置 `awaitVisible()` 轮询兜底
17. 飞书会把**短时间内连续编辑聚合为一个版本**——测试不能断言"每次编辑一个版本"
18. `--page-size` 上限 20、`--limit` 上限 200（非 ndjson 格式）
19. 错误响应形如 `{"ok":false,"error":{...}}`，解析信封时**不能**用 `lastIndexOf('{')`
    （会截到嵌套的 error 对象，把真实错误误报为"无法解析输出"）
20. **update 同样有读一致性延迟**（不只 create）——写后立即查询可能读到旧值，
    测试需 settle 等待；产品语义上接受最终一致
21. `drive +search` 无 `--limit`（是 `--page-size` 1-20），
    结果在 `data.results[]`（`result_meta` 内含 token/url），标题在 `title_highlighted`
    且**含高亮 HTML 标签需剥离**
22. DSH output schema 的嵌套 object **必须**写 `additionalProperties: false`
    且给出 `properties`，否则类型推导失败（缺前者报 missing，缺后者推导为 never）

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UNWR_LARK_BIN` | `lark-cli` | lark-cli 可执行文件路径 |
| `UNWR_MAX_CONCURRENCY` | `8` | 并发上限，避免触发飞书限流 |
| `UNWR_TEST_BASE` | 测试库 token | 测试用作品库 |
| `UNWR_TEST_SPACE` | 测试空间 ID | 测试用知识空间 |
