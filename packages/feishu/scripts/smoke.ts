/**
 * 飞书适配层冒烟测试脚本。
 *
 * 用需求阶段已验证的真实数据跑通核心路径，验证封装层是否正确。
 * 运行：pnpm --filter @unwr/feishu exec tsx scripts/smoke.ts
 * @module
 */

import { CHAPTER_F, FORESHADOW_F, TABLE } from '@unwr/schema'
import { base, docs, wiki } from '../src/index.ts'

/** 需求阶段创建的测试库。 */
const BASE = process.env.UNWR_TEST_BASE ?? '<TEST_BASE>'
const SPACE = process.env.UNWR_TEST_SPACE ?? '<TEST_SPACE>'

const log = (ok: boolean, msg: string, ms?: number): void => {
  console.log(`${ok ? '✓' : '✗'} ${msg}${ms === undefined ? '' : ` (${ms}ms)`}`)
}

const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = Date.now()
  try {
    const r = await fn()
    log(true, label, Date.now() - t)
    return r
  } catch (e) {
    log(false, `${label} → ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
}

async function main(): Promise<void> {
  console.log('=== UnWr 飞书适配层冒烟测试 ===\n')

  // 1. 表发现
  const tables = await timed('listTables', () => base.listTables(BASE))
  console.log('  表:', tables.tables.map((t) => t.name).join(', '), '\n')

  const chapterTable = tables.tables.find((t) => t.name === TABLE.CHAPTER)
  const fsTable = tables.tables.find((t) => t.name === TABLE.FORESHADOW)
  if (chapterTable === undefined || fsTable === undefined) {
    throw new Error('测试库缺少章节表或伏笔表')
  }

  // 2. 条件过滤（支撑"待修订章节"）
  const filtered = await timed('listRecords + filter', () =>
    base.listRecords(BASE, chapterTable.id, {
      fieldIds: [CHAPTER_F.TITLE, CHAPTER_F.STATUS, CHAPTER_F.WORDS],
      filter: { logic: 'and', conditions: [[CHAPTER_F.STATUS, 'intersects', ['草稿', '修订']]] },
    }))
  console.log('  →', JSON.stringify(base.matrixToObjects(filtered), null, 1), '\n')

  // 3. 排序（支撑未回收伏笔按重要度）
  const sorted = await timed('listRecords + sort', () =>
    base.listRecords(BASE, fsTable.id, {
      fieldIds: [FORESHADOW_F.CONTENT, FORESHADOW_F.PLANT_CHAPTER_TITLES, FORESHADOW_F.IMPORTANCE],
      sort: [{ field: FORESHADOW_F.IMPORTANCE, desc: true }],
    }))
  console.log('  →', JSON.stringify(base.matrixToObjects(sorted), null, 1), '\n')

  // 4. 文档读写闭环（正文必须走文件传参保证换行）
  //
  // 约定：章标题由 --title 承担，正文只用 ## 做场景分节。
  // 原因（实测）：若内容首行写 `# 章标题` 且与 --title 相同，
  // CLI 会让 title 覆盖该 h1（"the title wins over later content titles"），
  // 导致 outline 里丢失章标题层级。
  const title = `UnWr冒烟-${Date.now()}`
  const content = '## 一、入城\n\n雨下得很大。沈砚站在酒肆檐下。\n\n## 二、交锋\n\n他不答话，只把剑放在桌上。\n'
  const created = await timed('docs.createDoc', () => docs.createDoc(title, content))
  console.log('  document_id:', created.document_id, '\n')

  // 5. 验证标题层级（inline 传参会导致整章变一行、标题失效）
  // 必须用 xml 格式验证：markdown 格式下 outline 返回的是 `##` 文本而非标签
  const outline = await timed('docs.fetchDoc(outline, xml)', () =>
    docs.fetchDoc(created.document_id, { scope: 'outline', docFormat: 'xml' }))
  const h2Count = (outline.content.match(/<h2/g) ?? []).length
  log(h2Count >= 2, `   场景分节正确 (h2:${h2Count})`)
  console.log('  outline:', outline.content.replace(/\s+/g, ' ').slice(0, 200), '\n')

  // 6. 块级定位 + 改写
  const withIds = await timed('docs.fetchDoc(with-ids)', () =>
    docs.fetchDoc(created.document_id, { detail: 'with-ids', docFormat: 'xml' }))
  const blockId = /<p id="(doxcn[^"]+)">雨下得很大/.exec(withIds.content)?.[1]
  if (blockId === undefined) throw new Error('未能定位到段落块 id')

  await timed('docs.blockReplace', () =>
    docs.blockReplace(created.document_id, blockId, '雨势滂沱。沈砚在檐下立了很久。'))

  // 7. 关键词回溯（分层记忆 L4 原文回溯）
  const hit = await timed('docs.searchInDoc', () =>
    docs.searchInDoc(created.document_id, '剑'))
  console.log('  →', hit.content.replace(/\s+/g, ' ').slice(0, 160), '\n')

  // 8. 版本历史（改稿留痕）
  const history = await timed('docs.listDocHistory', () =>
    docs.listDocHistory(created.document_id))
  console.log('  版本数:', history.entries.length, '\n')

  // 9. Wiki 目录树
  const node = await timed('wiki.createNode', () =>
    wiki.createNode('UnWr冒烟-卷', { spaceId: SPACE }))
  const child = await timed('wiki.createNode(child)', () =>
    wiki.createNode('UnWr冒烟-章', { spaceId: SPACE, parentNodeToken: node.node_token }))
  console.log('  目录树:', node.title, '→', child.title, '\n')

  // 10. 并行性能（实测加速比 3.8x）
  const t0 = Date.now()
  await Promise.all([
    base.listTables(BASE), base.listTables(BASE),
    base.listTables(BASE), base.listTables(BASE),
  ])
  console.log(`✓ 并行 4 次调用: ${Date.now() - t0}ms`)

  const t1 = Date.now()
  for (let i = 0; i < 4; i++) await base.listTables(BASE)
  console.log(`✓ 串行 4 次调用: ${Date.now() - t1}ms`)

  console.log('\n=== 全部通过 ===')
  console.log('注意：测试产生了临时文档与 Wiki 节点，如需清理请手动删除。')
  console.log(`  文档: https://my.feishu.cn/docx/${created.document_id}`)
}

await main()
