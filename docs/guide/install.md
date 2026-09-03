# 安装指南

把 UnWr 从源码装到能跑通端到端测试，全流程大约 15-20 分钟。

## 1. 前置条件

| 工具 | 版本要求 | 备注 |
|---|---|---|
| Node.js | `^22.19.0` 或 `>=24` | `package.json` 的 `engines` 字段 |
| pnpm | `>=11.7.0` | 已写在 `packageManager` |
| DSH 源码 | 最新 | 必装，DSH 未发布到 npm。clone 到 `../dsh/`（与 `UnWr/` 同级在 `github.com/` 下） |
| lark-cli | `>=1.0` | 飞书官方 CLI，全局安装一次 |

**安装命令：**

```bash
# DSH 源码（必装；DSH 不发 npm，必须本地 clone）
git clone https://github.com/deepseek-ai/deepseek-harness.git ../dsh

# lark-cli（一次，全局）
npm i -g @larksuite/cli

# 验证
node --version         # 22.19+ / 24+
pnpm --version         # 11.7+
lark-cli --version
ls ../dsh/packages/subagent/tool-subagent   # 应存在
```

---

## 2. 克隆与安装

```bash
git clone https://github.com/<your-org>/UnWr.git
cd UnWr
pnpm install
```

`pnpm install` 会自动：
- 安装 4 个本地包（`schema` / `feishu` / `novel` / `web`）的 workspace 链接
- 把 DSH 依赖通过相对路径 `link:../../dsh/...` 链上
- **触发 `scripts/setup-dsh-links.mjs`**：检测 DSH 源码是否在 `../dsh/`，不在则提示重定向

> **DSH 依赖必须装在仓库根**——`pnpm` 严格布局下 `dist/unwr-novel.mjs` 向上查找 `node_modules` 只会看到根目录；装在 `packages/novel/` 下宿主 DSH 加载插件时直接 `ERR_MODULE_NOT_FOUND`（已实测）。

### DSH 源码不在默认位置？

```bash
# 例：DSH 在 /opt/dsh
pnpm setup:dsh
# 按提示输入 DSH 绝对路径（重写 package.json 的 link 目标，不写回 git）
```

---

## 3. 配置 lark-cli 认证

DSH 插件通过 `lark-cli` 与飞书交互，需要一次 OAuth 登录：

```bash
lark-cli login
# 按提示在浏览器完成授权；token 写到 ~/.lark-cli/config.json
```

> **DSH 沙箱不传播用户级 env**（Windows 实机 2026-09-03 确认）——所以 `lark-cli` 必须在宿主机 PATH 里能找到，或者显式设置 `UNWR_LARK_BIN=<绝对路径>`。

---

## 4. 配置环境变量

把以下写进 `~/.zshrc` / `~/.bashrc`（或 `~/.zshenv` / `~/.bashenv`，让非交互 shell 也能读到）：

```bash
# 必填：UnWr 仓库绝对路径（cordis.yml 用 !!js process.env.UNWR_ROOT 拼插件绝对路径）
export UNWR_ROOT="$HOME/Source/github.com/<your-org>/UnWr"

# 必填（e2e 时）：测试用飞书 Base token；先跑 pnpm test:setup-base 拿到再回填
export UNWR_TEST_BASE="<TEST_BASE>"

# 可选：lark-cli 绝对路径（DSH 沙箱不传播 env 时用）
# export UNWR_LARK_BIN="/usr/local/bin/lark-cli"

# 可选：调试 selfheal 退避过程
# export UNWR_DEBUG_SELFHEAL=1

# 可选：覆盖作品注册表路径（默认 ~/.unwr/work-state.json）
# export UNWR_STATE_FILE="/tmp/unwr-test-state.json"

# DSH headless（无人值守 e2e）必填
export DSH_PERMISSION_MODE="danger-full-access"
export DSH_TELEMETRY_DISABLED="1"
```

加载后验证：

```bash
source ~/.zshrc
echo "$UNWR_ROOT"      # 必须是绝对路径，且与 $PWD 一致
which lark-cli
```

> **PATH 撑爆警告**：每次新 shell `source ~/.zshrc` 都可能让 `PATH` 越来越长（zshrc 末尾的多条 `export PATH=...$PATH:...`）。如果 `echo $PATH` 返回 800+ 字符且简单 `echo hi` 还正常——是 PATH 撑爆，工具链没坏。一次性修复：在 zshrc 末尾加
> ```bash
> PATH=$(printf '%s' "$PATH" | tr ':' '\n' | awk '!seen[$0]++' | paste -sd: -); export PATH
> ```

---

## 5. 构建插件

```bash
pnpm build            # esbuild 出 dist/unwr-novel.mjs + dist/unwr-web.mjs
pnpm verify:bundle    # 校验 dist 产物 + 插件可见性
```

预期：`dist/` 下两个 `.mjs`，`verify:bundle` 全部 `OK`。

---

## 6. 同步到 DSH profile

DSH 通过 `~/.dsh/profiles/<profile>/cordis.patch.yml` 加载插件：

```bash
pnpm sync:patch
# 默认同步到 ~/.dsh/profiles/web/cordis.patch.yml
```

