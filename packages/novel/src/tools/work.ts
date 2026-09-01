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
import { base } from '@unwr/feishu'
import { getWorkConfig, listWorks, updateWorkConfig } from '../domain/work.ts'
import { initWork } from '../domain/bootstrap.ts'

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
        enum: ['list', 'create', 'get_config', 'update_config'],
        required: true,
      },
      workToken: {
        type: 'string',
        description: 'Base token. Required for get_config / update_config.',
      },
      name: { type: 'string', description: 'Work title (create / update_config).' },
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
                owner: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
          baseToken: { type: 'string' },
          url: { type: 'string' },
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
        const works = await listWorks({}, signal)
        return { action: 'list', total: works.length, works }
      }

      if (args.action === 'create') {
        if (args.name === undefined || args.name === '') {
          throw new Error('create 需要 name（作品名）。')
        }
        const created = await base.createBase(args.name, {}, signal)

        // 建齐 13 张表与关联字段（静态导入即可，无需动态）
        const r = await initWork(created.base_token, signal)

        // 写入元信息
        const meta: Record<string, unknown> = { name: args.name }
        if (args.genre !== undefined) meta.genre = args.genre
        if (args.subgenre !== undefined) meta.subgenre = args.subgenre
        if (args.scale !== undefined) meta.scale = args.scale
        if (args.targetWords !== undefined) meta.targetWords = args.targetWords
        if (args.mode !== undefined) meta.mode = args.mode
        if (args.pov !== undefined) meta.pov = args.pov
        await updateWorkConfig(created.base_token, meta, signal)

        return {
          action: 'create',
          total: 1,
          works: [],
          baseToken: created.base_token,
          ...created.url === undefined ? {} : { url: created.url },
        }
      }

      if (args.workToken === undefined || args.workToken === '') {
        throw new Error(`${args.action} 需要 workToken。`)
      }

      if (args.action === 'get_config') {
        const cfg = await getWorkConfig(args.workToken, signal)
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
          },
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
      }, signal)
      return {
        action: 'update_config',
        total: 1,
        works: [],
        baseToken: args.workToken,
        config: { recordId: r.recordId, updated: r.updated },
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
