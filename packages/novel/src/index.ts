/**
 * UnWr —— Unlimited Writing.
 *
 * 小说写作 AI 智能体的 DSH 工具插件：25 个 novel_* 领域工具。
 *
 * 多智能体编排（7 个 novel_agent_* 委托工具）**不在这里注册**——
 * 由宿主配置层（profiles/web/cordis.patch.yml，运行时同步到
 * ~/.dsh/profiles/web/cordis.patch.yml）加载官方
 * @deepseek-ai/dsh-tool-subagent 的 7 个实例实现，见该文件。
 * spawn provider 由宿主 dsh-base 内置。
 *
 * 还会向主会话（主编排官）注入一段 system prompt 约定
 * （systemPrompt.section），让主会话也遵守标签纪律与记忆沉淀流程——
 * 它是最高频入口，且直接调工具时不经过任何子代理 persona。
 *
 * 依赖：`inject: ['tools', 'systemPrompt']`。
 * @module @unwr/novel
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerContextTool } from './tools/context.ts'
import { registerChapterTools } from './tools/chapter.ts'
import { registerMemoryTools } from './tools/memory.ts'
import { registerConsistencyTools } from './tools/consistency.ts'
import { registerRevisionTools } from './tools/revision.ts'
import { registerEntityTools } from './tools/entity.ts'
import { registerWorkTools } from './tools/work.ts'
import { registerBreakthroughTools } from './tools/breakthrough.ts'
import { registerCharacterArcTools } from './tools/character-arc.ts'
import { registerTensionTools } from './tools/tension.ts'

export const name = 'unwr-novel'
export const inject = ['tools', 'systemPrompt']

/** 插件配置。 */
export interface Config {
  /** 安全模式：只注册安全工具，不注册任何删除类工具（默认开启） */
  readOnlySafeMode?: boolean
  /** 加载时向 stderr 打印已注册的工具清单，便于确认插件生效（默认关闭） */
  verbose?: boolean
  /** 是否向主会话注入写作约定 system prompt（默认开启） */
  injectSystemPrompt?: boolean
}

/** `ctx.tools.schemas()` 的返回形状（只取我们关心的字段）。 */
interface ToolSchemaLike {
  name?: unknown
}

/** systemPrompt.section 的最小形状（官方 tool-subagent 同款用法）。 */
interface SystemPromptLike {
  section(options: {
    name: string
    order: number
    /** text 可以是函数；组装 prompt 时才调用，context.scope 是当前会话作用域 */
    text: (context: { scope?: unknown }) => string
  }): unknown
}

/** ctx.tools.get 的最小形状（官方 tool-subagent 同款作用域检查）。 */
interface ToolsScopeLike {
  get(toolName: string, scope?: unknown): unknown
}

/**
 * 注入给主编排官（主会话）的写作约定。
 *
 * 为什么放在主会话而不是只有子代理 persona：主会话是最高频入口，
 * 它**直接**调 novel_manage_character 等工具时不会经过任何子代理
 * persona——没有这段，标签纪律就只对委托场景生效。
 *
 * 导出供 orchestration.spec.ts 断言「路由契约」：本约定提到的
 * novel_agent_* 与 cordis.patch.yml 的 toolName 必须一一对应
 * （两处改其一都要同步另一处，见 README「路由契约」）。
 */
