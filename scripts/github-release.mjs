/**
 * 创建/更新 GitHub Release 并上传 tgz 附件 —— 发布流程最后一步。
 *
 * 授权：从环境变量 GITHUB_TOKEN 读取（~/.zshrc 已配置 fine-grained PAT，
 * 仅需 repo 的 Contents: read/write 权限）。token 缺失或失效时报可读错误，
 * 绝不把 token 写进任何文件或回显。
 *
 * 前置：tag 已存在（git tag + push 之后）；tgz 已打包
 *   pnpm pack:plugin && git tag vX.Y.Z && git push origin main vX.Y.Z
 *
 * 用法：
 *   node scripts/github-release.mjs <tag> [--notes <markdown 文件>]
 *   pnpm release:github v0.1.7
 *
 * 幂等：release 已存在则跳过创建；同名附件已存在则跳过上传。
 * notes 缺省时生成安装模板骨架（变更段落需手工补充，可用 GitHub 网页编辑）。
 *
 * @module
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'laplaceliu/UnWr'

function fail(msg) {
  console.error('✗ ' + msg)
  process.exit(1)
}

// ─── 参数解析 ────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const tag = args.find((a) => !a.startsWith('--'))
const notesIdx = args.indexOf('--notes')
const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : undefined
if (tag === undefined || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  fail('用法: node scripts/github-release.mjs <tag> [--notes <markdown 文件>]（tag 形如 v0.1.6）')
}

// ─── token（只从 env 读，缺失/失效给可读错误） ──────────────────────
const token = process.env.GITHUB_TOKEN
if (token === undefined || token === '') {
  fail('GITHUB_TOKEN 未设置。请在 ~/.zshrc 配置（见仓库 README 发布章节），或临时 export 后重试。')
}

// ─── 版本一致性 + tgz 定位 ──────────────────────────────────────────
const version = tag.slice(1)
const pluginPkg = JSON.parse(readFileSync(resolve(root, 'packages/plugin/package.json'), 'utf8'))
if (pluginPkg.version !== version) {
  fail(`tag ${tag} 与 packages/plugin/package.json 版本 ${pluginPkg.version} 不一致——先同步 bump 再发布。`)
}
const tgz = resolve(root, 'dist', `laplaceliu-unwr-${version}.tgz`)
if (!existsSync(tgz)) {
  fail(`未找到 ${tgz}——先跑 pnpm pack:plugin。`)
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...opts.headers,
    },
  })
  const text = await res.text()
  const data = text !== '' ? JSON.parse(text) : {}
  if (!res.ok) {
    if (res.status === 401) fail('GITHUB_TOKEN 无效（401）——请到 GitHub Settings 更新 ~/.zshrc 中的 token。')
    if (res.status === 403) fail(`GITHUB_TOKEN 权限不足（403）：${text.slice(0, 200)}`)
    const err = new Error(`${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return data
}

// ─── release notes ──────────────────────────────────────────────────
function defaultBody() {
  return `# UnWr ${tag}

小说写作 AI 智能体 · DeepSeek Harness 组合包（bundle）。

## 安装 / 升级

\`\`\`bash
# npm 通道（推荐）
npx @deepseek-ai/dsh plugin --profile web add @laplaceliu/unwr@${version}
# 升级已有安装：
npx @deepseek-ai/dsh plugin --profile web update @laplaceliu/unwr

# tarball 通道：下载本页 Assets 中的 laplaceliu-unwr-${version}.tgz
npx @deepseek-ai/dsh plugin --profile web add ./laplaceliu-unwr-${version}.tgz

# 启动（cordis patch 不热重载，配置变更后必须重启）
npx @deepseek-ai/dsh web

# 验证版本（health 返回 {"ok":true,"version":"${version}"} 即新包生效）
curl http://127.0.0.1:3080/workbench/api/health
\`\`\`

<!-- TODO: 在此补充「自上一版本以来的变更」。可用 GitHub 网页编辑本 release，或 PATCH API。 -->

## 前置依赖
- [lark-cli](https://github.com/larksuite/cli) 已安装并完成 \`auth login\`（见 README）

## SHA 校验
\`npm view @laplaceliu/unwr@${version} dist.integrity\` 可交叉验证本页 Assets 的 tarball。`
}

const body = notesFile !== undefined
  ? readFileSync(resolve(root, notesFile), 'utf8')
  : defaultBody()

// ─── 创建 release（幂等） ───────────────────────────────────────────
let release
let createdHere = false
try {
  release = await api(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
  console.log(`= ${tag} release 已存在（id=${release.id}），跳过创建`)
} catch (e) {
  if (e.status !== 404) throw e
  release = await api(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: `${tag} — 无限写作 UnWr`, body, draft: false, prerelease: false }),
  })
  createdHere = true
  console.log(`✓ ${tag} release 创建（id=${release.id}）`)
}

// notes 更新通道：--notes 指定且 release 非本次创建（创建时 body 已带上）
if (notesFile !== undefined && !createdHere) {
  await api(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  console.log(`✓ release notes 已更新（来自 ${notesFile}）`)
}

// ─── 上传附件（幂等） ───────────────────────────────────────────────
const assetName = `laplaceliu-unwr-${version}.tgz`
const fresh = await api(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`)
if (fresh.assets.some((a) => a.name === assetName)) {
  console.log(`= ${assetName} 附件已存在，跳过`)
} else {
  const data = readFileSync(tgz)
  const up = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${fresh.id}/assets?name=${assetName}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
      },
      body: data,
    },
  )
  if (!up.ok) fail(`附件上传失败 ${up.status}: ${(await up.text()).slice(0, 300)}`)
  console.log(`✓ ${assetName} 已上传（${Math.round(data.length / 1024)} KiB）`)
}

console.log(`\n✓ 完成：https://github.com/${REPO}/releases/tag/${tag}`)
