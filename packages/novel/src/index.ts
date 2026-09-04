/**
 * UnWr —— Unlimited Writing.
 *
 * 小说写作 AI 智能体的 DSH 工具插件：25 个 novel_* 领域工具。
 *
 * 多智能体编排（7 个 novel_agent_* 委托工具）**不在这里注册**——
 * 由宿主配置层（profiles/web/cordis.patch.yml——发布为 @laplaceliu/unwr
 * 组合包自带 patch，随包安装进 profile）加载官方
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
import { configureLark, resolveLarkBinDetailed } from '@unwr/feishu'
import { registerWorkTools } from './tools/work.ts'
import { registerCalculateTools } from './tools/calculate.ts'
import { registerBreakthroughTools } from './tools/breakthrough.ts'
import { registerCharacterArcTools } from './tools/character-arc.ts'
import { registerTensionTools } from './tools/tension.ts'
import { registerArgumentGuard } from './plugins/argument-guard.ts'
import { registerWorkContextInjector } from './plugins/work-context-injector.ts'
import { readBundleVersion } from '../../web/src/version.ts'

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
  /**
   * lark-cli 可执行文件路径。写进 profile patch 的显式声明，随部署走、
   * 可 --dump-config 检查——DSH 沙箱不传播用户级 env（Windows 实机 2026-09-03）
   * 时用这个，别依赖 UNWR_LARK_BIN。留空则走 env → Windows 常见安装位置
   * （npm/pnpm/yarn 全局 bin）→ PATH 的自动解析。
   */
  larkBin?: string
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
   章末状态）+ novel_record_event（关键事件）；本章引入了**新人物**或出现
   **新关系/关系转变**时，还要当场 novel_manage_character / novel_manage_relation
   落库（novel_write_chapter 返回的 nextHint 有完整清单，起草官 persona 同款）。
   跳过 = 后续章节失忆、人物与关系对不上。
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
   由主会话确认摘要/事件/人物状态/新人物与关系已沉淀（以 novel_write_chapter
   返回的 nextHint 清单为准），然后进入下一章。
   纯数据查询与单条 upsert 直接调工具即可，不必委托。

   委托范围纪律（实机踩坑 2026-09-02）：
   - 需要**删减/改写已有正文**（用户点名改段落、缩写、砍戏）→ 委托改稿官；
     起草官只对"本章刚写的"内容做自助微调
   - 不要把「检查人物/关系/剧情线/伏笔表」这类跨域核对塞进设定官的委托里——
     各表核对分别委托对应角色；跨表冲突诊断委托评审官
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
7. **workToken 纪律**：
   - **强烈推荐**显式传 workToken（方向 1，2026-09-04 实机补）：虽然工具
     支持省略（自动回退到默认作品），但**回退 = 猜**。猜对时无感，猜错时
     会把数据写到别的作品（鸦骨账就是这条的受害者）。所有**写工具**
     （set_chapter_outline / upsert_* / delete_chapter_outline /
     novel_write_chapter / novel_update_summary 等）必须传 workToken；
     读工具可省略。
   - 抄 30 位 base_token 必错（实测 2 次 NOTEXIST）。不在多作品间切换时，
     第一次**正确**传入即可；之后会话内沿用同 token，写工具仍要传，**只是
     复制粘贴成本换可靠**。抄错报 NOTEXIST 时用 novel_manage_work(action=list)
     核对。
   - **写工具回退警告必须当真**（2026-09-04 实机踩坑追加）：当**写工具**的
     args 没传 workToken 时，工具会用默认作品，**返回值里会带一条 warnings**
     告知「本次使用了默认作品 X（profile=Y），如果当前在写另一部请显式传
     workToken」。看到这条警告就要停下问自己：返回的数据/写入的目标是不是
     用户当前对话里的那部？答不上来就不要继续——直接补传 workToken 再重试。
     **这是防止"把鸦骨账的大纲写进当前作品"这类跨作品污染的关键防线**。
   - **DSH profile 隔离**（同次踩坑追加）：每个 DSH profile 维护各自的
     「lastWorkToken」落盘（~/.unwr/<profile>/work-state.json）。同时跑
     unwr-agent 写 workA 和 unwr-web 写 workB 时，profile 隔离保证两者
     不会因为「上次用过的作品」而互窜。
   - **子代理 workToken 继承**（方向 3，2026-09-04 补）：委托 novel_agent_*
     时，**插件会自动在 prompt 头部注入 [工作上下文 workToken=xxx workName=xxx]**——
     子代理应当从这里提取 workToken，**每个**对 novel_* 的调用都显式传
     进去（不要省，详见子代理 persona）。子代理若想脱离主会话改写不同作品，
     应**在主会话层面**先建好新作品的 base_token，再委托时一并告知。