`profiles/web/cordis.patch.yml` 里 `!!js process.env.UNWR_ROOT` 拼出插件绝对路径。**`sync:patch` 默认拒绝覆盖**：发现实机副本与 canonical 不同时会 diff 并暂停——这通常是历史 workaround 的副作用（例：实机副本缺 `unwr-web` 块是因为有人手摘过它），先搞清再 `--force`。

确认已生效：

```bash
ls -la ~/.dsh/profiles/web/cordis.patch.yml
npx @deepseek-ai/dsh --profile web --dump-config   # 看插件树（不起服务）
```

应能看到 `unwr-novel` + `unwr-web` 两个插件块，以及 7 个 `novel_agent_*` 子代理。

---

## 7. 启动 DSH

### 方式 A：DSH web 模式（人值守）

```bash
timeout 25 npx @deepseek-ai/dsh web   # exit 124 = 存活过加载期
```

实机部署：

```bash
npx @deepseek-ai/dsh web &   # 后台
# 等 3-5 秒，curl 验证
curl -s http://127.0.0.1:3080/health
# 停止
pkill -f "dsh web"
```

> 当前仓库的 `unwr-web` 插件**只提供 API 路由与静态壳**——前端 UI 工作台暂未启用也不在用。一切交互通过 DSH 主会话与工具调用完成。

### 方式 B：DSH headless（无人值守 e2e）

```bash
# 一次性：装好无人值守 profile（带 unwr-agent 角色 + headless overlay）
node scripts/setup-test-base.mjs --install-agent-profile
# 产物在 ~/.dsh/profiles/unwr-agent/

# 跑测试任务
npx @deepseek-ai/dsh --profile unwr-agent "<任务描述>"
```

> `unwr-agent` profile 是 `web/cordis.patch.yml` + `agent/headless-overlay.yml` 叠加；overlay 禁用 `user-questions`、覆盖 persona，最后一行 stdout 是 `UNWR_WORK_BASE=<token>`（供 agent-verify 验收脚本解析）。

---

## 8. 验证

### 工具探针（无需真飞书）

```bash
pnpm test:tools
```

预期：38 发探针覆盖 28/28 工具，逐项 `✓`；尾部 `JSON 汇总` 列出每个工具的实测参数坑（如某工具 `--limit` 上限、某字段枚举值等）。

### 创建测试 Base（一次性）

```bash
pnpm test:setup-base
# 输出: UNWR_TEST_BASE=<token>  UNWR_WORK_URL=https://...
```

把输出的 `UNWR_TEST_BASE` 写进 `~/.zshrc`（见 §4）。

> **Base 有时效**——新建的 bitable 在飞书搜索索引里有分钟级延迟，刚建的作品 `novel_manage_work action=list` 可能搜不到；插件用 `~/.unwr/work-state.json` 跨进程持久化兜底（搜索不到时本地独有条目标 `source: 'local'` + warnings）。

### 端到端（领域 + 错误分支）

```bash
pnpm test:e2e       # 需 UNWR_TEST_BASE；跳过未设置的 it.skipIf
```

### 全链路编排（DSH headless 跑完整写一部短篇）

```bash
pnpm test:agent
# 564s（按 2026-09-02 实测）；无需 playwright
```

预期：报告尾行 `UNWR_WORK_BASE=<token>`；`packages/novel/scripts/agent-verify.ts` 落库验收——验证人物状态 / 事件 / 伏笔等关键记录是否真实入库（不轻信模型自报）。

---

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| `pnpm install` 报 `ERR_MODULE_NOT_FOUND` 找不到 `@deepseek-ai/cordis` | DSH 源码不在 `../dsh/`；跑 `pnpm setup:dsh` 重定向 |
| `pnpm test:setup-base` 报 `lark-cli: command not found` | `lark-cli` 不在 PATH；设 `UNWR_LARK_BIN` 显式指定绝对路径 |
| `pnpm sync:patch` 报"拒绝覆盖" | 实机副本与 canonical 不同；先 diff，搞清原因再 `--force` |
| `pnpm test:agent` 报 `DSH_PERMISSION_MODE not set` | 漏设环境变量；headless 模式必填 `danger-full-access` |
| `npx dsh web` 启动崩溃 `cannot get property "webServer" without inject` | 罕见（web plugin 已修）；重启 DSH 进程即可 |
| 工具报 `unknown tool` | 检查 `cordis.patch.yml` 里 `toolFilter.allow` 是否包含该工具名；DSH 进程是否已重启 |
| 字数 / 排版错误的提示 | `pnpm typecheck` 强类型；`pnpm test` 看 vitest 回归 |
| PATH 撑爆 (`参数列表过长`) | 见 §4 PATH 撑爆警告 |
| 启动时出现大量 "章节表 link 回填未落库……退避重试 1/3……" | 飞书 link 列写入延迟的正常现象（selfheal 自动退避）；非错误 |

---

## 下一步

- 看 [usage.md](./usage.md) 了解如何用 28 个工具 + 7 个子代理组织一次完整的写章工作流
- 看 [`../requirements/`](../requirements/) 了解数据模型 / 智能体矩阵 / 题材预设 / 记忆与一致性 的设计原理
- 看 [`../tech/`](../tech/) 了解关键技术决策（spawn lark-cli 而非 SDK、cordis 链接、plugin-inject 契约等）