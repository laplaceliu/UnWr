# UnWr × DSH 集成指南

> 如何让 UnWr 插件在 DSH 实例中运行，以及集成过程中实测的坑。
> 配套阅读：`01-tech-selection.md`（架构决策）

---

## 一、两种 DSH 环境

| 环境 | 位置 | 版本 | 能否加载 `.ts` 插件 |
|------|------|------|-------------------|
| **源码版** | 你 clone 的 `deepseek-harness` 目录 | 0.1.2-alpha.3 | ✅ 用 `tsx` 启动即可 |
| **npx 版** | `~/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh` | 0.1.1-rc.2 | ❌ **不含 tsx** |

**关键差异**：npx 版是编译后的 dist，**不含 tsx**，无法直接加载 `.ts` 源码插件。
因此统一方案是**把 UnWr 打包成单文件 JS bundle**，两种环境通用。

---

## 二、构建与挂载

### 1. 构建 bundle

```bash
pnpm build          # 产出 dist/unwr-novel.mjs
pnpm build:watch    # 开发期热重建
```

`external` 保留 `@deepseek-ai/*` 与 `node:*`，由宿主 DSH 提供。

### 2. 挂载到 profile

推荐写入 profile 的用户层 patch（最后应用，不会被 bundle 层覆盖）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: unwr-novel
      name: /absolute/path/to/UnWr/dist/unwr-novel.mjs
      config:
        readOnlySafeMode: true
        verbose: true      # 加载时打印已注册工具清单
```

当前已配置到 `web` profile（即 `dsh web` / 端口 3080 使用的 profile）。

### 3. 重启生效

**改动配置后必须重启 DSH 实例**（`web` profile 未开启 `patchReload: live`）。

---

## 三、集成实测踩坑

### 坑 1：ESM 的模块解析基于「导入者文件位置」

现象：
```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
imported from /home/.../UnWr/dist/unwr-novel.mjs
```

根因：DSH 加载插件时，bare import 的解析**从插件文件自身位置向上查找** `node_modules`，
不是从 DSH 的安装目录。

### 坑 2：pnpm 严格布局导致根 node_modules 缺失

坑 1 的深层原因：`@deepseek-ai/dsh-tools` 装在 `packages/novel/node_modules/` 下，
而 bundle 在 `dist/`，向上查找只看得到**根目录**的 `node_modules`。

**解法**：把 `cordis` / `dsh-tools` 装在**根 package.json**，不要装在子包。

```jsonc
// 根 package.json —— 正确
"dependencies": {
  "@deepseek-ai/cordis": "link:/path/to/dsh/vendor/cordis",
  "@deepseek-ai/dsh-tools": "link:/path/to/dsh/packages/core/tools"
}
```

### 坑 3：ESM 不遵循 `NODE_PATH`

验证 bundle 时试图用 `NODE_PATH=... node script.mjs` 解决依赖解析 —— **无效**。
ESM 完全忽略 `NODE_PATH`（那是 CJS 的机制）。

若要在宿主环境单独验证 bundle，需把 bundle 复制到宿主 `node_modules` 下再 import。

### 坑 4：`tsc -b` 与单项目类型检查

原 `typecheck` 脚本用 `tsc -b`（build mode），但 `tsconfig.json` 是单项目配置，
行为不符预期。改为 `tsc -p tsconfig.json --noEmit`。

---

## 四、验证方法

### 1. 配置层是否被解析

```bash
dsh --profile web --dump-config | grep -A3 unwr
```

应能看到 `unwr-novel` 条目。

### 2. 插件是否真正加载

`verbose: true` 时启动日志会打印：

```
[unwr] 插件已加载: unwr-novel
[unwr] 已注册工具 (1): novel_build_context
```

若插件加载失败，DSH 会**直接崩溃退出**并打印 `plugin tree failed to load`。

### 3. bundle 端到端可用性

```bash
pnpm verify:bundle    # 在宿主环境下 import bundle 并驱动 apply
```

> 注意：`ctx.tools.schemas()` 返回的是**调用那一刻**的快照。
> Cordis 并行加载插件，此处看到的数量不代表最终工具集。

---

## 五、重要发现：DSH 原生支持 subagent

`web` profile 的配置树包含：

- `@deepseek-ai/dsh-tool-subagent-control`
- `@deepseek-ai/dsh-tool-subagent-list-agents`

**这解答了 `01-tech-selection.md` 中的待确认项 T-2**（多智能体实现方式）。

原计划首版用「单一插件 + 提示词切换」（方案 A），因为不确定 DSH 是否有 subagent。
既然原生支持，8 个写作角色（主编排官/设定官/人物官/大纲官/起草官/改稿官/评审官/救援官）
有了更贴合的实现路径：**主编排官作为主 agent，各角色作为 subagent**。

下一步需评估：subagent 之间如何共享「当前作品/章节」上下文，
以及各自的工具子集如何限制（评审官不应有写正文的权限）。

---

## 六、当前状态

| 项 | 状态 |
|----|------|
| bundle 构建 | ✅ `dist/unwr-novel.mjs`（169KB，内联 schema+feishu+novel） |
| npx 版加载 | ✅ 已在 `web` profile 验证，工具成功注册 |
| 端到端调用 | ✅ 真实飞书调用 2.8s 返回数据 |
| 类型检查 | ✅ 零错误 |
| 单元测试 | ✅ 4/4 通过 |

已注册工具：`novel_build_context`（组装分层上下文）