8. **章节大纲的写入时机**：set_chapter_outline 对不存在的章节会**自动建壳**
   （状态=大纲、标题=第 N 章；传 volume 还会自动建同名卷壳），可以放心
   先批量规划整卷章纲再逐章起草。起草官 novel_write_chapter 写正式正文时
   会复用同一章记录并覆盖状态。
   **章壳不是障碍**：novel_write_chapter 三态通吃——章节号未占用则新建；
   已占用但只有大纲壳（无正文文档）则复用记录建文档并回填；
   已占用且有正文文档才拒绝（那时改用 append/revise）。
   因此 append/revise/read 报「没有正文文档」时，正确动作是**回头用
   novel_write_chapter 写**，不是反复试 append，更不是判定为死锁去问用户。
   **章壳的清理**（2026-09-04 补）：发现章节表里有错误条目（误写入/编号错乱
   的空壳）时，用 \`novel_manage_outline(action="delete_chapter_outline",
   chapterNo=N)\` 硬删除。**保护**：若该章节已有正文（docx 或字数>0）默认拒绝，
   防止误删留下孤儿 docx；需要强行删时传 \`force=true\`，但要自己负责清理
   docx。**写注释占位（"已清理"）不是修复**——留一行的章节壳仍占着
   chapterNo，下次想用同号就冲突。
9. **改稿纪律**（这是最常见的卡死循环源头——务必先读完再动手）：
   - **同一场戏准备做 ≥3 处编辑就停下来**：先用 action="replace" +
     scene + startParagraph/endParagraph 一次性重写整段（一次 CLI 往返即可完成
     多段合一），远比逐段 patch+delete+replace 稳。逐段改的代价是 blockId
     反复失效、心智开销指数增长——agent 自己撞到时往往会写"意识到这种
     逐块删除的过程会非常漫长且脆弱"。这条逃生通道正是为此存在。
   - revise 的 patch/replace 失败时，不要反复用猜的 match 重试，也**绝不用
     占位文本（如 X）试探写工具**——会真实写入。先用 novel_list_scenes 取
     场景/块结构化定位，再按块 ID 精确修改；或直接换到上条的多段合一方案。
   - 同理**不要用 bash/echo 做笔记或"探一下工具"**：它既写不进飞书，
     也拿不到任何状态，纯属白烧一轮。要状态就用 novel_manage_* 的 query。
   - 改坏了不要慌：每次改稿在飞书都留了版本，可用 novel_get_chapter_history
     查历史，再用 novel_restore_chapter 回滚到任一历史版本（这是安全网，
     让你敢放心试；多步 patch 越改越差时就停下回滚，不要继续试）。
10. **写作模式**：多步写作任务开始前，先用 novel_manage_work(action=get_config)
   确认当前写作模式（config.mode），并按模式调整编排：
   - 协作助手：逐章/逐段推进，每次生成后停下等用户反馈再继续。
   - 全自动：确认目标（题材/设定/字数）后连续编排到底——大纲官出卷章要点 →
     逐章委托起草官 → 每章确认摘要/事件/人物状态/新人物与关系已沉淀 → 下一章；
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
14. **算术规则**（实机踩坑 2026-09-03：模型直算多步四则不可靠）：
   - 凡写到「共/合计/总计/差值/应到/实到/欠/单价×数量」等数字结论，**落笔前必须先调 novel_calculate**。模型把中文翻成 JS 算式（结构映射，擅长），工具负责求值（纯算术，稳定）。
   - 拿到 result 后**整段照抄**到正文，禁止自己心算覆盖（"4×100+2×50 我心算也是 500 吧"——错就错在这里）。steps 字段可一并抄入正文做演算展示。
   - 算式只接受 + - * / % ( ) 与 Math 子集（floor/ceil/abs/round/min/max/pow/sqrt/log）。不要传变量、字符串、对象、Function。
   - 例：「四张一百铢，二张五十铢」→ novel_calculate({ expression: "4*100 + 2*50" }) → { result: 500 } → 写「共五百铢」。
   - 例：「应到十二万贯，实到十万八千六百贯」→ novel_calculate({ expression: "120000 - 108600" }) → { result: 11400 } → 写「差一万一千四百贯」。
`.trim()

export function apply(ctx: Context, config: Config = {}): void {
  // lark-cli 路径注入（larkBin 优先于 env 与自动探测）。必须在任何
  // 工具注册之前——工具 execute 时才解析，但早设置便于 verbose 打印实际值。
  configureLark({ bin: config.larkBin })

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
  registerCalculateTools(ctx)
  registerBreakthroughTools(ctx)
  registerCharacterArcTools(ctx)
  registerTensionTools(ctx)

  // 全局参数守卫——拦截模型 tool_call 的 arguments 非 plain object 情况。
  // 实机 2026-09-04：模型生成 arguments JSON 时撞 token 上限被截断，
  // DSH parseArguments 返回原始字符串，schema 校验只报
  // `arguments must be an object`，模型反复重试 5+ 次仍不知真因。
  // 这里在工具注册之后挂上 waterfall 监听器，把 schema 错误翻译成可诊断信息。
  registerArgumentGuard(ctx)

  // workToken 上下文注入——子代理委托时自动把主会话的 workToken/workName
  // 写到 prompt 头部。实机 2026-09-04：主会话漏传 workToken 给子代理，
  // 子代理用自己的 lastWorkToken 写到鸦骨账而不是当前作品。修复后
  // 子代理必然在 prompt 头部看到 [工作上下文] 标记，persona 提示
  // 它提取 workToken 并显式传给每个 novel_* 调用。
  registerWorkContextInjector(ctx)

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
    console.error(`[unwr] 插件已加载: ${name} v${readBundleVersion()}`)
    console.error(`[unwr] 已注册工具 (${mine.length}): ${mine.join(', ')}`)
    const resolved = resolveLarkBinDetailed()
    const sourceLabel =
      resolved.source === 'config' ? '插件配置 larkBin'
      : resolved.source === 'env' ? '环境变量 UNWR_LARK_BIN'
      : resolved.source === 'discovered' ? '自动探测'
      : 'PATH 裸名'
    console.error(`[unwr] lark-cli 路径解析: ${resolved.bin}（来源: ${sourceLabel}）`)
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
