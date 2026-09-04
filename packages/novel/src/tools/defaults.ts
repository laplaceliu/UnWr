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
 * **回退路径警告**（2026-09-04 补）：**显式 > 模块变量 > 落盘回退**这三层
 * 中，后两层属于「智能体没传 workToken，工具自己猜」。猜对时无感，猜错时
 * 模型会在错作品里写入/读取数据（实测踩坑：写到鸦骨账而不是当前作品）。
 * 现在 `resolveWorkToken` 在「回退」时记录一条 `ResolveInfo`，
 * 工具层在 `execute` 末尾用 `consumeLastResolveInfo()` 拿出来，向模型的
 * result.warnings 注入一条「本次使用默认作品 X（profile=Y），如果当前在写
 * 别的作品请显式传 workToken」——这样模型能在「写入错误作品的章节壳」
 * 之前就看到警示，主动核对。
 *
 * @module @unwr/novel/tools/defaults
 */

import { getCurrentProfile, getLastWorkToken, knownWorks, rememberWorkToken } from '../domain/work-store.ts'

let lastWorkToken = ''

export type ResolveSource = 'explicit' | 'in-memory' | 'persisted'

export interface ResolveInfo {
  token: string
  source: ResolveSource
  /** 落盘来自哪个 DSH profile（仅 source='persisted' 时有值）。 */
  profile?: string
}

let lastResolve: ResolveInfo | undefined

/**
 * 解析本次调用应使用的 workToken：
 * 显式传入优先（并更新默认），否则用会话默认；
 * 会话默认缺失时回落到**本机上次使用的作品**（跨重启恢复）。
 *
 * 同时记录 `lastResolve`，供工具层在 `execute` 末尾读取并向模型发警告。
 * 注意：这里只把 token **返回**给领域调用；只有调用成功后才记住它。
 * 旧的「解析即记住」会在坏 token 上覆盖上次仍有效的作品，导致错误调用
 * 之后所有无参调用继续撞同一个 NOTEXIST。
 *
 * @throws 三者皆无时，把本机已知作品连同 token 一并列出，一次调用即可恢复
 */
export function resolveWorkToken(
  args: { workToken?: string },
  options: { remember?: boolean } = {},
): string {
  if (args.workToken !== undefined && args.workToken !== '') {
    if (options.remember !== false) {
      lastWorkToken = args.workToken
      rememberWorkToken(args.workToken)
    }
    lastResolve = { token: args.workToken, source: 'explicit' }
    return args.workToken
  }
  if (lastWorkToken !== '') {
    lastResolve = { token: lastWorkToken, source: 'in-memory' }
    return lastWorkToken
  }

  const persisted = getLastWorkToken()
  if (persisted !== '') {
    lastWorkToken = persisted
    lastResolve = { token: persisted, source: 'persisted', profile: getCurrentProfile() }
    return persisted
  }

  throw new Error(noWorkTokenHint())
}

/**
 * 读取并清空「最近一次 resolveWorkToken 的解析信息」。
 *
 * 工具层在 `execute` 末尾调一次：如果 `source !== 'explicit'`，
 * 应当在 result.warnings 注入一条自纠正提示，让智能体有机会发现
 * 「工具把请求送到了默认作品而不是当前对话里的那一部」。
 *
 * 取后即清：避免下次 resolve 看到的是上一次的陈旧信息（同一 DSH
 * 进程内多个 tool 共用模块状态，必须按"消费完即清"模式防串）。
 */
