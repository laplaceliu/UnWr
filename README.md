# UnWr — Unlimited Writing

小说写作 AI 智能体，作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件运行。

- **多智能体编排**：1 个主编排官 + 7 个领域子代理（设定官 / 人物官 / 大纲官 / 起草官 / 改稿官 / 评审官 / 救火官），由 28 个 `novel_*` 工具落地。
- **飞书为单一可信源**：13 张多维表格存结构化数据（设定/人物/大纲/伏笔/章节索引/记忆索引/分支/检查…），云文档（docx）存章节正文；本地无独立存储。
- **三套题材预设**：中文网文 / 类型小说 / 纯文学，按统一维度差异化取值（节奏、刺激点、爽点密度、线索公平…），新增题材不需改流程。
- **生产级鲁棒性**：所有 link 写入走落库验证 + 3s/6s/9s 退避；重名字段自愈；写后索引延迟轮询容忍；DSH 进程重启后会话级默认作品自动恢复。

> 当前阶段：DSH 插件核心链路已落地（28 工具 / 7 子代理 / 三层架构 / 端到端 e2e 已通过），UI 工作台暂未实现也不在用——一切以 DSH 主会话 + 工具调用交互为主。

---

## 仓库结构

```
UnWr/
├── cordis.yml                    # DSH 插件注册清单（unwr-novel + unwr-web）
├── package.json                  # pnpm 工作区根，DSH 依赖通过相对路径 link
├── pnpm-workspace.yaml
├── profiles/
│   ├── web/cordis.patch.yml      # 7 个子代理实例 + toolFilter + persona
│   └── agent/headless-overlay.yml # dsh-headless 无人值守覆盖（persona + UNWR_WORK_BASE 报告尾行）
├── scripts/
│   ├── build-plugin.mjs          # esbuild 出 dist/{unwr-novel,unwr-web}.mjs
│   ├── sync-cordis-patch.mjs     # profiles/web/cordis.patch.yml → ~/.dsh/profiles/web/
│   ├── setup-dsh-links.mjs       # DSH 源码目录不在默认位置时重定向
│   ├── setup-test-base.mjs       # 在飞书创建一个干净的测试 Base（含 13 表）
│   ├── run-e2e.mjs               # test:e2e + test:agent 入口
│   ├── verify-bundle.mjs         # 校验 dist 产物 + 插件可见性
│   ├── repair-dup-fields.ts      # 实机重名字段修复（tsc 0 错；幂等）
│   ├── audit-work.ts             # 离线审计 work-state.json 与远端 Base 一致性
│   ├── build-publish.mjs         # 离线打包（pack:plugin）
│   └── feishu/scripts/smoke.ts   # feishu 包 spawn smoke（pnpm smoke）
├── packages/
│   ├── schema/   # 飞书 13 张表的字段定义 + 三套题材预设 + 全局常量
│   ├── feishu/   # L1 飞书适配层：spawn lark-cli，typed 领域 API，屏蔽全部 CLI 陷阱
│   ├── novel/    # L2 领域服务 + L3 DSH 工具层（28 个 novel_* 工具）
│   └── web/      # 预留的 DSH web 插件壳（dist 已构建；UI 未启用）
├── docs/
│   ├── guide/        # 使用手册（你在这里）
│   ├── requirements/ # 需求文档（功能 / 数据模型 / 智能体矩阵 / 题材预设 / 记忆与一致性）
│   └── tech/         # 技术决策记录
└── pnpm-lock.yaml
```

---

## 工具清单（28 个 `novel_*` 工具）

工具按文件分组；运行时由 `packages/novel/src/index.ts` 的 `apply()` 注册到 `ctx.tools`。
**默认安全模式（`readOnlySafeMode: true`）下**：覆盖式 / 删除类工具不会被注册（防模型幻觉造成不可逆损失）。

### `tools/work.ts` — 作品注册表
| 工具 | 意图 |
|---|---|
| `novel_manage_work` | 切换 / 查询 / 创建作品；维护会话级默认作品（`action: list\|create\|get\|switch`） |

### `tools/entity.ts` — 实体管理（设定 / 人物 / 关系）
| 工具 | 意图 |
|---|---|
| `novel_manage_setting` | 设定词条 CRUD；分类（地理/势力/规则/历史/物品/功法） |
| `novel_manage_character` | 人物 CRUD；姓名/别名/角色定位/首次出场章节 |
| `novel_manage_relation` | 人物关系 CRUD；按类型（亲属/师徒/对手/暧昧…） |

