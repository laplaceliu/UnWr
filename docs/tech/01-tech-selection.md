# UnWr 技术选型

> 阶段：技术选型。技术栈已明确为 **TypeScript + DeepSeek Harness（DSH）**。
> 本篇回答核心问题：**飞书 CLI 要不要包装成 Tool？怎么包？** 并给出完整的架构与依赖方案。

---

## 〇、先回答你的问题

> **问**：需要把飞书 CLI 再包装成智能体调用的 function/tool 吗？

**答：需要。但不是"包装成 CLI 命令的镜像"，而是要做三层封装，且工具按「智能体意图」定义，不按「CLI 命令」定义。**

### 为什么不能直接把 lark-cli 暴露给模型

| # | 问题 | 后果 |
|---|------|------|
| 1 | **命令爆炸**：200+ 命令，每命令几十个 flag | 提示词塞不下，且模型选错命令 |
| 2 | **参数陷阱密集**（已在需求阶段实测）：`@file` 仅相对路径、`--json` 不支持 stdin、长 JSON 禁内联、`batch-update` 用 map 而 `batch-create` 用 array | 模型必踩，且失败模式隐蔽 |
| 3 | **高危操作无拦阻**：`+table-delete`、`+node-delete`、`overwrite` 均可直接执行 | 一次幻觉 = 删库 |
| 4 | **组合操作不可靠**：起草一章需 11 次 CLI 调用（见下） | 让模型自己串联，链路越长越易断 |
| 5 | **Token 效率**：模型要的是"写第三章"，不是"先查章节表再建文档再写索引" | 意图与命令之间隔着一整层语义 |

### 直接暴露 vs 三层封装的对比

```
❌ 直接暴露                          ✅ 三层封装
模型 → lark-cli 命令                 模型 → novel_write_chapter(章节号, 正文)
        ↓                                    ↓
   200+ 命令 / 参数陷阱 / 无拦阻        领域服务：校验 → 建文档 → 写索引 → 更新状态
                                             ↓
                                       飞书适配层：处理 @file 相对路径、重试、错误规范化
                                             ↓
                                       lark-cli（spawn）
```

---

## 一、关键技术实测数据

选型必须基于实测，不是直觉。以下数据决定架构：

| 指标 | 实测值 | 说明 |
|------|--------|------|
| `lark-cli` 单次调用 | **640 ms** | `base +table-list` 真实调用 |
| 纯进程启动开销 | **~67 ms** | `--dry-run` × 3 取均值，**占比仅 10%** |
| 网络开销 | **~570 ms** | 占比 **90%** |
| 串行 4 次调用 | **2290 ms** | — |
| 并行 4 次调用 | **605 ms** | **加速比 3.8×（近线性）** |

### 由数据得出的三个结论

**结论 1：性能瓶颈是网络，不是进程开销。**
这直接**推翻了"为了性能必须用 Node SDK 替代 shell out"的直觉**。进程开销只占 10%，换 SDK 最多省 67ms，却要重新实现 CLI 已封装的高级语义（如 `docs +media-insert` 的 4 步编排 + 自动回滚）——**投入产出比极差**。

**结论 2：性能的正确解法是并行，不是换 SDK。**
并行加速比 3.8× 近线性。「起草一章需 11 次调用」= 串行 7 秒 vs 并行 2 秒。这要求架构上必须有**上下文组装器**做批量并发拉取，而不是让模型逐个调工具。

**结论 3：`lark-cli` 无法作为库引入。**
实测：`@larksuite/cli` 的 `package.json` **无 `main` 字段**，`files` 仅含 `scripts/`，真实实现是 `bin/lark-cli`——**47MB 的 Go 静态二进制**（`ELF 64-bit LSB executable, statically linked, Go BuildID`）。只能 spawn，不能 `require`。

---

## 二、选型决策记录（ADR）

### ADR-1：飞书接入方式 → **shell out lark-cli**（而非 Node SDK）

| 方案 | 评价 |
|------|------|
| **A. shell out lark-cli** ✅ **选定** | 进程开销仅占 10%；复用需求阶段已验证的 33 项能力；认证已配好（user token 在安全存储）；`+shortcut` 已封装多步编排 |
| B. `@larksuiteoapi/node-sdk`（v1.73.0 可用） | 类型安全、省 67ms，但需重走 OAuth 拿 user token；需重新实现 CLI 全部高级封装；已验证成果作废 |
| C. 混合 | 增加两套代码路径的心智负担，收益不抵成本 |

