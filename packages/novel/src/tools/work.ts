/**
 * novel_manage_work —— 作品的发现、创建与配置读写。
 *
 * 这是工具链的入口：所有其他工具都需要 `workToken`，
 * 而 workToken 由本工具的 list 动作提供。
 *
 * @module @unwr/novel/tools/work
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { base, drive } from '@unwr/feishu'
import { WORK_F } from '@unwr/schema'
import {
  createWorkRootFolder, getWorkConfig, listWorks, updateWorkConfig,
} from '../domain/work.ts'
import { ensureWorkSchemaCached, initWork } from '../domain/bootstrap.ts'
import { resolveWorkToken } from './defaults.ts'
import { knownWorks, mergeWorks, rememberWork, rememberWorkToken } from '../domain/work-store.ts'

/** 注册作品管理工具。 */
export function registerWorkTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'novel_manage_work',
    description: 'List available works, create a new one, or read/update its configuration. '
      + 'action="list" returns each work\'s base_token — other tools need it. '
      + 'action="create" builds a brand-new work with all 13 tables ready. '
      + 'get_config returns the resolved genre preset, which tells you the target word count, '
      + 'pacing, POV and hook style to write with.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'get_config', 'update_config', 'link_folder'],
        required: true,
      },
      workToken: {
        type: 'string',
        description: 'Base token. Required for get_config / update_config / link_folder.',
      },

      name: { type: 'string', description: 'Work title. REQUIRED for create; also accepts on update_config.' },
      genre: {
        type: 'string', enum: ['中文网文', '类型小说', '纯文学'],
        description: 'Genre (create / update_config).',
      },
      subgenre: { type: 'string', description: 'Sub-genre, e.g. 玄幻 / 悬疑 (create / update_config).' },
      scale: {
        type: 'string', enum: ['短篇', '中长篇', '长篇连载'],
        description: 'Scale (create / update_config).',
      },
      targetWords: { type: 'number', description: 'Target total word count (create / update_config).' },
      mode: {
        type: 'string', enum: ['协作助手', '全自动', '教练评审', '协作+自动'],
        description: 'Writing mode (create / update_config).',
      },
      pov: {
        type: 'string', enum: ['第一人称', '第三人称限知', '第三人称全知'],
        description: 'Point of view (create / update_config).',
      },
      force: {
        type: 'boolean',
        description: 'link_folder only: recreate the work folder even if the config already '
          + 'has one. Use when the stored folder was deleted from the drive.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          works: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                baseToken: { type: 'string', required: true },
                name: { type: 'string', required: true },
                url: { type: 'string' },
                updatedAt: { type: 'string' },
                // 'search' = 来自飞书搜索；'local' = 来自本机记录
                // （新建作品的索引延迟，或库已不在搜索结果里）
                source: { type: 'string' },
              },
            },
          },
          baseToken: { type: 'string' },
          url: { type: 'string' },
          folderUrl: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          config: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string' },
              genre: { type: 'string' },
              subgenre: { type: 'string' },
              scale: { type: 'string' },
              targetWords: { type: 'number' },
              mode: { type: 'string' },
              pov: { type: 'string' },
              currentChapter: { type: 'number' },
              folderUrl: { type: 'string' },
              recordId: { type: 'string' },
              updated: { type: 'boolean' },
            },
          },
          writingGuide: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const signal = exec.signal

      if (args.action === 'list') {
        const remote = await listWorks({}, signal)
        // 新建作品的飞书搜索索引有分钟级延迟（e2e 已为此时延写过轮询容忍），
        // 而它恰恰是模型最需要找的那一个。用本机记录兜底补全。
        const { works, localOnly } = mergeWorks(remote, knownWorks())
        // 远程结果也记入本机：下次重启后即便索引没命中，也还记得名字与 token
        for (const w of remote) rememberWork(w)
        return {
          action: 'list',
          total: works.length,
          works: works.map((w) => ({
            baseToken: w.baseToken,
            name: w.name === '' ? '(未命名作品)' : w.name,
            ...w.url === undefined ? {} : { url: w.url },
            ...w.updatedAt === undefined ? {} : { updatedAt: w.updatedAt },
            // 明确标注来源：本机记录可能已过期（库被删/权限被撤）
            source: localOnly.some((x) => x.baseToken === w.baseToken) ? 'local' : 'search',
          })),
          ...localOnly.length === 0 ? {} : {
            warnings: [
              `以下 ${localOnly.length} 部作品来自本机记录，飞书搜索索引可能尚未收录：`
                + `${localOnly.map((w) => w.name === '' ? w.baseToken : w.name).join('、')}`,
            ],
          },
        }
      }

      if (args.action === 'create') {
        if (args.name === undefined || args.name === '') {
          throw new Error('create 需要 name（作品名）。')
        }
        // 先建作品文件夹，再把 Base 建进文件夹——
        // 「一本小说的所有资源在一个目录下」的关键步骤（此前漏传
        // folder-token，Base 落在根目录，与文件夹方案的设计目标相悖）
        const workFolder = await createWorkRootFolder(args.name, signal)
        const created = await base.createBase(args.name, { folderToken: workFolder.folderToken }, signal)

        // 建齐 13 张表与关联字段（静态导入即可，无需动态）
        const r = await initWork(created.base_token, signal)

        // 多作品组织：每本小说一个云盘文件夹，Base 与正文都在其中
        // （workFolder 已在上方创建，Base 也建在其中）
        const folderUrl: string | undefined = workFolder.url

        // 元信息 + 根节点**一次性**写入作品表。
        // 拆成两次会各自"查记录→无则创建"，而刚创建的记录有可见性延迟，
        // 第二次查不到就再建一条，导致作品表出现重复记录。
        const meta: Record<string, unknown> = { name: args.name }
        if (args.genre !== undefined) meta.genre = args.genre
        if (args.subgenre !== undefined) meta.subgenre = args.subgenre
        if (args.scale !== undefined) meta.scale = args.scale
        if (args.targetWords !== undefined) meta.targetWords = args.targetWords
        if (args.mode !== undefined) meta.mode = args.mode
        if (args.pov !== undefined) meta.pov = args.pov
        await updateWorkConfig(created.base_token, meta, {
          // 根节点地址不在 patch 类型里，走 extraFields（字段常量见 WORK_F.WIKI_URL）
          ...folderUrl === undefined ? {} : { extraFields: { [WORK_F.FOLDER_URL]: folderUrl } },
        }, signal)

        // 新建的作品立即成为会话默认——后续工具无需再抄 token。
        // 同时写入本机作品注册表：否则 DSH 重启后 list 搜不到它
        // （飞书搜索索引延迟），模型又得靠上下文记忆找回来。
        resolveWorkToken({ workToken: created.base_token })
        rememberWork({
          baseToken: created.base_token,
          name: args.name,
          ...created.url === undefined ? {} : { url: created.url },
        })

        return {
          action: 'create',
          total: 1,
          works: [],
          baseToken: created.base_token,
          ...created.url === undefined ? {} : { url: created.url },
          ...folderUrl === undefined ? {} : { folderUrl },
          // 关联字段创建失败必须暴露——否则后续写入会报晦涩的 not_found
          ...r.failedLinks.length === 0 ? {} : {
            warnings: [`部分关联字段创建失败（可用 init-work 脚本重试补齐）：${r.failedLinks.join(', ')}`],
          },
        }
      }

      // get_config / update_config / link_folder 同样支持会话默认作品：
      // create 成功后即成为默认，后续无需再抄 token（与领域工具一致）
      if (args.workToken === undefined || args.workToken === '') {
        const fallback = resolveWorkToken(args)
        if (fallback === '') throw new Error(`${args.action} 需要 workToken。`)
        args.workToken = fallback
      }

      // 旧库自愈 + token 核验：每个会话的第一个 manage_work 调用会触发
      // 一次 schema 校验（10 分钟缓存），顺带把「token 抄错」拦在入口，
      // 而不是等后面的写入报晦涩的 NOTEXIST。校验失败 = 库不可访问。
      const schemaCheck = await ensureWorkSchemaCached(args.workToken, signal)
      if (!schemaCheck.ok) {
        // token 不可访问时优先列出本机已知作品——list 依赖飞书搜索索引，
        // 新建作品可能搜不到，光说"去 list"解决不了问题
        const known = knownWorks()
          .filter((w) => w.baseToken !== args.workToken)
          .map((w) => `  - ${w.name === '' ? w.baseToken : `${w.name} → ${w.baseToken}`}`)
        throw new Error(
          `作品库 ${args.workToken} 不可访问（token 可能耗错、库被删或权限失效）。`
            + (known.length === 0
              ? '请用 novel_manage_work(action=list) 核对 base_token。'
              : `本机记录里的其他作品：\n${known.join('\n')}`)
            + '\n之后的调用可省略 workToken（自动沿用上次使用的作品）。',
        )
      }
      // 走到这里说明 token 确实可用：记下来，下次重启直接恢复
      rememberWorkToken(args.workToken)
      const schemaWarnings: string[] = []
      if (schemaCheck.createdTables.length > 0) {
        schemaWarnings.push(`已自动补建缺失的数据表：${schemaCheck.createdTables.join(', ')}`)
      }
      if (schemaCheck.createdFields > 0) {
        schemaWarnings.push(
          `已自动补齐作品库缺失字段 ${schemaCheck.createdFields} 个（旧库升级）。`,
        )
      }
      if (schemaCheck.failedLinks.length > 0) {
        schemaWarnings.push(
          `部分关联字段自动补齐失败（稍后重试或用 sync-fields 脚本）：${schemaCheck.failedLinks.join(', ')}`,
        )
      }

      // 为已有作品补挂知识空间（此前创建的作品没有根节点，正文散落根目录）
      if (args.action === 'link_folder') {

        const cfg = await getWorkConfig(args.workToken, signal)
        // 幂等检查不能只看非空：从 wiki 方案迁移来的库，字段里存的可能是
        // 无效的 wiki URL；目录也可能已被用户删除。默认仅在「URL 可解析且
        // 未指定 force」时跳过；写章时检测到目录失效后，模型会用 force 重建。
        if (args.force !== true && drive.extractFolderToken(cfg.folderUrl) !== undefined) {
          return {
            action: 'link_folder',
            total: 1,
            works: [],
            baseToken: args.workToken,
            folderUrl: cfg.folderUrl,
            ...schemaWarnings.length === 0 ? {} : { warnings: schemaWarnings },
            writingGuide: '该作品已挂接知识空间，无需重复挂接。',
          }
        }
        const workName = cfg.name !== '' ? cfg.name : '未命名作品'
        const root = await createWorkRootFolder(workName, signal)
        // 已有作品的配置记录早已存在（无可见性问题），直接更新
        await updateWorkConfig(args.workToken, {}, {
          extraFields: { [WORK_F.FOLDER_URL]: root.url },
        }, signal)
        return {
          action: 'link_folder',
          total: 1,
          works: [],
          baseToken: args.workToken,
          folderUrl: root.url,
        }
      }

      if (args.action === 'get_config') {
        const cfg = await getWorkConfig(args.workToken, signal)
        // 补上名字：之前可能只记住了 token（占位无名），这里学到就写回
        rememberWork({ baseToken: args.workToken, name: cfg.name })
        return {
          action: 'get_config',
          total: 1,
          works: [],
          config: {
            name: cfg.name,
            genre: cfg.genre,
            subgenre: cfg.subgenre,
            scale: cfg.scale,
            targetWords: cfg.targetWords,
            mode: cfg.mode,
            pov: cfg.pov,
            currentChapter: cfg.currentChapter,
            folderUrl: cfg.folderUrl,
          },
          ...schemaWarnings.length === 0 ? {} : { warnings: schemaWarnings },
          writingGuide: renderGuide(cfg.preset),
        }
      }

      // update_config
      const r = await updateWorkConfig(args.workToken, {
        ...args.name === undefined ? {} : { name: args.name },
        ...args.genre === undefined ? {} : { genre: args.genre },
        ...args.subgenre === undefined ? {} : { subgenre: args.subgenre },
        ...args.scale === undefined ? {} : { scale: args.scale },
        ...args.targetWords === undefined ? {} : { targetWords: args.targetWords },
        ...args.mode === undefined ? {} : { mode: args.mode },
        ...args.pov === undefined ? {} : { pov: args.pov },
      }, {}, signal)
      return {
        action: 'update_config',
        total: 1,
        works: [],
        baseToken: args.workToken,
        config: { recordId: r.recordId, updated: r.updated },
        ...schemaWarnings.length === 0 ? {} : { warnings: schemaWarnings },
      }
    },
  }))
}

