/**
 * 会话级默认作品。
 *
 * 最佳实践依据（实测）：模型每次调用都要抄 30 位 base_token，
 * 抄写错误是必然率（单会话实测 2 次 NOTEXIST）。
 * 解法：任意工具成功收到 workToken 后自动记住，后续调用可省略；
 * 显式传入则切换默认。显式 > 默认，多作品切换零成本。
 *
 * @module @unwr/novel/tools/defaults
 */

let lastWorkToken = ''

/**
 * 解析本次调用应使用的 workToken：
 * 显式传入优先（并更新默认），否则用会话默认。
 *
 * @throws 两者皆无时给出可自我纠正的指引
 */
export function resolveWorkToken(args: { workToken?: string }): string {
  if (args.workToken !== undefined && args.workToken !== '') {
    lastWorkToken = args.workToken
    return args.workToken
  }
  if (lastWorkToken !== '') return lastWorkToken
  throw new Error(
    '未指定 workToken，且本会话尚未用过任何作品。'
    + '请先调用 novel_manage_work(action=list) 获取 base_token 并传入。',
  )
}