**决策**：走 A。性能优化靠并行 + 缓存（见 ADR-3），不靠换 SDK。

> 若将来网络成为瓶颈，演进路径是：在适配层内部替换 `spawn` 为 SDK 调用，**上层领域服务与工具完全不动**——这正是分层的价值。

### ADR-2：Tool 粒度 → **意图级，约 22 个**（而非命令级 200+）

**粒度设计原则**：一个工具 = 智能体的一个完整意图，而非一次 CLI 调用。

| 反例（太细，命令级） | 正解（意图级） |
|---------------------|---------------|
| `base_record_list` + `docs_fetch` + `base_record_update` … | `novel_build_context(章节号)` |
| `docs_create` + `record_batch_create` + `wiki_node_create` | `novel_write_chapter(章节号, 正文)` |

**收益**：起草一章从「模型调 11 次工具」变成「模型调 1-2 次工具」，链路越短越可靠。

### ADR-3：性能优化 → **上下文组装器 + 并行 + 本地缓存**

- **上下文组装器** `novel_build_context` 内部用 `Promise.all` 并发拉取五层记忆
- **本地缓存**：作品配置、题材预设、人物档案等低频变动数据进内存缓存（带 TTL）
- 依据：并行加速比 3.8×（实测）

### ADR-4：安全 → **工具白名单 + 高危操作拦截**

- 工具层**不暴露**任何删除类操作（`+table-delete` / `+node-delete` / `+record-delete` 一律不注册）
- 覆盖类写操作（`overwrite`）禁用，只允许 `append` / `str_replace` / `block_replace`
- 利用 DSH 的 `tools/pre-execute` waterfall 做二次拦截（见架构章节）

### ADR-5：插件形态 → **类形式 Service + 工具插件分离**

| 插件 | 形态 | 职责 |
|------|------|------|
| `dsh-unwr-feishu` | **类形式（Service）** | 提供 `ctx.feishu` 服务，封装飞书适配层 |
| `dsh-unwr-novel` | 函数形式 | 注册 22 个小说工具，`inject: ['feishu']` |

**依据**：DSH 支持类形式插件（`class X extends Service`），其他插件通过 `inject: ['feishu']` 消费。这样飞书适配层可被复用和独立测试。

---

## 三、飞书 CLI 包装的三层架构

```
┌─────────────────────────────────────────────────────────┐
│ Layer 3  DSH Tool 层                                     │
│          22 个语义化工具，模型唯一可见的界面               │
│          novel_write_chapter / novel_build_context ...    │
│          · parameters: JSON Schema（模型可见）             │
│          · execute: 调 Layer 2                            │
├─────────────────────────────────────────────────────────┤
│ Layer 2  领域服务层（纯 TypeScript，业务语义）             │
│          · 校验参数与业务规则                              │
│          · 编排多次飞书调用为一个业务动作                  │
│          · 与飞书无关，可单测、可 mock                     │
├─────────────────────────────────────────────────────────┤
│ Layer 1  飞书适配层（封装 lark-cli，屏蔽全部参数陷阱）     │
│          · spawn 封装 + 超时 + 重试                       │
│          · @file 相对路径自动处理（写临时文件 → cd → 调用）│
│          · JSON 输出解析 + 错误规范化为 typed Error        │
│          · 并发控制（连接池）                              │
├─────────────────────────────────────────────────────────┤
│          lark-cli（Go 二进制，spawn）                     │
└─────────────────────────────────────────────────────────┘
```

### Layer 1 必须屏蔽的陷阱（需求阶段实测，见 `01-features-and-verification.md` 第三节）

| # | 陷阱 | 适配层如何屏蔽 |
|---|------|---------------|
| 1 | `@file` 仅接受相对路径 | 上层传绝对路径/内容 → 适配层写临时文件 → `cd` 临时目录 → 用相对路径调用 → 清理 |
| 2 | `--json` 不支持 stdin | 一律走临时文件，不用 `-` |
| 3 | 长 JSON 禁止内联 | 同上，统一走文件 |
| 4 | shell 单引号里 `\n` 非换行 | 正文内容**必须**走文件传参，绝不拼命令行 |
| 5 | `batch-update` 用 map，`batch-create` 用 array | 在适配层暴露统一签名，内部区分 |
| 6 | `formula`/`lookup` 需 `--i-have-read-guide` | 适配层自动追加 |
| 7 | 结构变更后 block_id 失效 | `block_replace` 前自动重新 fetch |
| 8 | Markdown 特殊字符需转义 | 提供 `escapeMarkdown()`，写入时自动应用 |