/** 把题材预设渲染为写作指引（与 context 工具保持一致）。 */
function renderGuide(p: Awaited<ReturnType<typeof getWorkConfig>>['preset']): string {
  return [
    `题材：${p.preset_name}（${p.description ?? ''}）`,
    `目标字数：${p.pacing.target_words_per_chapter} 字／章`,
    `对话约 ${Math.round(p.pacing.dialogue_ratio * 100)}%，描写约 ${Math.round(p.pacing.description_ratio * 100)}%`,
    `情绪刺激密度：每千字 ${p.stimulus.stimulus_density} 个（${p.stimulus.stimulus_types.join('、')}）`,
    p.hook.force_cliffhanger
      ? `章末钩子：强度 ${p.hook.hook_strength}/5，必须留悬念`
      : `章末钩子：强度 ${p.hook.hook_strength}/5，${p.hook.hook_style === 'aftertaste' ? '以余韵收束' : '自然收束'}`,
    `设定自洽严格度 ${p.verisimilitude.worldbuilding_strictness}/5`,
    `视角：${p.narration.pov_person}，${p.narration.pov_switch_allowed ? '允许章内换视角' : '章内禁止换视角'}`,
    `语言：意象密度 ${p.language.imagery_density}/5，心理深度 ${p.language.psychological_depth}/5`,
  ].join('\n')
}
