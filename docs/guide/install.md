# 安装指南

## 前置

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | `>=24` | DeepSeek Harness 要求 |
| lark-cli | `>=1.0` | 飞书官方 CLI；`npx @larksuite/cli@latest install` |

DSH 本身不需要单独装——`npx @deepseek-ai/dsh ...` 即可。**DSH 不是全局可执行**，所有命令都必须带 `npx @deepseek-ai/dsh` 前缀。嫌长可以：

```bash
echo "alias dsh='npx @deepseek-ai/dsh'" >> ~/.zshrc && source ~/.zshrc
```

---

## 方式 A：从 npmjs 安装（推荐）

```bash
# 1. 装 lark-cli（官方推荐方式）
npx @larksuite/cli@latest install

# 2. 初始化飞书应用凭证（交互式填 App ID / App Secret，仅一次）
lark-cli config init

# 3. OAuth 登录（浏览器扫码 + --recommend 自动选常用 scope）
lark-cli auth login --recommend

# 4. 启动 DSH（首次会下载 @deepseek-ai/dsh 到 npx 缓存）
npx @deepseek-ai/dsh web
# 默认监听 http://127.0.0.1:3080

# 5. 安装 UnWr 到 web profile（实测：内部是 pnpm add -D 转发）
npx @deepseek-ai/dsh plugin --profile web add @laplaceliu/unwr@latest
# 默认会锁在 ^0.1.0（旧版）——务必带 @latest 或显式 @0.1.3
# 升级到当前已装版本的最新：npx @deepseek-ai/dsh plugin --profile web update @laplaceliu/unwr
# （update 不扩范围；要升 major 仍需 add @<version>）

# 6. 确认 UnWr 已在 web profile 的 bundles（让 cordis.patch.yml 加载）
grep -A 6 '"dsh"' ~/.dsh/profiles/web/package.json
# 应看到 dsh.profile.bundles 含 "@laplaceliu/unwr"

# 7. 重启 DSH（cordis patch 不热重载，必须重启）
npx @deepseek-ai/dsh web
```

打开 http://127.0.0.1:3080 ，主会话里输入 `列出我的作品` 即可验证 UnWr 工具集已加载。

### 验证插件已加载

```bash
npx @deepseek-ai/dsh --profile web --dump-config
# 应看到 unwr-novel + unwr-web 两个插件块，7 个 novel_agent_* 子代理
```

### 自定义端口

```bash
npx @deepseek-ai/dsh web --port 3081
```

---

## 方式 B：从 tarball 安装

```bash
# 下载 tarball：从 https://github.com/laplaceliu/UnWr/releases
# 或从 https://www.dsh.so/zh/artifact/unwr/ 下载

npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh plugin --profile web add ./unwr-0.1.3.tgz
# tarball 安装完默认是 file: 引用（不会自动升版），要升级就 re-add
npx @deepseek-ai/dsh web
```

---

## 方式 C：DSH Desktop（macOS / Windows）

桌面客户端 https://www.dshdesktop.cn/ （仅 macOS + Windows）。

1. 下载并安装 DSH Desktop
2. 启动后在插件市场搜索 **UnWr** → 一键安装
3. 在主对话输入 `列出我的作品` 验证

GitHub：https://github.com/anywhere-labs/dsh-desktop

---

## lark-cli 找不到 / 路径不对

**症状**：DSH 启动后报 `failed to spawn lark-cli: …` 或 `lark-cli not found`。

**原因**：DSH 沙箱不传播用户级 env（Windows 服务化 / 托运行尤其明显），PATH 里的 `lark-cli` 插件进程看不到。

**解决**——任选一种：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 的 unwr-novel 块（推荐，部署级显式）
larkBin: /usr/local/bin/lark-cli
# 或 Windows：
larkBin: C:\Users\<你>\AppData\Roaming\npm\lark-cli.cmd
```

```bash
# 或环境变量（写进 ~/.zshrc / ~/.bashrc）
export UNWR_LARK_BIN="/usr/local/bin/lark-cli"
```

> 解析优先级：`larkBin` 配置 > `UNWR_LARK_BIN` env > Windows 常见安装路径 > `PATH`。

## 服务器 / 无浏览器环境登录

`lark-cli config init` 和 `lark-cli auth login` 默认是交互式（开浏览器 + 扫码）。**服务器上**走设备码：

```bash
# 1. 初始化凭证
lark-cli config init   # App ID / App Secret 可通过环境变量 LARK_APP_ID / LARK_APP_SECRET 传入

# 2. 设备码登录（不阻塞，返回 URL + device_code）
lark-cli auth login --no-wait --device-code
# 把输出的 URL 发给用户；用户浏览器里走完流程

# 3. 用户完成后恢复轮询
lark-cli auth login --device-code <DEVICE_CODE>
```

## 多账号切换

```bash
lark-cli auth list                # 列出已认证用户
lark-cli auth login --domain calendar,task   # 按域授权
lark-cli auth logout              # 登出
```

---

## 端到端验证

启动 DSH 后，在主对话里跑一次完整工作流：

```
1. 列出我的作品                    → novel_manage_work action=list
2. 创建作品（传入飞书 Base token） → novel_manage_work action=create
3. 写第一章                        → novel_agent_drafter + novel_write_chapter
4. 沉淀记忆 + 评审                 → novel_update_summary + novel_agent_critic
```

或用无人值守 profile 跑 headless（实机 2026-09-04 实测通过）：

```bash
# 用 unwr-agent profile（自带 headless overlay + UnWr 插件）
npx @deepseek-ai/dsh --profile unwr-agent "用 novel_manage_work 列出我的所有作品"
# 退出码 0 = 成功；最后一行 stdout 是 UNWR_WORK_BASE=<token>（headless 报告尾行约定）
# 需要 DSH_PERMISSION_MODE=danger-full-access + DSH_TELEMETRY_DISABLED=1
```

---

## 故障排查

| 现象 | 解决 |
|---|---|
| `lark-cli: command not found` | 见 "lark-cli 找不到 / 路径不对" |
| `npx: command not found` | Node 不在 PATH。先 `which node` 验证；nvm 用户跑 `nvm use 24`；apt 用户跑 `sudo apt install nodejs npm` |
| `dsh: command not found` | dsh 不是全局命令，必须用 `npx @deepseek-ai/dsh ...`；嫌长加 alias：`echo "alias dsh='npx @deepseek-ai/dsh'" >> ~/.zshrc && source ~/.zshrc` |
| 工具报 `unknown tool` | 未重启 DSH；改完 bundle 必须 `Ctrl+C` 重启 |
| 启动后看不到 28 工具 | `npx @deepseek-ai/dsh --profile web --dump-config` 看 `unwr-novel` 块；权限问题跑 `lark-cli auth status` |
| `npx` 长时间无响应 | 首次会下载 `@deepseek-ai/dsh` 到 `~/.npm/_npx`，等 30-60s；可用 `npx @deepseek-ai/dsh@<版本>` 锁版本加速 |
| `lark-cli auth status` 显示未登录 | 跑 `lark-cli auth login --recommend`；服务器环境走 `lark-cli auth login --no-wait --device-code` |
| Windows 装 DSH Desktop 失败 | 确认系统 ≥ Windows 10；官方仅支持 macOS + Windows |
| 端口 3080 被占用 | `npx @deepseek-ai/dsh web --port 3081` |

---

## 下一步

- [usage.md](./usage.md) — 28 工具详细用法 + 编排流程