**这一层是整个方案的关键**：所有 CLI 的怪癖在此终结，上层代码永远不需要知道 `lark-cli` 存在。

---

## 四、Tool 清单（22 个）

> 命名遵循 DSH 约定：工具名 ≤64 字符，`[A-Za-z0-9_-]`。统一 `novel_` 前缀避免与 DSH 原生工具冲突。

### 作品与配置

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_list_works` | 列出全部作品库 | `drive +search --doc-types bitable` |
| `novel_create_work` | 建库、建表、建视图、建 Wiki 节点 | `base +base-create` + N×`+table-create` + `+view-create` + `wiki +node-create` |
| `novel_get_work_config` | 取作品配置与题材预设 | `base +record-get` |

### 设定

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_query_settings` | 按分类/关键词查设定词条 | `base +record-list --filter-json` |
| `novel_upsert_setting` | 新增或更新设定词条 | `base +record-batch-create/update` |

### 人物

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_query_characters` | 查人物档案（含别名、口癖、动机） | `base +record-list` |
| `novel_upsert_character` | 新增或更新人物 | `base +record-batch-create/update` |
| `novel_get_character_state` | 查人物在某章的状态快照 | 人物状态表 `filter` + `sort` |
| `novel_record_character_state` | 记录章末人物状态快照 | `base +record-batch-create` |

### 大纲与伏笔

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_query_outline` | 查卷章大纲 | 章节表/卷表 `record-list` |
| `novel_upsert_chapter_outline` | 写章节大纲要点 | `base +record-batch-update` |
| `novel_query_foreshadows` | 查伏笔（支持按状态、重要度过滤排序） | `base +record-list --filter-json --sort-json` |
| `novel_upsert_foreshadow` | 埋设/更新/回收伏笔 | `base +record-batch-create/update` |

### 章节（核心）

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| **`novel_build_context`** | **组装五层上下文（核心工具，内部并行拉取）** | ~11 次调用并发 |
| `novel_read_chapter` | 读章节正文（支持 keyword/outline/range 作用域） | `docs +fetch` |
| `novel_write_chapter` | 新建章节：建文档 + 建索引 + 建节点 | `docs +create` + `record-create` + `wiki +node-create` |
| `novel_append_chapter` | 续写 | `docs +update --command append` |
| `novel_revise_chapter` | 改稿（句级 str_replace / 段落级 block_replace） | `docs +update` |
| `novel_search_chapters` | 跨章节关键词检索（一致性检查用） | 遍历章节 + `docs +fetch --scope keyword` |

### 记忆

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_update_summary` | 更新章节/卷/全书摘要 | `base +record-batch-update` |
| `novel_record_event` | 记录事件索引 | `base +record-batch-create` |

### 检查

| 工具 | 说明 | 内部 CLI 调用 |
|------|------|--------------|
| `novel_run_consistency_check` | 运行一致性检查，返回问题清单 | 规则型查表 + 语义型调模型 |
| `novel_get_chapter_history` | 取章节版本历史（改稿留痕） | `docs +history-list` |

**合计 22 个**。覆盖 MVP 全部 P0 功能点。

---

## 五、DSH 插件架构

### 5.1 插件入口（类形式 Service）

```typescript
// packages/unwr-feishu/src/index.ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { feishu: FeishuService }
}

export default class FeishuService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'feishu') }
  // 暴露领域方法供其他插件调用
}
```

```typescript
// packages/unwr-novel/src/index.ts
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'unwr-novel'
export const inject = ['tools', 'feishu']   // 依赖飞书服务