### `tools/chapter.ts` — 章节正文（构建 / 起草 / 读取 / 追加 / 列场景）
| 工具 | 意图 |
|---|---|
| `novel_build_context` | 拼装分层上下文（L0/L1/L2/L3）；含题材指引 `writingGuide` |
| `novel_write_chapter` | 起草新章（含 `cast` 参数→双向写入章节表.出场人物 + 人物表.出场章节） |
| `novel_read_chapter` | 读章节正文（`mode: full\|outline\|search`） |
| `novel_append_chapter` | 追加正文到章末（适合分批起草） |
| `novel_list_scenes` | 列本章场景（按段落/空行切分，含 sceneId） |

### `tools/memory.ts` — 记忆沉淀
| 工具 | 意图 |
|---|---|
| `novel_update_summary` | 更新章节摘要（L1：章节级记忆） |
| `novel_record_character_state` | 记录章末人物状态快照（地点/状态/持有物品） |
| `novel_record_event` | 记录剧情事件（含 `chapter` link，标 `is_turning_point`） |
| `novel_upsert_book_summary` | 卷/全书摘要 query\|upsert 合一（按标题去重） |
| `novel_mark_chapter_memories_stale` | 章节改稿后批量标记忆陈旧（待重新沉淀） |

### `tools/revision.ts` — 改稿与版本
| 工具 | 意图 |
|---|---|
| `novel_revise_chapter` | 改稿（`action: patch\|insert_after\|expand`）；按段落 / 块 / 块区间定位 |
| `novel_list_scenes` | 同上（与改稿配套：先看场景再改） |
| `novel_get_chapter_history` | 列章节修订历史 |
| `novel_restore_chapter` | 一键回滚到任一历史版本（改稿安全网） |

### `tools/consistency.ts` — 一致性检查
| 工具 | 意图 |
|---|---|
| `novel_run_consistency_check` | 跑一遍设定 / 人设 / 伏笔 / 时间线 / 红线 全量检查 |
| `novel_get_semantic_check_pack` | 取出本章的语义检查包（送评审官用） |
| `novel_get_review_focus` | 取本作题材的评审重点（权重 + 阻断阈值 + 题材专项） |

### `tools/context.ts` — 大纲 / 伏笔 / 剧情线 / 分支
| 工具 | 意图 |
|---|---|
| `novel_manage_foreshadow` | 伏笔 CRUD；按类型（主线/支线/人物/物品）+ 状态 |
| `novel_manage_plotline` | 剧情线 CRUD；推进状态（铺垫/推进/高潮/收束/完结） |
| `novel_manage_outline` | 章节大纲 CRUD；与卷联动 |
| `novel_manage_branch` | 候选分支 CRUD（写章前的多版本规划） |

### `tools/calculate.ts` — 字数与节奏计算
| 工具 | 意图 |
|---|---|
| `novel_calculate` | 字数 / 节奏 / 爽点密度 / 线索公平 等组合指标 |

### 高阶规划（`tools/breakthrough.ts`、`tools/character-arc.ts`、`tools/tension.ts`）
| 工具 | 意图 |
|---|---|
| `novel_breakthrough_planning` | 突破性章节规划（爽点密度突变 / 视角切换 / 时间跳跃） |
| `novel_advance_character_arc` | 推进人物弧光（成长 / 转折 / 黑化 / 救赎） |
| `novel_record_chapter_tension` | 记录本章张力评级（1-5 星）+ 备注 |

---

## 子代理矩阵（7 个 `novel_agent_*` 委托工具）

定义在 `profiles/web/cordis.patch.yml`，由宿主 `@deepseek-ai/dsh-tool-subagent` 实例化。**`toolFilter` 是硬约束**——评审官拿不到任何写工具，设定官拿不到读作品外的工具等。

