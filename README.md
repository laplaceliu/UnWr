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
```

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
export UNWR_ROOT=/path/to/UnWr   # cordis.yml 用此变量拼接插件路径

cd /path/to/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts web --profile unwr \
  --patch $UNWR_ROOT/cordis.yml
```

## 已实现的工具（20 / 22）

| 工具 | 说明 |
|------|------|
| `novel_build_context` | 组装起草某章所需的分层上下文（五层记忆 + 题材指引），内部并行拉取 |
| `novel_write_chapter` | **新建章节**：建正文文档 + 写章节索引 + 可选建 Wiki 节点 |
| `novel_read_chapter` | 读章节正文，支持 full / outline / keyword 三种模式 |
| `novel_append_chapter` | 续写已有章节，并回写字数 |
| `novel_update_summary` | **沉淀章节摘要**（分层记忆写入侧） |
| `novel_record_character_state` | 记录人物章末状态快照（位置/伤势/情绪/持有物） |
| `novel_record_event` | 记录事件索引（时间线、因果链） |
| `novel_upsert_book_summary` | 写入卷级 / 全书摘要（长程压缩记忆） |
| `novel_run_consistency_check` | **一致性检查（规则型）**：伏笔逾期、方位跳变、伤势突变、事件时序；可落库去重 |
| `novel_get_semantic_check_pack` | 备齐语义型检查所需材料（人物档案/设定/伏笔/历史摘要），交给模型审阅 |

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

待实现（2 个）：novel_export_work（导出）、novel_import_manuscript（导入）。
见 `docs/tech/01-tech-selection.md` 第四节。

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
