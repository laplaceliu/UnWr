# UnWr 安装指南

> 本文带你把 UnWr 从零跑起来：装依赖 → 配置飞书 → 构建插件 → 启动 DSH 工作台 → 验证。
> 全程默认布局：`github.com/dsh`（DSH 源码）与 `github.com/<user>/UnWr`（本项目）平级。

---

## 一、前置依赖

| 依赖 | 版本 | 用途 | 验证命令 |
|------|------|------|---------|
| **Node.js** | `^22.19.0` 或 `>=24` | 运行环境（DSH 要求） | `node -v` |
| **pnpm** | `>=11.7.0` | workspace 管理 | `pnpm -v` |
| **lark-cli** | `>=1.0.92` | 飞书 CLI，UnWr 通过它读写飞书 | `lark-cli --version` |
| **Git** | 任意 | 拉源码 | `git --version` |

**DSH**：npx 版（`@deepseek-ai/dsh`）即可；如果你想读 DSH 源码调试，可以 clone 源码版（`deepseek-ai/deepseek-harness`）到 `../dsh`。UnWr 通过 `pnpm link` 把 DSH 的 cordis / dsh-tools 链进根 `node_modules`（不装子包，详见踩坑 1）。

> ⚠️ **隐私红线**：仓内所有配置都用 `__UNWR_ROOT__` 占位符代替绝对路径，由 `scripts/setup-dsh-links.mjs` 在生成实机副本时再替换。不要把你的 home 目录写进任何文件。

---

## 二、拉代码与安装

```bash
# 1. 拉代码（按你实际的目录布局调整）
cd ~/Source/github.com/laplaceliu
git clone <your-fork-url> UnWr
cd UnWr

# 2. 安装依赖（pnpm 会按根 package.json 的 link 路径去 ../dsh 找 DSH 源码）
pnpm install
```

**如果你的 DSH 源码不在 `../dsh`**（比如你 clone 到了 `~/work/dsh`），需要让 pnpm 重新指向：

```bash
pnpm setup:dsh /absolute/path/to/deepseek-harness
# 脚本会重写根 package.json 的 link 路径，并改 ~/.dsh/profiles/*/cordis.local.yml 里的插件路径
# 然后必须重新 install 一次
pnpm install
```

> 提示：`pnpm setup:dsh` **不会**把绝对路径写回 `package.json`——它只会让 link 路径指向你新的 DSH 位置，避免污染仓库。

---

## 三、配置飞书（lark-cli 认证）

UnWr 没有任何飞书凭证；所有读写都委托给 `lark-cli`，由它的本地配置提供。

### 3.1 安装 lark-cli

```bash
# 官方推荐用 npm 全局装
npm install -g @larksuite/cli

# 验证
lark-cli --version   # 应输出 1.0.92 或更新
```

> lark-cli 是 Go 静态二进制（47MB），`package.json` 无 `main`，**只能 spawn**——别尝试 `import 'lark-cli'`，会找不到入口。

### 3.2 完成飞书应用授权

```bash
lark-cli auth login         # 按提示在浏览器完成 OAuth；扫二维码或跳转到飞书 App
lark-cli status             # 显示当前登录身份 + 权限 scope
```

完成后，配置会落在 `~/.lark-cli/config.json`（**仓库外**，不会污染提交）。

### 3.3 验证你能读到的库

```bash
lark-cli drive +search --query "UnWr"
# 期望：返回 0 个或 N 个结果；如果抛权限错，去飞书开发者后台给应用加 scope
```

### 3.4 （可选）指定 lark-cli 路径

如果你的 `lark-cli` 不在 PATH，或者你想固定到某个版本：

```bash
export UNWR_LARK_BIN=/absolute/path/to/lark-cli
# 写到 ~/.zshrc 永久生效
```

---

## 四、准备一个测试作品库（可选但强烈推荐）

UnWr 用飞书多维表格存结构化数据（13 张表：作品/卷/章节/人物/状态/关系/设定/伏笔/事件/剧情线/摘要/记忆索引/检查问题）。
云文档存章节正文。

测试库和真实库在飞书侧**完全隔离**，独立新建一个 base 专门用来跑测试，不会动你的真实作品。

### 4.1 一键建库

```bash
pnpm test:setup-base
```

脚本会：
1. 在飞书创建（或复用）一个名为「UnWr 测试库」的 base；
2. 跑 `initWork` 把 13 张表 + 字段 + link 关联一次建齐；
3. 把 token 写进 `.env.local`（**仓库外**，不入 git）。

输出形如：

```
[setup-test-base] 新建测试 base: XXXXXXXXXXXXXXXX
[setup-test-base] 初始化 13 张表 + 字段 + 关联...
...
[setup-test-base] 已写入 UNWR_TEST_BASE → .../UnWr/.env.local
```

### 4.2 高级选项

```bash
pnpm test:setup-base --recreate                 # 强制重建新 base（旧 base 不会自动删，去飞书 UI 归档）
pnpm test:setup-base --name "我的测试库"         # 自定义库名
pnpm test:setup-base --space=<wiki_space_token> # 登记知识空间（章节正文存放位置）
pnpm test:setup-base --print                    # 只打印当前 token，不做任何操作
pnpm test:setup-base --install-agent-profile    # 安装 headless profile（见 §6）
```

---

## 五、构建 bundle 并挂到 DSH

UnWr 是 DSH 插件，运行时需要单文件 JS bundle（不能直接加载 .ts 源码，因为 npx 版 DSH 不带 tsx）。

### 5.1 构建

```bash
pnpm build           # 产出 dist/unwr-novel.mjs（unified bundle）
pnpm build:watch     # 开发期热重建
```

产物在 `dist/`：

