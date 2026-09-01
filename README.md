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
- `lark-cli` v1.0.92（飞书认证已配置于 `~/.lark-cli/config.json`）
- DSH 源码：`<user-home>/Source/github.com/dsh`

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
#    已配置：~/.dsh/profiles/web/cordis.patch.yml
#    内容指向 <user-home>/Source/github.com/laplaceliu/UnWr/dist/unwr-novel.mjs

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
cd <user-home>/Source/github.com/dsh
node --import tsx/esm apps/cli/src/bin.ts web --profile unwr \
  --patch <user-home>/Source/github.com/laplaceliu/UnWr/cordis.yml
```

## 已实现的工具

| 工具 | 说明 |
|------|------|
| `novel_build_context` | 组装起草某章所需的分层上下文（五层记忆 + 题材指引），内部并行拉取 |

其余 21 个工具见 `docs/tech/01-tech-selection.md` 第四节。

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

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `UNWR_LARK_BIN` | `lark-cli` | lark-cli 可执行文件路径 |
| `UNWR_MAX_CONCURRENCY` | `8` | 并发上限，避免触发飞书限流 |
| `UNWR_TEST_BASE` | 测试库 token | 测试用作品库 |
| `UNWR_TEST_SPACE` | 测试空间 ID | 测试用知识空间 |
