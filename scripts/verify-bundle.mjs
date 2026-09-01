/**
 * 在宿主 DSH 环境下验证打包后的 bundle 能真正加载并注册工具。
 *
 * 目的：bundle 是 external 依赖 @deepseek-ai/dsh-tools 的，
 * 而 npx 版（0.1.1-rc.2）与源码版（0.1.2-alpha.3）版本不同，
 * 必须在**真实宿主环境**下验证 defineTool 能跑通。
 *
 * 用法：node scripts/verify-bundle.mjs
 * @module
 */

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = resolve(root, 'dist/unwr-novel.mjs')

const mod = await import(pathToFileURL(bundle).href)

console.log('导出 name       :', mod.name)
console.log('导出 inject     :', mod.inject)
console.log('apply 是函数    :', typeof mod.apply === 'function')

// 用最小 fake ctx 驱动，确认注册逻辑在打包后依然正确。
// systemPrompt 是插件注入写作约定的依赖；section 用探针记录调用。
const registered = []
const sections = []
const ctx = {
  tools: {
    register: (t) => registered.push(t),
    // 模拟 DSH 的作用域感知 get（section.text 组装时会调用）
    get: (name) => registered.find((t) => t.name === name),
  },
  systemPrompt: { section: (s) => sections.push(s) },
}

mod.apply(ctx, { readOnlySafeMode: true })

console.log('注册工具数      :', registered.length)
for (const t of registered) {
  console.log('  -', t.name)
  const props = Object.keys(t.parameters?.properties ?? {})
  console.log('    参数:', props.join(', '))
  console.log('    描述:', t.description.slice(0, 70) + '...')
}

if (registered.length === 0) {
  console.error('\n✗ 未注册任何工具')
  process.exit(1)
}
console.log('systemPrompt 注入数:', sections.length)
for (const s of sections) {
  const text = typeof s.text === 'function' ? s.text() : s.text
  console.log('  -', s.name, '| order:', s.order, '| text 长度:', text.length)
}
console.log('\n✓ bundle 在宿主环境下可正常加载并注册工具')
