/**
 * 一次性运维脚本：对指定作品库执行 schema 自愈（含重名字段修复）。
 *
 * 用法：npx tsx scripts/repair-dup-fields.ts <baseToken>
 *
 * 修复语义（安全保证见 domain/bootstrap.ts repairDuplicateFields）：
 *   多余列改名 __legacy__ → 并集回填保留列 → record-get 验证 → 才删除多余列。
 *   任何一步失败都会停在那里并跳过该组，绝不丢数据。
 *
 * @module
 */

import { ensureWorkSchema } from '../packages/novel/src/domain/bootstrap.ts'

const baseToken = process.argv[2]
if (baseToken === undefined || baseToken === '') {
  console.error('用法: npx tsx scripts/repair-dup-fields.ts <baseToken>')
  process.exit(1)
}

console.log(`对作品库 ${baseToken} 执行 schema 自愈（含重名字段修复）…`)
const r = await ensureWorkSchema(baseToken)
console.log(JSON.stringify(r, null, 2))