export function consumeLastResolveInfo(): ResolveInfo | undefined {
  const info = lastResolve
  lastResolve = undefined
  return info
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

/**
 * 判断异常是否为「作品库不可访问」类错误（NOTEXIST / not_found）。
 *
 * 优先看 FeishuError.kind（feishu 适配层的语义分类，最可靠）；
 * message regex 兜底覆盖未经分类的原始错误。
 * 业务层的「第 N 章不存在」等是普通 Error（中文文案），不会命中。
 */
export function isWorkNotFound(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false
  const value = e as { kind?: unknown; message?: unknown }
  if (value.kind === 'not_found') return true
  return typeof value.message === 'string'
    && /NOTEXIST|目标资源不存在|not.?exist|not.?found|has been deleted|invalid.?base.?token/i
      .test(value.message)
}

/**
 * 「作品库不可访问」的自纠正错误信息。
 *
 * 关键设计（与 noWorkTokenHint 同源）：**直接列出本机已知作品与 token**。
 * 只说「去 novel_manage_work(action=list) 核对」是不够的——新建作品的飞书
 * 搜索索引有分钟级延迟，恰恰最需要找的作品可能不在 list 结果里
 * （2026-09-03 实机教训：错误指引必须自己验证过能走通）。
 *
 * 附带声明「坏 token 未被记住为默认作品」：withWorkToken 只在调用成功后
 * 才记住 token，模型重试无参调用不会撞同一个坏 token（实测的死循环来源）。
 */
export function workNotFoundRecoveryMessage(badToken: string, cause: unknown): string {
  const summary = cause instanceof Error ? cause.message : String(cause)
  const works = knownWorks().filter((w) => w.baseToken !== badToken)
  const lines: string[] = [
    `作品库 ${badToken} 不可访问（${summary}）。`,
    '该 workToken 可能抄错、库已删除或权限失效；它没有被记住为默认作品，之后的调用可放心改用正确 token 重试。',
  ]
  if (works.length === 0) {
    lines.push(
      '本机没有其他作品记录。请用 novel_manage_work(action=list) 核对 base_token'
      + '（新建作品的飞书搜索索引可能有分钟级延迟，稍等重试即可）。',
    )
  } else {
    lines.push('本机记录里的其他作品（从中挑正确的 workToken 显式传入即可恢复）：')
    for (const w of works) {
      const label = w.name === '' ? w.baseToken : `${w.name} → ${w.baseToken}`
      lines.push(`  - ${label}`)
    }
    lines.push(
      '若上面的列表都不是目标作品，再用 novel_manage_work(action=list) 核对'
      + '（新建作品的飞书搜索索引可能有分钟级延迟）。',
    )
  }
  return lines.join('\n')
}

/**
 * 通用 workToken 执行包装——所有把 workToken 传给飞书 domain 调用的工具
 * 都应经由本函数，而不是直接调 resolveWorkToken。
 *
 * 三个语义（2026-09-04 实机 NOTEXIST 排障固化）：
 * 1. **成功才记住**：resolve 时 `remember: false`，run 成功后才写入
 *    会话内存与落盘。旧实现「解析即记住」让模型抄错的坏 token 立刻覆盖
 *    上次仍有效的作品，此后所有无参调用继续撞同一个 NOTEXIST（死循环）。
 * 2. **NOTEXIST 自纠正**：捕获「作品库不可访问」类错误，改抛**列出本机
 *    已知作品与 token** 的错误——模型一次调用即可恢复，不用绕 list。
 * 3. **原始错误保留**：自纠正错误以 `cause` 挂原始异常，日志与上层
 *    instanceof/子串断言不受影响。
 */
export async function withWorkToken<T>(
  args: { workToken?: string },
  run: (baseToken: string, signal: AbortSignal | undefined) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const baseToken = resolveWorkToken(args, { remember: false })
  try {
    const result = await run(baseToken, signal)
    // 成功：显式传入 = 切换默认；回退路径 = 确认可用。两种情况都记住。
    // 必须同时更新会话内存与落盘——只更新落盘的话，内存旧值会挡住
    // persisted 新值（in-memory 优先级更高）。
    lastWorkToken = baseToken
    rememberWorkToken(baseToken)
    return result
  } catch (e) {
    if (isWorkNotFound(e)) {
      throw new Error(workNotFoundRecoveryMessage(baseToken, e), { cause: e })
    }
    throw e
  }
}

/**
 * 把 ResolveInfo 翻译成人话。供工具层在 result.warnings 注入。
 */
export function resolveInfoToWarning(info: ResolveInfo): string {
  if (info.source === 'explicit') {
    // 显式传入：永不注入 warning（避免噪音）。函数留作对称，但工具层应短路。
    return ''
  }
  if (info.source === 'in-memory') {
    return `本次调用未传 workToken，沿用了本会话的默认作品 ${info.token.slice(0, 8)}…。`
      + '如果当前在写另一部作品，请显式传 workToken。'
  }
  // source === 'persisted'
  const profile = info.profile ?? 'default'
  return `本次调用未传 workToken，DSH 进程刚启动，从落盘（profile=${profile}）`
    + `恢复了上次的默认作品 ${info.token.slice(0, 8)}…。`
    + '如果当前在写另一部作品，请显式传 workToken。'
}