| 子代理 | toolFilter.allow | 职责 | 何时调用 |
|---|---|---|---|
| **世界官** `novel_agent_worldkeeper` | `novel_manage_setting`、`novel_manage_work`、`novel_manage_foreshadow`、`novel_manage_plotline` | 设定 / 伏笔 / 剧情线 增删改 | 主编排官发现需要新增/修订设定或伏笔时 |
| **人物官** `novel_agent_characterkeeper` | `novel_manage_character`、`novel_manage_relation`（+ `novel_manage_work` 仅 query）+ `novel_record_character_state` | 人物 / 关系 CRUD；章末状态快照 | 起草官完成一章后录入人物快照；需新增人物时 |
| **大纲官** `novel_agent_outliner` | `novel_manage_outline`、`novel_manage_branch`、`novel_manage_foreshadow`、`novel_manage_plotline`（+ `novel_manage_work` 仅 query） | 大纲 / 分支规划 | 主编排官做卷规划时 |
| **起草官** `novel_agent_drafter` | `novel_build_context` + 全套 chapter/revision/memory/上下文/计算/规划工具（+ `novel_manage_work` 仅 query） | 写章正文 + 配套场景/记忆/计算 | 主编排官决定起草某章时 |
| **改稿官** `novel_agent_reviser` | `novel_revise_chapter`、`novel_list_scenes`、`novel_read_chapter`、`novel_get_chapter_history`、`novel_restore_chapter`（+ `novel_manage_work` 仅 query） | 微调刚写完的章节 | 起草官完成后主编排官认为需打磨细节 |
| **评审官** `novel_agent_critic` | `novel_run_consistency_check`、`novel_get_semantic_check_pack`、`novel_get_review_focus`、`novel_read_chapter`（+ `novel_manage_work` 仅 query） | 一致性 / 红线评审 | 章稿完成后 / 主编排官认为需要审稿时 |
| **救火官** `novel_agent_rescuer` | 全套查询工具 + `novel_restore_chapter` + `novel_mark_chapter_memories_stale`（+ `novel_manage_work` 仅 query） | 兜底修复（重写 / 回滚 / 标记忆陈旧） | 评审官发现重大问题、救火官介入 |

> **主编排官 = 主会话模型本身**，不单独注册。它通过 7 个 `novel_agent_*` 工具调度子代理；每次调度都遵循 `toolFilter` 硬约束。
> **persona / WRITING_CONVENTIONS** 写在 `cordis.patch.yml` 各角色的 `persona:` 块——标签纪律、记忆沉淀流程、章节正文渲染规范都在那里定义。

---

## 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  L3  DSH 工具层  (packages/novel/src/tools/*.ts)                │
│      28 个 novel_* 工具，defineTool() 注册，execute 负责串联    │
└─────────────────────────────┬───────────────────────────────────┘
                              │ 调用纯 TS 领域函数