export const WRITING_CONVENTIONS = `
## 小说项目写作约定（UnWr）

你正在协助维护一部小说的结构化数据（飞书多维表格 + 云文档）。遵守：

1. **性格标签 / 设定分类纪律**：写入前先 query 已有数据，优先复用贴合的既有标签与分类；
   确实无合适的再创造，新标签与已有风格一致（2-4 字），避免同义碎片
   （已有「沉默寡言」不要再造「寡言」）。系统会自动把新选项合并进字段。
2. **记忆沉淀不可跳过**：用 novel_write_chapter 写完一章后，必须接着
   novel_update_summary（章节摘要）+ novel_record_character_state（出场人物
   章末状态）+ novel_record_event（关键事件）。跳过 = 后续章节失忆。
3. **章节正文结构**：正文用 ## 划分场景，不写 # 一级标题（章标题由系统承担）。
4. **意图 → 角色路由**：复杂写作任务委托给对应的 novel_agent_* 角色子代理；
   先查表再审意图，不确定的按最接近的选。

   | 用户意图 | 委托给 |
   |---|---|
   | 想设定/体系/规则、查设定冲突 | novel_agent_worldkeeper（设定官） |
   | 建/改人物档案、人物立不住、记章末状态 | novel_agent_characterkeeper（人物官） |
   | 列大纲、分卷、伏笔埋收、剧情线 | novel_agent_outliner（大纲官） |
   | 写第 N 章、续写、自动写完本卷 | novel_agent_drafter（起草官） |
   | 改这段、扩写/缩写、换视角·人称·文风 | novel_agent_reviser（改稿官） |
   | 看看有什么问题、评审、诊断 | novel_agent_critic（评审官） |
   | 卡住了、接下来怎么走、要候选分支 | novel_agent_rescuer（救援官） |

   「自动写完本卷」= 先委托大纲官出卷章要点，再逐章委托起草官，每章完成后
   由主会话确认摘要/事件/人物状态已沉淀，然后进入下一章。
   纯数据查询与单条 upsert 直接调工具即可，不必委托。
5. **委托必须自带完整上下文**：子代理是**全新会话，看不到本对话**。委托的
   prompt 里必须写全——作品名或 workToken、章节号、涉及的人物/场景名、
   用户的原始意图与约束（如"冷峻些""保留悬念"）。只写"改一下第三章"
   会让子代理选错作品或章节。
   子代理把大段正文贴回报告里 = 它撞了工具边界，**不要替它代写**：
   代写会丢掉它那一轮已定稿的细节与前后文。正确动作是重新委托，
   在 prompt 里指明它该换用哪个工具（如「这章只有大纲壳，用
   novel_write_chapter 写」）。
6. **角色委托可后台并行**：互不依赖的委托（如设定官+人物官）应放在
   同一条消息里并行发起。
7. **workToken 纪律**：所有工具的 workToken 都**可省略**（自动沿用会话默认
   作品）。30 位 base_token 手抄必错（实测单会话抄错 2 次），只在多作品间
   显式切换时才传入；抄错报 NOTEXIST 时用 novel_manage_work(action=list) 核对。
8. **章节大纲的写入时机**：set_chapter_outline 对不存在的章节会**自动建壳**
   （状态=大纲、标题=第 N 章；传 volume 还会自动建同名卷壳），可以放心
   先批量规划整卷章纲再逐章起草。起草官 novel_write_chapter 写正式正文时
   会复用同一章记录并覆盖状态。
   **章壳不是障碍**：novel_write_chapter 三态通吃——章节号未占用则新建；
   已占用但只有大纲壳（无正文文档）则复用记录建文档并回填；
   已占用且有正文文档才拒绝（那时改用 append/revise）。
   因此 append/revise/read 报「没有正文文档」时，正确动作是**回头用
   novel_write_chapter 写**，不是反复试 append，更不是判定为死锁去问用户。
9. **改稿纪律**：revise 的 patch/replace 失败时，不要反复用猜的 match 重试，
   也**绝不用占位文本（如 X）试探写工具**——会真实写入。先用
   novel_list_scenes 取场景/块结构化定位，再按块 ID 精确修改。
   同理**不要用 bash/echo 做笔记或"探一下工具"**：它既写不进飞书，
   也拿不到任何状态，纯属白烧一轮。要状态就用 novel_manage_* 的 query。
10. **写作模式**：多步写作任务开始前，先用 novel_manage_work(action=get_config)
   确认当前写作模式（config.mode），并按模式调整编排：
   - 协作助手：逐章/逐段推进，每次生成后停下等用户反馈再继续。
   - 全自动：确认目标（题材/设定/字数）后连续编排到底——大纲官出卷章要点 →
     逐章委托起草官 → 每章确认摘要/事件/人物状态已沉淀 → 下一章；
     中途不逐章请示，整卷完成后统一汇报。章与章之间主会话动作保持最小
     （确认沉淀即可，不要重读正文，正文由起草官负责）。
   - 教练评审：只做只读分析。可委托评审官、可查询任何表；**绝不委托起草官或
     改稿官，不写任何正文**，结论以修改建议形式输出。
   - 协作+自动：默认按协作助手行事；用户说「自动写完本章/本卷」时，
     切到全自动流程直到该目标完成。
   - 用户要求切换模式 → novel_manage_work(action=update_config, mode=...)。
11. **显式接管**：用户以 @角色名 开头（如「@改稿官 把这段改冷峻些」）= 跳过
   第 4 条的路由判断，直接把任务交给该角色；用户说「切回自动 / 交还编排」=
   恢复按第 4 条路由。接管不是豁免第 5 条——委托 prompt 仍必须自带
   作品/章节/作用域上下文。
12. **中断恢复**：恢复会话时若收到 "tool call was interrupted … outcome is
   unknown" 的合成错误，按工具语义分流：
   - ask_user_question（纯询问，无副作用）：**立即用相同的问题重新调用**，
     让选择界面重新弹出。若用户最新消息里已经给出答案，直接采纳继续，
     不要重复弹窗。
   - novel_write/revise/manage_* 等有副作用的工具：**不要盲目重试**。先用
     对应读工具核实落库状态（如 novel_read_chapter / novel_list_scenes /
     novel_manage_* 的 query），确认未写入再重做，已写入则跳过。
   - 上述判断只看工具名，不需要追问用户。
13. **内容红线（否决项，优先于以上各条）**：凡涉及正文生成与修改——无论是你
    自己写、还是委托起草官/改稿官/大纲官——都必须遵守平台审核红线。完整清单
    由 novel_build_context 的 writingGuide 与 novel_get_review_focus 的
    checklist 自动下发，你不需要背诵；但你必须：
   - **委托时把红线作为约束一并带上**（第 5 条的「约束」包含它）：子代理是
     全新会话，不会自动继承本约定。
   - **大纲阶段就拦截**：发现卷/章要点、人物设定、世界设定踩线，先按合规改写
     方案调整，再往下走——不要等正文写完了才在评审阶段返工。
   - **红线分三档，处置方式不同**（档位由工具下发，你不必记清单）：
     · **严禁档**（政治/军警/民族历史/涉黄/毒品/未成年人）：呈现即违规，
       无「换个框架就能写」的余地，**必须改掉，不接受权衡**。
     · **高危档**（黑恶/暴力/赌博/宗教/自杀）：内容本身可写，但必须满足强
       约束（反面呈现、只写结果、架空化），**按改写方向改完即可放行**。
     · **审慎档**（真实地名国名/国际关系/抄袭）：技巧规避即可，**仅提示，
       不阻断创作**，由作者判断是否处理。
   - **严禁档与高危档命中即阻断，不与文笔/爽点/一致性权衡**：不可用「但这段
     写得好」为由放行。但**审慎档不要过度反应**——它不是阻断项，别为了它
     推翻已经写好的情节。
`.trim()