- `unwr-novel.mjs` —— 主插件（含 schema + feishu + novel 三层，~170KB）
- `unwr-web.mjs` —— 工作台插件（SPA + API）

### 5.2 同步配置到 DSH profile

`profiles/web/cordis.patch.yml` 是 canonical 配置（用 `__UNWR_ROOT__` 占位符），由 sync 脚本渲染到实机副本：

```bash
pnpm sync:patch
```

脚本会：
- 读 `profiles/web/cordis.patch.yml` + `cordis.yml` 渲染出 `dist/cordis.local.yml`
- 把 `dist/cordis.local.yml` 同步到 `~/.dsh/profiles/web/` 下的对应文件
- **默认拒绝覆盖**：如果发现实机副本有未在 canonical 里的改动，会提示并让你 diff。改用 `--force` 才能强推。

第一次安装时直接：

```bash
pnpm sync:patch --force
```

> 同步脚本会自动用 `process.env.UNWR_ROOT`（或脚本位置推导的仓库根）替换 `__UNWR_ROOT__` 占位符。如果你把仓库挪到其他位置但忘了设 `UNWR_ROOT`，脚本会用脚本位置推导值，无需改 canonical。

---

## 六、跑通验证

按顺序跑这四步，任一步失败先排查再继续：

### 6.1 类型检查

```bash
pnpm typecheck
# 期望：零输出（tsc --noEmit）
```

### 6.2 单元 + 域级 e2e 测试

```bash
pnpm test
# 默认跳过需要真实飞书 token 的用例（UNWR_TEST_BASE 未设置时自动 skipIf）
# 期望：~320 passed / 68 skipped

pnpm test:e2e       # 需要先跑 pnpm test:setup-base 建好测试库
pnpm test:tools     # 工具体检：38 发探针覆盖 26/26 工具（不走 LLM）
```

### 6.3 bundle 端到端可用性

```bash
pnpm verify:bundle
# 模拟宿主 DSH 环境 import bundle 并驱动 apply，确认插件能正常加载
```

### 6.4 启动 DSH 工作台

```bash
# 方式 A：npx 版（推荐，无需源码）
npx @deepseek-ai/dsh web --profile web

# 方式 B：源码版（需要 DSH 在 ../dsh）
dsh web --profile web
```

启动成功的标志（启动 1-2 秒后）：

```
[unwr] 插件已加载: unwr-novel
[unwr] 插件已加载: unwr-web
[unwr] 已注册工具 (26): novel_build_context, novel_manage_work, ...
```

> ⚠️ **DSH 配置改动后必须重启 DSH 实例**（patch 不热重载）。改完 `cordis.patch.yml` 就 `Ctrl+C` 再起。

工作台地址：**http://127.0.0.1:3080/workbench**

API 在：**http://127.0.0.1:3080/workbench/api/...**（注意 `/workbench/api` 双段前缀，`/api` 是 DSH 保留字）。

---

## 七、（可选）安装智能体验收 profile

如果你想让智能体**无人值守**完成一次小说写作（headless，不开浏览器），需要一个独立的 profile：

```bash
pnpm build                                          # 先确保 dist 最新
node scripts/setup-test-base.mjs --install-agent-profile
npx @deepseek-ai/dsh --profile unwr-agent "<任务>"
# → stdout 末尾打印最终回复，UNWR_WORK_BASE=<token> 写入报告尾行
```

这个 profile 走 dsh-headless（官方 one-shot runner），用 environment 变量禁用 UI 审批：

```bash
DSH_PERMISSION_MODE=danger-full-access
DSH_TELEMETRY_DISABLED=1
```

验收脚本：

```bash
pnpm test:agent
# 端到端跑完整链路（驱动 7 个角色完成一章；实测 ~9 分钟）
```

---

## 八、环境变量速查

| 变量 | 默认 | 说明 |
|------|------|------|
| `UNWR_ROOT` | 脚本位置推导 | 仓库根；cordis.yml 用它定位插件 bundle |
| `UNWR_LARK_BIN` | `lark-cli` | lark-cli 可执行路径 |
| `UNWR_MAX_CONCURRENCY` | `8` | 并发上限；触发飞书限流时降低 |
| `UNWR_TEST_BASE` | — | 测试用 base token；未设置时域级 e2e 自动 skip |
| `UNWR_TEST_SPACE` | — | 测试用知识空间 token；全链路 e2e 跳过开关 |
| `UNWR_DEBUG_SELFHEAL` | `0` | 设 `1` 时打印 selfheal 退避信息（默认仅在末次 warn） |
| `DSH_PERMISSION_MODE` | — | headless 模式下设 `danger-full-access` 跳过 UI 审批 |
| `DSH_TELEMETRY_DISABLED` | — | 设 `1` 关闭遥测 |

---

## 九、安装后自检清单

跑通下面这串命令，输出全部符合预期就算装好了：

```bash
node -v                                          # v22.19+ 或 v24+
pnpm -v                                          # 11.7+
lark-cli --version                               # 1.0.92+
lark-cli status                                  # 已登录 + 有 base:app:readonly 等 scope

cd UnWr
pnpm install                                     # 无 peer 警告
pnpm typecheck                                   # 零输出
pnpm test:setup-base                             # 写 .env.local 一行
pnpm test                                        # 大批 passed
pnpm build && pnpm sync:patch --force            # 产出 dist + 同步到 ~/.dsh
npx @deepseek-ai/dsh web --profile web &         # 启动 ~2 秒
curl -s http://127.0.0.1:3080/workbench/         # 返回 200 + HTML
curl -s http://127.0.0.1:3080/workbench/api/health  # 返回 {"ok":true}
pkill -f "dsh web"                               # 收尾
```

全部通过？去看 [使用指南](./usage.md)。