┌─────────────────────────────▼───────────────────────────────────┐
│  L2  领域服务层  (packages/novel/src/domain/*.ts)               │
│      业务语义，零 CLI 知识，纯函数可 mock；含 selfheal / 写入退避 │
└─────────────────────────────┬───────────────────────────────────┘
                              │ 调用 typed 适配
┌─────────────────────────────▼───────────────────────────────────┐
│  L1  飞书适配层  (packages/feishu/src/*.ts)                      │
│      spawn lark-cli；提供 base/record/docs/path 四组 typed API   │
│      matrixToObjects 合并重名字段；verifyRetryDelays 落库验证     │
└─────────────────────────────────────────────────────────────────┘
```

**为什么 L1 用 spawn 不用 SDK**：lark-cli 是 47MB Go 静态二进制（package.json 无 main），只能 spawn。实测单次调用 640ms，进程启动占 67ms（10%），网络占 570ms（90%）——换 SDK 最多省 10% 启动时间，性价比极低。**真性能解法是并行 + 缓存，不是换 SDK**（4 次并行 3.8× 加速）。

---

## 开发命令速查

| 命令 | 作用 |
|---|---|
| `pnpm install` | 装依赖 + 自动 setup-dsh-links（DSH 源码在 `../dsh/`） |
| `pnpm setup:dsh` | DSH 源码目录不在默认位置时手动重定向 |
| `pnpm build` | esbuild 出 `dist/unwr-novel.mjs` + `dist/unwr-web.mjs` |
| `pnpm build:watch` | watch 模式 |
| `pnpm sync:patch` | 把 `profiles/web/cordis.patch.yml` 同步到 `~/.dsh/profiles/web/` |
| `pnpm build:profile` | build + sync:patch 一步到位 |
| `pnpm typecheck` | tsc 严格模式（0 错为门槛） |
| `pnpm test` | vitest 全量（**注意：全量耗时 18-25s**；CI 用 `pnpm test --run <spec>` 跑单个 spec） |
| `pnpm test:tools` | **工具本身探针**：38 发按编排时序打 28 个工具 + 探参数坑（无需真飞书） |
| `pnpm test:setup-base` | 在飞书创建一个干净测试 Base（13 表 + 预置数据）；输出 `UNWR_TEST_BASE=<token>` |
| `pnpm test:e2e` | 端到端生命周期 + 错误分支（需 `UNWR_TEST_BASE`） |
| `pnpm test:agent` | 全链路编排（564s，DSH headless 跑完整写一部短篇）；无需 playwright |
| `pnpm smoke` | feishu 包 spawn smoke（验 lark-cli 链路） |
| `pnpm verify:bundle` | 校验 dist 产物 + 插件可见性 |
| `pnpm pack:plugin` | 离线打包（不发布）；用于分发场景 |

---

## 环境变量速查

| 变量 | 必填 | 用途 |
|---|---|---|
| `UNWR_ROOT` | 必填 | 指向本仓库绝对路径（cordis.yml 用 `!!js process.env.UNWR_ROOT` 拼插件绝对路径；未设置则报错） |
| `UNWR_LARK_BIN` | 可选 | lark-cli 可执行文件绝对路径。留空时插件走 env → Windows 常见安装位置 → PATH 三级回落 |
| `UNWR_TEST_BASE` | e2e 必填 | 测试用飞书 Base token（`pnpm test:setup-base` 一次性产出） |
| `UNWR_TEST_SPACE` | 可选 | 测试用飞书知识空间 ID（默认走 search） |
| `UNWR_DEBUG_SELFHEAL` | 可选 | `=1` 时 selfheal 退避过程会 `console.log`（默认仅 `console.warn`） |
| `UNWR_STATE_FILE` | 可选 | 覆盖作品注册表路径（默认 `~/.unwr/work-state.json`；仓库外，隐私红线） |
| `DSH_PERMISSION_MODE` | headless 必填 | `=danger-full-access`（无 UI 无人审批） |
| `DSH_TELEMETRY_DISABLED` | headless 必填 | `=1`（关遥测） |

---

## 已知硬坑（踩过的，写在这里防复发）

1. **link 写入后服务端可能静默丢弃**——飞书 `record-batch-update` 对刚创建的记录回填 link 字段曾 60% 静默失败（返回 ok:true 但数据没落）。**唯一防御=回填后按 ID 读回验证**（`record-get` 传**真实表 id** 而非表名），验证不过按 3s/6s/9s 退避重试。落地为 `feishu/base.ts` 的 `updateRecordsWithSelfHeal`。
2. **写后索引延迟 ~6s+**——`record-list` 查不到刚建的记录，但按 ID `record-get` 立即可见；任何"写后立即查"必须用进程内写缓存或退避。
3. **`record-list --field-id` 传字段名时 link 字段投影静默 ignore**——link 表查询拉全字段本地处理。
4. **跨段 `str_replace` 必败**——lark-cli `--pattern` 只匹配块内连续文本；跨段落/多行必须用 `block_replace` + `--start-block-id` / `--end-block-id`（`feishu/docs.ts` 的 `BlockTarget = string \| BlockRange` 已封装）。
5. **DSH web profile 必须重启**——cordis patch 不热重载。改完 `cordis.patch.yml` → `pnpm sync:patch` → 必须重启 3080 实例。
6. **DSH 依赖必须装根目录**——`@deepseek-ai/cordis` / `dsh-tools` / `dsh-tool-subagent` 装在 `packages/novel/` 下会导致宿主加载时报 `ERR_MODULE_NOT_FOUND`（已实测）。`package.json` 用相对路径 link 到 `../../dsh/...`；DSH 源码目录不同时跑 `pnpm setup:dsh` 重定向。
7. **DSH web server `/api` 前缀保留**——工作台 API 走 `/workbench/api/*`，dispatcher 内剥前缀归一为 `/api` 再分支匹配。
8. **bitable 里有重名字段会静默丢值**——`matrixToObjects` 按名建键后列覆盖前列；L1 已合并读侧去重 + bootstrap 加 `repairDuplicateFields` 自愈（改名 + 按 field_id_list 对位读 + 并集回填 + 验证通过才删原列）。

---

## 隐私红线

**仓库中不得出现 `/home/maigi`、个人姓名、真实飞书 `base_token` / `space_id`**——已用 `git filter-repo --replace-text` 清理过历史。**新增代码默认用占位符**（`<TEST_BASE>`、`$UNWR_ROOT`）+ 环境变量注入。

`work-state.json` 落在 `~/.unwr/`（**仓库外**），避免真实 base_token 进工作区；测试环境自动改 tmpdir。

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：IoC 容器 / 工具注册 / 多代理 spawn 基建
- [lark-cli](https://www.npmjs.com/package/@larksuite/cli)：飞书官方 CLI
- [Vitest](https://vitest.dev/)：测试基建

## License

MIT