export function apply(ctx: Context, config: Config = {}): void {
  // 安全策略：删除类 CLI 命令（table-delete / node-delete / record-delete）
  // 与覆盖式写入（overwrite）一律不注册，避免模型幻觉造成不可逆损失。
  if (config.readOnlySafeMode === false) {
    // 预留：未来若确需删除能力，应在此显式白名单化并配合审批钩子
  }

  registerContextTool(ctx)
  registerChapterTools(ctx)
  registerMemoryTools(ctx)
  registerConsistencyTools(ctx)
  registerRevisionTools(ctx)
  registerEntityTools(ctx)
  registerWorkTools(ctx)
  registerBreakthroughTools(ctx)
  registerCharacterArcTools(ctx)
  registerTensionTools(ctx)

  // 向主会话注入写作约定。
  // text 是惰性函数：DSH 组装 prompt 时才调用。作用域检查用官方同款
  // `ctx.tools.get(name, context.scope)`——工具被卸载/禁用或作用域不含
  // 本插件工具时返回空串，不污染宿主 prompt。
  const systemPrompt = (ctx as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
  if (config.injectSystemPrompt !== false && systemPrompt?.section !== undefined) {
    systemPrompt.section({
      name: 'unwr:writing-conventions',
      // 官方 tool-subagent 用 116.5（委托政策之后）。项目级约定应更早，
      // 取一个不与其冲突的靠前位置。
      order: 50,
      text: (context) =>
        hasToolInScope(ctx, 'novel_build_context', context?.scope) ? WRITING_CONVENTIONS : '',
    })
  } else if (config.injectSystemPrompt !== false) {
    // 宿主缺 systemPrompt 服务（如精简 profile）：降级不注入，
    // 但绝不让整个插件加载失败——20 个工具比约定提示重要得多。
    console.error('[unwr] 宿主无 systemPrompt 服务，跳过写作约定注入')
  }

  if (config.verbose === true) {
    const mine = registeredToolNames(ctx).filter((n) => n.startsWith('novel_'))
    console.error(`[unwr] 插件已加载: ${name}`)
    console.error(`[unwr] 已注册工具 (${mine.length}): ${mine.join(', ')}`)
  }
}

/**
 * 判断某工具在指定作用域是否可用。
 *
 * 与官方 tool-subagent 相同的两段检查：优先 `ctx.tools.get(name, scope)`
 * （作用域感知，是 DSH 的正式机制）；get 不可用时退回 schemas() 快照。
 */
function hasToolInScope(ctx: Context, toolName: string, scope?: unknown): boolean {
  const tools = (ctx as unknown as { tools?: ToolsScopeLike }).tools
  try {
    const got = tools?.get?.(toolName, scope)
    if (got !== undefined) return true
  } catch {
    // get 不可用则退回快照
  }
  return registeredToolNames(ctx).includes(toolName)
}

/**
 * 读取**当前时刻**已注册的工具名。
 *
 * `ctx.tools.schemas()` 是注册表的公开 API。
 * 注意：Cordis 并行加载插件，此处得到的只是本插件加载瞬间的快照，
 * 不代表最终工具集（宿主原生工具可能尚未注册完）。仅用于 verbose 日志。
 */
function registeredToolNames(ctx: Context): string[] {
  try {
    const schemas = (ctx as { tools?: { schemas?(): ToolSchemaLike[] } }).tools?.schemas?.()
    if (!Array.isArray(schemas)) return []
    return schemas
      .map((s) => (typeof s?.name === 'string' ? s.name : ''))
      .filter((n) => n !== '')
  } catch {
    return []
  }
}
