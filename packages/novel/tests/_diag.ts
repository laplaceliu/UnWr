/**
 * 临时诊断：打印新库各表 record-list 的原始错误 message。用完即删。
 * @module
 */
import { base } from '@unwr/feishu'

// 用最近一次 e2e 创建的库（从 e2e 日志拿到的 latest；脚本输出 token 以便核对）
import { listWorks } from '../src/domain/work.ts'
const works = await listWorks({ pageSize: 20 })
const newest = works.filter((w) => w.name.includes('[e2e]')).at(-1)
console.log('诊断库:', newest?.name, newest?.baseToken)
const B = newest?.baseToken ?? ''

for (const t of ['章节表', '伏笔表', '人物表', '作品表']) {
  try {
    const m = await base.listRecords(B, t, { fieldIds: [], limit: 1 })
    console.log(`✓ ${t}: ${m.data.length} 行`)
  } catch (e) {
    console.log(`✗ ${t}:`, e instanceof Error ? e.message : String(e))
  }
}
// 再试带 fieldIds 的（e2e 实际用法）
try {
  await base.listRecords(B, '章节表', { fieldIds: ['章节号'], limit: 5 })
  console.log('✓ 章节表+章节号 投影')
} catch (e) {
  console.log('✗ 章节表+章节号:', e instanceof Error ? e.message : String(e))
}