export function apply(ctx: Context, config: Config) {
  for (const tool of allTools) ctx.tools.register(defineTool(tool(ctx.feishu)))
}
```

### 5.2 工具定义范式

```typescript
defineTool({
  name: 'novel_write_chapter',
  description: '新建一章：创建正文文档、写入章节索引、创建目录节点。',
  parameters: {
    workToken: { type: 'string', required: true, description: '作品 base_token' },
    chapterNo: { type: 'number', required: true, description: '章节号' },
    title:     { type: 'string', required: true, description: '章节标题' },
    content:   { type: 'string', required: true, description: 'Markdown 正文' },
  },
  output: {
    schema: { type: 'object' },
    render: (_args, v) => [{ type: 'text', text: JSON.stringify(v) }],
  },
  async execute(args) { /* 调 Layer 2 */ },
})
```

### 5.3 用 DSH 事件做安全拦截

```typescript
// 在 pre-execute 阶段拦截高危操作
ctx.waterfall('tools/pre-execute', async (toolName, args, next) => {
  if (toolName.startsWith('novel_') && isDestructive(toolName, args)) {
    throw new Error(`操作被拦截：${toolName} 需要用户确认`)
  }
  return next()
})
```

> DSH 的 Tool 执行管道：`pre-execute → execute → post-execute → tool/result`。
> 权限拦截、审批、超时取消（`ToolExecution.signal`）、session 日志**天然具备**，无需自建。

### 5.4 多智能体的实现（待确认 AG-1）

DSH 提供 `@deepseek-ai/cordis-plugin-group` + `isolate` 做服务隔离。候选方案：

| 方案 | 做法 | 评价 |
|------|------|------|
| **A. 单一插件 + 提示词切换** ✅ 首版建议 | 22 个工具全注册；8 个角色靠 system prompt 切换 | 简单，共享上下文，符合"默认自动可手动接管" |
| B. 多插件 + 服务隔离 | 每角色一个插件组，各自注册子集工具 | 隔离彻底，但角色间共享上下文变复杂 |
| C. 子智能体（subagent） | 编排官 spawn 子会话 | 依赖 DSH 是否支持，待确认 |

**首版建议 A**：角色 = 提示词 + 工具子集白名单，切换成本低，符合需求。

---

## 六、目录结构

```
UnWr/
├── docs/
│   ├── requirements/          # 已完成：需求阶段 5 份文档
│   └── tech/
│       └── 01-tech-selection.md
│
└── packages/
    ├── unwr-feishu/           # Layer 1 飞书适配层（Service 插件）
    │   ├── package.json       # dsh.bundle 声明
    │   ├── cordis.patch.yml
    │   └── src/
    │       ├── index.ts       # FeishuService（类形式）
    │       ├── cli.ts         # spawn 封装：超时/重试/并发控制
    │       ├── file-bridge.ts # 临时文件桥接（破解 @file 相对路径限制）
    │       ├── errors.ts      # 错误规范化
    │       ├── markdown.ts    # Markdown 转义/反转义
    │       └── apis/
    │           ├── base.ts    # 多维表格
    │           ├── docs.ts    # 云文档
    │           ├── wiki.ts    # 知识空间
    │           └── drive.ts   # 云盘
    │
    ├── unwr-novel/            # Layer 2+3 领域服务与工具（工具插件）
    │   └── src/
    │       ├── index.ts       # apply() 注册 22 个工具
    │       ├── domain/        # Layer 2 领域服务
    │       │   ├── work.ts
    │       │   ├── setting.ts
    │       │   ├── character.ts
    │       │   ├── outline.ts
    │       │   ├── chapter.ts
    │       │   ├── memory.ts
    │       │   └── consistency.ts
    │       ├── context/
    │       │   └── builder.ts # 上下文组装器（并行拉取核心）
    │       ├── genre/
    │       │   └── presets.ts # 三套题材预设（来自 04 文档）
    │       ├── agents/
    │       │   └── prompts.ts # 8 个角色提示词
    │       ├── schema/
    │       │   └── tables.ts  # 13 张表的字段定义（来自 02 文档）
    │       └── tools/         # Layer 3 工具定义
    │           ├── work.ts
    │           ├── setting.ts
    │           ├── character.ts
    │           ├── outline.ts
    │           ├── chapter.ts
    │           ├── memory.ts
    │           └── consistency.ts
    │
    └── unwr-schema/           # 共享类型与常量（纯类型，无运行时）
        └── src/
            ├── tables.ts      # 表名/字段名常量（防拼写错）
            └── genre.ts       # 题材参数类型
