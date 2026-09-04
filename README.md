# UnWr — Unlimited Writing

小说写作 AI 智能体，作为 [DeepSeek Harness](https://deepseek-harness.help) 插件运行。

- **28 个 `novel_*` 工具** + **7 个领域子代理**（设定 / 人物 / 大纲 / 起草 / 改稿 / 评审 / 救火）
- **飞书为单一可信源**：13 张多维表格存结构化数据，云文档存章节正文
- **三套题材预设**：中文网文 / 类型小说 / 纯文学
- **已发布到 npmjs**：`@laplaceliu/unwr`，用 `dsh plugin add` 即可装

---

## 安装

> DSH 是个 `npx` 命令，**不是全局可执行**——所有 DSH 命令都走 `npx @deepseek-ai/dsh ...`。嫌长可以加 alias：
> ```bash
> echo "alias dsh='npx @deepseek-ai/dsh'" >> ~/.zshrc && source ~/.zshrc
> ```

任选一种：

### 方式 A：从 npmjs 安装（推荐）

```bash
# 1. 装 UnWr 到 web profile
npx @deepseek-ai/dsh plugin --profile web add @laplaceliu/unwr@latest
# 默认范围 ^0.1.0（旧版），务必带 @latest 或显式 @0.1.3
# 升级：npx @deepseek-ai/dsh plugin --profile web update @laplaceliu/unwr

# 2. 确认 UnWr 在 web profile 的 bundles（让 cordis.patch.yml 加载）
grep -A 6 '"dsh"' ~/.dsh/profiles/web/package.json
# 应看到 dsh.profile.bundles 含 "@laplaceliu/unwr"

# 3. 启动 DSH（cordis patch 不热重载，每次配置变更后必须重启）
npx @deepseek-ai/dsh web
# 默认 3080 → http://127.0.0.1:3080
```

### 方式 B：从 DSH 插件市场安装

浏览 https://www.dsh.so/zh/artifact/unwr/ → 一键安装。

### 方式 C：从本地 tarball 安装

```bash
# 下载 tarball：github release 或 dsh.so
npx @deepseek-ai/dsh plugin --profile web add ./unwr-0.1.3.tgz
# tarball 是 file: 引用，升级就 re-add 新 tarball
npx @deepseek-ai/dsh web
```

### 方式 D：DSH Desktop（macOS / Windows）

桌面客户端 https://www.dshdesktop.cn/ ，在插件市场搜索 **UnWr** 一键安装。

---

## lark-cli 安装与认证

插件通过 [lark-cli](https://github.com/larksuite/cli) 与飞书交互。

**官方推荐安装**（升级 + 配置，一次性）：

```bash
npx @larksuite/cli@latest install
# 交互式：选择「仅升级 lark-cli / 同时初始化 lark-cli / 升级并登录」
```

**首次认证**（三步）：

```bash
# 1. 初始化应用凭证：绑定 App ID + App Secret（仅一次）
lark-cli config init
#   也可非交互：lark-cli config init --app-id cli_xxx --app-secret-stdin < <secret>
#                --brand feishu

# 2. OAuth 登录（推荐带 --recommend，只申请自动授权的常用 scope）
lark-cli auth login --recommend
#   浏览器授权 → user token 落到 ~/.lark-cli/config.json

# 3. 验证
lark-cli auth status
#   "identities.user.status": "ready" 即可用
```

**凭证位置**：`~/.lark-cli/config.json`（macOS / Linux）/ `%USERPROFILE%\.lark-cli\config.json`（Windows）。Bot 身份无需 user OAuth——user/bot 各自独立。

**DSH 沙箱不传播用户级 env**（Windows 实机验证过），所以 `lark-cli` 必须在宿主机 PATH 里能找到，或通过 `larkBin` 显式指定绝对路径：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 的 unwr-novel 块
larkBin: /usr/local/bin/lark-cli        # macOS / Linux
# 或
larkBin: C:\Users\<你>\AppData\Roaming\npm\lark-cli.cmd   # Windows
```

> 解析优先级：`larkBin` 配置 > `UNWR_LARK_BIN` env > Windows 常见安装路径 > `PATH`。
> 服务器 / 容器无浏览器：`lark-cli auth login --no-wait --json` 取 verification URL 转人工，授权后 `lark-cli auth login --device-code <code>` 完成。
> 多账号：`lark-cli auth login --name <profile>` 创建命名 profile；切换用 `lark-cli config profile set <name>`。

---

## 28 个工具（按意图分组）

| 分组 | 工具 |
|---|---|
| **作品** | `novel_manage_work`（list/create/get/switch） |
| **实体** | `novel_manage_setting` / `novel_manage_character` / `novel_manage_relation` |
| **上下文** | `novel_build_context`（拼 L0/L1/L2/L3 + 题材指引 writingGuide） |
| **章节** | `novel_write_chapter`（含 cast） / `novel_read_chapter`（full/outline/search） / `novel_append_chapter` / `novel_list_scenes` |
| **改稿** | `novel_revise_chapter`（patch/insert_after/expand；按段 / 块 / 块区间） / `novel_get_chapter_history` / `novel_restore_chapter` |
| **记忆** | `novel_update_summary` / `novel_record_character_state` / `novel_record_event` / `novel_upsert_book_summary`（query\|upsert 合一） / `novel_mark_chapter_memories_stale` |
| **一致性** | `novel_run_consistency_check` / `novel_get_semantic_check_pack` / `novel_get_review_focus` |
| **大纲 / 伏笔 / 剧情线 / 分支** | `novel_manage_outline` / `novel_manage_foreshadow` / `novel_manage_plotline` / `novel_manage_branch` |
| **节奏 / 规划** | `novel_calculate` / `novel_breakthrough_planning` / `novel_advance_character_arc` / `novel_record_chapter_tension` |

---

## 7 个子代理

实际 `dsh --profile web --dump-config` 输出（手测）：

| 子代理 | toolFilter.allow | 职责 |
|---|---|---|
| **世界官** | `novel_manage_setting` / `novel_manage_foreshadow` / `novel_manage_plotline` / `novel_manage_character` / `novel_manage_relation` / `novel_read_chapter` / `novel_manage_work` | 设定 / 伏笔 / 剧情线 + 必要时补人物 / 关系 |
| **人物官** | `novel_manage_character` / `novel_manage_relation` / `novel_record_character_state` / `novel_read_chapter` / `novel_manage_work` | 人物 / 关系 + 章末状态快照 |
| **大纲官** | `novel_manage_outline` / `novel_manage_foreshadow` / `novel_manage_plotline` / `novel_record_event` / `novel_build_context` / `novel_read_chapter` / `novel_manage_work` | 大纲 / 伏笔 / 剧情线 规划；可挂事件 |
| **起草官** | `novel_build_context` / `novel_write_chapter` / `novel_append_chapter` / `novel_update_summary` / `novel_record_character_state` / `novel_record_event` / `novel_manage_outline` / `novel_revise_chapter` / `novel_list_scenes` / `novel_read_chapter` / `novel_manage_work` | 写章 + 配套记忆 / 改稿 / 场景 |
| **改稿官** | `novel_revise_chapter` / `novel_list_scenes` / `novel_read_chapter` / `novel_get_chapter_history` / `novel_manage_character` | 微调刚写完的章节；可调人物档案辅助 |
| **评审官** | `novel_run_consistency_check` / `novel_get_semantic_check_pack` / `novel_get_review_focus` / `novel_list_scenes` / `novel_read_chapter` / `novel_get_chapter_history` | 一致性 / 红线评审（只读） |
| **救火官**（卡文救援） | `novel_build_context` / `novel_manage_branch` / `novel_manage_foreshadow` / `novel_manage_character`（仅 query） / `novel_read_chapter` | 写不下去时生成 3+ 条候选分支到 `novel_manage_branch` |

> **主编排官 = DSH 主会话本身**（不单独注册）；它通过 7 个 `novel_agent_*` 委托工具调度子代理。

---

## 文档

- [install.md](docs/guide/install.md) — 完整安装步骤
- [usage.md](docs/guide/usage.md) — 28 工具详细用法 + 编排流程

---

## 隐私红线

仓库中不得出现 `/home/maigi`、个人姓名、真实飞书 `base_token` / `space_id`——已用 `git filter-repo --replace-text` 清理过历史。新增代码默认用占位符（`<TEST_BASE>`、`$UNWR_ROOT`）+ 环境变量注入。

`work-state.json` 落在 `~/.unwr/`（仓库外）。

## 维护者：发布新版本

完整发布链（npm + GitHub Release + git tag），授权从 `GITHUB_TOKEN` 环境变量自动读取：

```bash
# 0. 一次性配置：~/.zshrc 里 export GITHUB_TOKEN=<fine-grained PAT，仅需 repo Contents 读写>
# 1. 同步 bump 根 package.json 与 packages/plugin/package.json 的 version
pnpm pack:plugin        # build + bundle 验证 + 隐私扫描 + dist/laplaceliu-unwr-<ver>.tgz
git add -A && git commit -m "chore(release): v<ver>" && git tag v<ver>
git push origin main v<ver>
npm publish --access public --prefix packages/plugin
pnpm release:github v<ver>            # 创建 GitHub Release + 上传 tgz（幂等）
# 可选：pnpm release:github v<ver> --notes <markdown 文件> 指定/更新 release notes
```

## License

MIT