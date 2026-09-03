/**
 * 会话级默认作品（带跨重启持久化）。
 *
 * 最佳实践依据（实测）：模型每次调用都要抄 30 位 base_token，
 * 抄写错误是必然率（单会话实测 2 次 NOTEXIST）。
 * 解法：任意工具成功收到 workToken 后自动记住，后续调用可省略；
 * 显式传入则切换默认。显式 > 默认，多作品切换零成本。
 *
 * 持久化（2026-09-03 补）：`lastWorkToken` 是模块级变量，**DSH 一重启就没了**。
 * 而当时的报错偏偏指引模型去调 novel_manage_work(action=list)——新建作品的
 * 飞书搜索索引有分钟级延迟，list 里根本搜不到它，于是模型只能靠上下文记忆
 * 里的 token 反复试（实测绕 3 轮）。现在默认作品落盘（见 domain/work-store.ts），
 * 重启后自动恢复，零调用。
 *
 * @module @unwr/novel/tools/defaults
 */

import { getLastWorkToken, knownWorks, rememberWorkToken } from '../domain/work-store.ts'

let lastWorkToken = ''

/**
 * 解析本次调用应使用的 workToken：
 * 显式传入优先（并更新默认），否则用会话默认；
 * 会话默认缺失时回落到**本机上次使用的作品**（跨重启恢复）。
 *
 * @throws 三者皆无时，把本机已知作品连同 token 一并列出，一次调用即可恢复
 */
export function resolveWorkToken(args: { workToken?: string }): string {
  if (args.workToken !== undefined && args.workToken !== '') {
    lastWorkToken = args.workToken
    rememberWorkToken(args.workToken)
    return args.workToken
  }
  if (lastWorkToken !== '') return lastWorkToken

  const persisted = getLastWorkToken()
  if (persisted !== '') {
    lastWorkToken = persisted
    return persisted
  }

  throw new Error(noWorkTokenHint())
}

/**
 * 无默认作品时的自纠正指引。
 *
 * 关键：把**已知作品的 token 直接列出来**。否则模型只能去调 list，
 * 而新建作品在飞书搜索索引里可能还没出现（分钟级延迟），
 * 于是又绕回「找不到 → 再试」的死循环。
 */
export function noWorkTokenHint(): string {
  const works = knownWorks()
  if (works.length === 0) {
    return '未指定 workToken，且本机没有任何用过的作品记录。'
      + '请先调用 novel_manage_work(action=list) 获取 base_token 并传入。'
  }
  const lines = works.map((w) => {
    const label = w.name === '' ? w.baseToken : `${w.name} → ${w.baseToken}`
    return `  - ${label}`
  })
  return [
    '未指定 workToken。本机记录里有以下作品，挑一个把 base_token 传入即可：',
    ...lines,
    '（也可用 novel_manage_work(action=list) 重新列出；新建作品的飞书搜索索引'
      + '可能延迟几分钟，list 会合并本机记录，但上面这些 token 现在就能用。）',
  ].join('\n')
}