```

**为何拆分三个包**：
- `unwr-feishu` 可独立复用/替换（未来换 Node SDK 只改这个包）
- `unwr-schema` 纯类型，表名/字段名常量化——**避免字符串拼写错误**（飞书 API 对字段名极其敏感，写错静默失败）
- `unwr-novel` 承载业务逻辑

---

## 七、依赖清单

### 运行时依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `@deepseek-ai/cordis` | 随 DSH | IoC 容器，Service 基类 |
| `@deepseek-ai/dsh-tools` | 随 DSH | `defineTool()` DSL |
| `@deepseek-ai/schemastery` | 随 DSH | Config Schema 定义 |
| `zod` | ^3 | 工具参数运行时校验（补充 JSON Schema 的表达力） |
| `p-limit` | ^6 | 并发控制（限制同时 spawn 数，建议 8） |

### 开发依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `typescript` | ^5 | 类型 |
| `tsx` | ^4 | 直接运行 TS（DSH 插件用绝对路径引用 .ts） |
| `vitest` | ^2 | 单测（领域服务层可 mock 适配层） |
| `pnpm` | 11.7.0 | DSH 指定 |

### 系统依赖

| 项 | 说明 |
|----|------|
| `lark-cli` | v1.0.92（已装，`@larksuite/cli`） |
| Node.js | ^22.19 或 >=24（当前 v24.20.0 ✅） |
| 飞书认证 | 已配置：`<user-home>/.lark-cli/config.json`，user token 就绪 |

> **注意**：**不引入** `@larksuiteoapi/node-sdk`。见 ADR-1。

---

## 八、环境就绪度检查

| 项 | 状态 | 说明 |
|----|------|------|
| Node.js v24.20.0 | ✅ | DSH 要求 ^22.19 或 >=24 |
| pnpm v11.18.0 | ✅ | DSH 文档指定 11.7.0，本机 11.18.0（`<user-home>/.bun/bin/pnpm`），同 major 版本应兼容 |
| `lark-cli` v1.0.92 | ✅ | Go 二进制，仅可 spawn |
| 飞书 user 身份 | ✅ | `lark-cli doctor` 双身份就绪 |
| 测试作品库 | ✅ | `<TEST_BASE>` |
| 测试知识空间 | ✅ | `<TEST_SPACE>` |
| **DSH 源码** | ❌ **未安装** | 全盘搜索未找到；需 `git clone https://github.com/deepseek-ai/deepseek-harness.git` |

---

## 九、风险与待确认

| # | 风险/问题 | 影响 | 建议 |
|---|-----------|------|------|
| **T-1** | **DSH 环境未就绪** | 阻塞开发 | 先 clone 并跑通 `pnpm dsh web`，验证 hello-plugin 后才能开发 |
| **T-2** | DSH 是否有 subagent 机制 | 决定多智能体实现方式（方案 A/B/C） | 首版用方案 A（提示词切换），不依赖此特性 |
| **T-3** | 并发上限 | 飞书 API 有 QPS 限制，并发过高可能被限流 | 用 `p-limit` 限 8，加重试退避 |
| **T-4** | user token 过期 | 长跑任务中断 | 适配层捕获认证错误，提示重新 `lark-cli auth login` |
| **T-5** | 长文本 spawn | 章节正文经临时文件传递，需清理 | `file-bridge` 用 `ctx.effect()` 注册清理钩子 |
| **T-6** | 工具数量增长 | 22 个已不少，后续可能膨胀 | 保持意图级粒度，新增前先考虑能否合并进现有工具 |

---

## 十、下一步

技术选型已完成，建议按此顺序推进：

1. **搭 DSH 环境**：clone + `pnpm install` + 跑通 hello-plugin（验证 T-1）
2. **建 `unwr-feishu` 骨架**：先实现 `cli.ts`（spawn + 错误规范化）+ `file-bridge.ts`（破解路径限制），用已验证的 33 项能力做冒烟测试
3. **实现 `novel_build_context`**：这是最高价值工具，内部并行拉取，先跑通它即验证了架构
4. **逐个补齐 22 个工具**：按 MVP 优先级（见 `01-features-and-verification.md` 第五节）

**验证标准**：每个工具用测试库 `<TEST_BASE>` 实机跑通，与需求阶段验证方式一致。
