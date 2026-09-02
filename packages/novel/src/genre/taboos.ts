/**
 * 网文内容禁忌（compliance constraints / 审核红线）。
 *
 * 来源：知乎专栏《网文新手训练营基础篇：网文禁忌》(zhuanlan.zhihu.com/p/85711550)，
 * 并参照主流平台（起点/番茄/晋江）公开审核标准归纳。
 *
 * 与题材预设的关系：题材预设（presets.ts）决定**怎么写得好**，
 * 本模块决定**怎么写不会死**——后者是前者的前置约束，不随题材切换而放宽。
 *
 * 为什么做成独立模块而不是塞进 preset：
 *   1. 红线**跨题材有效**。写领导人负面、涉黄擦边，在玄幻/都市/悬疑/文学里
 *      一样封书。放进任一题材预设都会造成「换个题材红线就没了」的漏洞。
 *   2. 它是**否决项**而非权重项。preset 的 consistency_weights 是 0–1 的
 *      相对权重，可以互相 pk；红线不能 pk——命中即阻断，不参与排序。
 *   3. 三个消费方需要同一份清单：起草官（生成时回避）、评审官（诊断时检查）、
 *      主编排官（委托时带上）。散在各自 prompt 里必然漂移。
 *
 * 消费方式：
 *   - `renderTabooBrief()`  → 注入 novel_build_context 的 writingGuide（起草官）
 *   - `renderTabooChecklist()` → 追加到 novel_get_review_focus 的 checklist（评审官）
 *   - `TABOO_CATALOG`       → 供 novel_check_consistency 落库时反查 code
 *
 * @module @unwr/novel/genre/taboos
 */

/**
 * 红线等级。
 *
 * 为什么是三档而不是「红线 / 审慎」两档：中间那一档才是**改写工作量最大**
 * 的地方，把它并入任一端都会出错——
 *   - 并入 fatal：模型拒绝写黑帮、暴力、赌博等合法类型小说元素，工具变废。
 *   - 并入 caution：模型当建议听，写出「美化黑道」后被封书，工具失信。
 *
 * 三档的划分依据是**是否存在合法的呈现方式**（可豁免程度），而非题材类别：
 *   - `fatal`   违禁内容本身无合法呈现方式，出现即违规。
 *   - `high`    内容可写，但必须满足强约束（反面呈现 / 只写结果 / 架空化），
 *              否则违规。这是改写的主战场。
 *   - `caution` 主要靠技巧规避，后果相对轻，不阻断创作。
 */
export type TabooTier = 'fatal' | 'high' | 'caution'

/** 等级的后果定义。改这里就能整体调档，不用动 14 条目录。 */
export interface TabooTierRule {
  /** 中文标签，用于 prompt 与检查问题表的问题类型后缀 */
  label: string
  /**
   * 落库严重度（1-5）。
   *
   * 取值受 `blocking = severity >= threshold` 约束，而阈值随题材变化
   * （网文 3 / 类型小说 2 / 纯文学 4）。因此：
   *   - fatal 取 5、high 取 4：恒高于最大阈值 4，**三套题材下都阻断**。
   *   - caution 取 1：恒低于最小阈值 2，**三套题材下都不阻断**（仅提示）。
   * 改动这些数字前请先确认上述不等式仍成立，否则分级会随题材漂移。
   */
  issueSeverity: number
  /** 是否阻断定稿。由 issueSeverity 与题材阈值推导，此字段为显式文档。 */
  blocks: boolean
  /**
   * 跨类型排序权重（题材一致性权重是 0–1）。
   *
   * caution 刻意压到 0.1：当前三套题材的最小一致性权重是 0.3
   * （网文的设定冲突与时间线），取 0.1 才能让审慎档**低于每一条一致性
   * 问题**，而不只是低于最高的那条——它是提示，不该盖住真正的告警。
   * fatal/high 取 90/99 则是同一枚硬币的反面：远高于最大值 0.9。
   */
  sortWeight: number
  /** 给起草官的措辞：告诉模型这一档有多硬 */
  briefLead: string
}

export const TABOO_TIER_RULES: Record<TabooTier, TabooTierRule> = {
  fatal: {
    label: '严禁',
    issueSeverity: 5,
    blocks: true,
    sortWeight: 99,
    briefLead: '以下为绝对禁区：出现即封书/拒签，无「换个框架就能写」的余地，任何动机下都不得呈现。',
  },
  high: {
    label: '高危',
    issueSeverity: 4,
    blocks: true,
    sortWeight: 90,
    briefLead: '以下内容本身可写，但必须严格按「改写方向」处理（反面呈现/只写结果/架空化）；'
      + '踩线即阻断定稿。这是改写的主战场。',
  },
  caution: {
    label: '审慎',
    issueSeverity: 1,
    blocks: false,
    sortWeight: 0.1,
    briefLead: '以下主要靠技巧规避，后果相对轻（改名/重写即可），不阻断定稿，按建议处理。',
  },
}

/** 禁忌条目。 */
export interface TabooEntry {
  /** 稳定编码。写入检查问题表「问题类型」与日志，勿重排、勿改名。 */
  code: string
  /** 等级。决定落库严重度与是否阻断，见 TABOO_TIER_RULES。 */
  severity: TabooTier
  /** 分类标题（4-6 字，用于 prompt 与报告展示） */
  title: string
  /** 硬性规则：一句话说清「不能做什么」 */
  rule: string
  /** 典型违规样例，帮模型对号入座 */
  examples: string[]
  /** 合规替代方案：不是让情节消失，而是换个写法 */
  workaround: string
  /**
   * **不属于**本条红线的情形（可选）。
   *
   * 存在的理由：评审官的主要失效模式是**误报**，不是漏报。末日、黑帮、
   * 灵异、刑侦这些题材天然包含暴力/犯罪/鬼神元素，只给违规样例会让模型
   * 见「黑帮」就报、见「鬼」就报——把合法类型小说全判死，工具就废了。
   *
   * 更关键的是自洽性：webnovel 预设的第一个题材就是「玄幻」，若红线对
   * 神魔/修炼体系误报，本模块与预设体系就自相矛盾。
   *
   * 因此每条红线的判定需要**正反两面**样例，而不是只给一面。
   */
  notTaboo?: string[]
}

/**
 * 禁忌总表。
 *
 * **追加规则**：新条目一律 push 到数组末尾。已有条目的 `code` 是外部稳定
 * 标识（ISSUE 表历史记录、模型训练样本都引用它），重排或改名会让历史数据
 * 失去语义——与 presets.ts「新增题材只加不改」同理。
 */
export const TABOO_CATALOG: readonly TabooEntry[] = [
  {
    code: 'TB_POLITICS',
    severity: 'fatal',
    title: '政治题材',
    rule: '不写现实政治体制、政党、政策评价及现任/历史领导人（含化名影射）。',
    examples: [
      '以真实国名+现实官职描写权力斗争（官场文、宦海文）',
      '用谐音/化名影射真实政治人物或事件',
      '评价、讽刺现行制度与具体政策',
    ],
    workaround: '把权力斗争整体搬到架空世界（大夏、龙国、六部、宗门长老会），'
      + '冲突落在人物野心与利益分配上，不指向现实政治体制。',
  },
  {
    code: 'TB_RELIGION',
    severity: 'high', // 神话/志怪/架空神系可写（见 notTaboo），故非 fatal
    title: '宗教宣扬',
    rule: '不宣扬、不传教、不贬损任何现实宗教；不出现邪教组织及其教义。',
    examples: [
      '大段宣讲某一现实宗教的教义并论证其唯一正确',
      '以现实宗教人物（佛/道/伊斯兰/基督/天主/东正）为角色推动剧情',
      '描写邪教仪式、发展教徒、教主神迹',
    ],
    workaround: '宗教元素可写（人物有信仰、寺庙道观作为场景），但只做背景与'
      + '人物动机，不做教义论证；需要体系化信仰时用完全虚构的架空神系。',
    // 本条是误报重灾区：鬼神、玄幻、志怪是中文网文的主流体裁，
    // 禁的是「宣扬」而非「出现」。不写清楚会把整个大类判死。
    notTaboo: [
      '神话人物（玉帝、阎王、龙王、哪吒等）属传统文化与民俗，可作角色出现——'
        + '它们不是宗教教义，与《西游记》《封神》同源',
      '志怪、灵异、鬼怪题材本身可写（聊斋、民俗惊悚的文学传统）；'
        + '只要不论证鬼神真实存在、不写做法事/驱邪的操作教程',
      '玄幻/修仙的架空神系、修炼体系、神魔种族，不在本条范围内',
      '人物有信仰、去寺庙道观烧香、僧道作为配角出场（非传教）',
    ],
  },
  {
    code: 'TB_ETHNIC',
    severity: 'fatal',
    title: '民族与历史',
    rule: '不贬损任何民族、地域群体；不歪曲、丑化、否定英雄烈士与既定历史结论。',
    examples: [
      '给某一民族/地域贴负面标签（懒惰、狡诈、野蛮）',
      '颠覆历史定论、为已被定性的反面人物翻案',
      '戏说、恶搞烈士事迹',
    ],
    workaround: '冲突写在个体之间（性格、利益、立场），不上升为群体属性；'
      + '涉及真实历史时与官方结论保持一致，或整体改用架空王朝。',
  },
  {
    code: 'TB_OFFICIAL',
    severity: 'fatal',
    title: '公职人员形象',
    rule: '军、警、法、消防等公职人员不得作为系统性反派；不描写其整体腐败堕落。',
    examples: [
      '「黑警」「军队全是蛀虫」式设定',
      '公职人员集体贪腐、包庇犯罪作为世界观常态',
      '以真实部队番号、真实机构名称写负面情节',
    ],
    workaround: '可以有坏个体（某警员被收买、某军官叛变），但必须有同系统的'
      + '正面力量与之对抗并最终纠正；机构名称一律架空。',
    notTaboo: [
      '末日/灾难题材中「秩序崩坏、无人救援」的设定本身，不等于抹黑公职——'
        + '恐怖感来自秩序的缺席，而非秩序的邪恶',
      '以虚构的灾难管理机构、架空番号写负面情节（现实机构名才是雷）',
      '公职角色作为被救援方、或作为背景板缺席',
    ],
  },
  {
    code: 'TB_SEXUAL',
    severity: 'fatal',
    title: '涉黄擦边',
    rule: '不做露骨性描写、性暗示、低俗擦边（这是封书最多的原因）。',
    examples: [
      '性行为过程、性器官、性反应的直接描写',
      '以「脱衣服上床睡觉」这类擦边表述制造暧昧',
      '书名/简介/章标题使用性暗示词汇',
    ],
    workaround: '亲密关系写到情绪与心理层面即止（"她靠过来，他没动"），'
      + '用留白代替过程；情感推进靠对话与抉择，不靠身体描写。',
  },
  {
    code: 'TB_GAMBLING',
    severity: 'high', // 赌局可作情节节点，禁的是手法与美化
    title: '赌博',
    rule: '不美化赌博、不写赌术教程与赌场经营细节。',
    examples: [
      '详写赌术手法、出千技巧、赌场运营流程',
      '把赌博塑造成翻身捷径、主角核心金手指',
      '介绍赌博渠道、非法彩票玩法',
    ],
    workaround: '赌局可作为情节节点，但只写人物抉择与后果（输了付出代价），'
      + '不写手法；主角靠能力而非运气取胜。',
  },
  {
    code: 'TB_DRUGS',
    severity: 'fatal',
    title: '毒品',
    rule: '不美化、不教授毒品；不写制毒贩毒流程与吸毒快感。',
    examples: [
      '描写制毒配方、交易渠道、吸食后的愉悦体验',
      '以毒品作为修炼/提神/治病的正向手段',
    ],
    workaround: '毒品只能作为反派罪行与受害者悲剧出现，且必须被惩处；'
      + '涉及成瘾痛苦可写，涉及快感与方法不可写。',
  },
  {
    code: 'TB_VIOLENCE',
    severity: 'high', // 悬疑/刑侦/战争/末日的正当暴力可写，禁的是渲染过程
    title: '暴力血腥',
    rule: '不写酷刑、肢解、虐杀过程；不渲染血腥细节；不传授犯罪手法。',
    examples: [
      '逐刀描写杀人过程、器官与血腥特写',
      '详写酷刑器具与施刑步骤',
      '末日/饥荒题材中的吃人情节（无论出自正派还是反派）',
      '教学式描写盗窃/诈骗/黑客/制毒的具体操作',
    ],
    workaround: '暴力写结果与人物反应（"他倒下去，没再起来"），不写过程；'
      + '犯罪写动机与破绽，不写可复制的操作细节。',
    notTaboo: [
      '写结果而非过程（"他倒下去，没再起来"）——末日、悬疑、刑侦、战争的'
        + '正当暴力描写，只要不渲染伤口细节与施暴步骤',
      '危险处境与恐惧氛围的营造（丧尸追逐、废墟求生），不靠血腥特写',
      '反派死于意外、死于自己埋下的因果——黑色幽默的常见收法，不属虐杀',
    ],
  },
  {
    code: 'TB_CRIME',
    severity: 'high', // 反派涉黑且被惩处是合规落点，禁的是美化
    title: '黑恶势力',
    rule: '不美化黑社会、帮派、黑恶势力；不写入会仪式与组织运作细节。',
    examples: [
      '把黑道写成热血兄弟情、江湖道义的正面载体',
      '详写入会仪式、帮规、堂口运作、洗钱流程',
      '黑道主角最终全身而退、名利双收',
    ],
    workaround: '涉黑情节必须有法律后果；想写江湖感就架空为门派、商会、'
      + '佣兵团，冲突用规矩与利益解决，不用现实黑帮范式。',
    notTaboo: [
      '角色身份是帮派成员本身不违规——违规的是**美化**：浪漫化江湖道义、'
        + '全身而退、名利双收',
      '以反派身份出现且最终被法律惩处的涉黑情节——这是合规的必要落点，'
        + '不是违例',
      '黑色幽默/反讽式处理：主角被误认成大佬、黑道被写成荒诞窘迫的生存困境',
      '末日/乱世题材中的匪帮、掠夺者作为环境威胁出现',
    ],
  },
  {
    code: 'TB_SUICIDE',
    severity: 'high', // 危机心理与被救回可写，禁的是美化与方法
    title: '自杀自残',
    rule: '不美化、不鼓励自杀自残；不写具体方法与过程。',
    examples: [
      '详写自杀工具、地点选择、实施步骤',
      '把自杀写成解脱、浪漫、报复他人的最优解',
      '群体自杀、殉情作为正面结局',
    ],
    workaround: '写危机中的人物心理与被救回的转折；若必须涉及死亡，'
      + '落点在他人伤痛与未竟之事，不落在方法。',
    notTaboo: [
      '写危机心理、被救回的转折、幸存者的愧疚——这类正是合规写法',
      '为保护他人而牺牲（见义勇为）属正面牺牲描写，与自杀是两回事，'
        + '不适用本条',
      '角色提及「曾有过轻生念头」作为背景，只要不写方法、不美化为解脱',
    ],
  },
  {
    code: 'TB_MINOR',
    severity: 'fatal',
    title: '未成年人',
    rule: '不写未成年人恋爱（早恋）与不伦关系；不写未成年人犯罪细节。',
    examples: [
      '高中生男女主恋爱、暧昧、同居情节',
      '师生恋、兄妹/兄弟恋（骨科）等违背伦理的关系',
      '未成年人施暴、涉毒、涉黄的细节描写',
    ],
    workaround: '主角设定为成年人（大学生及以上、社畜、修士）；'
      + '校园情节写友情、成长、竞争，不写恋爱。',
  },
  {
    code: 'TB_REAL_ENTITY',
    severity: 'caution', // 改名即可，情节不受影响，零成本规避
    title: '真实地名国名',
    rule: '不使用真实地名、真实国名作为故事舞台（会被审核直接驳回）。',
    examples: [
      '以北京、南京、上海等真实城市为主舞台展开势力争斗',
      '以真实国名（中国、美国、日本）写国家间冲突',
      '真实企业、学校、机构名称出现在负面情节中',
    ],
    workaround: '一律架空化：燕京/金陵/江城、大夏/龙国/联邦。'
      + '这是成本最低、收益最高的一条——改个名字，情节一点不用动。',
  },
  {
    code: 'TB_INTL',
    severity: 'caution', // 架空化即可承载，冲突落在战略而非民族优劣
    title: '国际关系',
    rule: '不煽动对他国、他民族的仇恨；不写损害国际友好的剧情。',
    examples: [
      '以真实国家为靶子的泄愤式情节（"怼某国""灭某国"）',
      '对他国人民的整体丑化与灭绝性描写',
    ],
    workaround: '国际冲突整体搬进架空世界；若需外部压力，用虚构邻国、'
      + '异族势力承载，冲突落在战略与立场，不做民族优劣评判。',
  },
  {
    code: 'TB_PLAGIARISM',
    severity: 'caution', // 后果是下架/扣分而非封书，且可借方向、重设细节规避
    title: '抄袭洗稿',
    rule: '不复制、不洗稿他人作品的人物、设定与段落。',
    examples: [
      '照搬知名作品的修炼体系、世界观设定、人物关系',
      '整段改写他人正文后作为原创发布',
      '未经授权的同人商业化',
    ],
    workaround: '灵感可以借鉴方向（"我想写一个类似的师徒反目"），'
      + '但具体设定必须重新设计；需要致敬时化为一句对话式的彩蛋。',
  },
]

/** 按 code 建索引，供落库与日志反查。 */
export const TABOO_BY_CODE: ReadonlyMap<string, TabooEntry> =
  new Map(TABOO_CATALOG.map((t) => [t.code, t]))

/** 等级 → 该等级下的全部条目。渲染与统计都按此分组。 */
export function taboosByTier(tier: TabooTier): readonly TabooEntry[] {
  return TABOO_CATALOG.filter((t) => t.severity === tier)
}

/** 取某条红线的等级规则（含落库严重度与排序权重）。 */
export function tabooTierRule(code: string): TabooTierRule {
  return TABOO_TIER_RULES[TABOO_BY_CODE.get(code)?.severity ?? 'fatal']
}

/**
 * 从问题类型字符串反查等级。
 *
 * 用于落库前校正严重度：红线问题的严重度**由等级决定**，不采信模型自报——
 * 模型对 1-5 这种数字约定遵循得很差，但选「严禁/高危/审慎」很稳。
 * 无法识别时回落到 fatal（**失效安全**：宁可错杀也不放过）。
 */
export function tabooTierFromType(type: string): TabooTier | undefined {
  const suffix = type.split('·')[1]
  return (Object.keys(TABOO_TIER_RULES) as TabooTier[]).find(
    (t) => TABOO_TIER_RULES[t].label === suffix,
  )
}

/**
 * 渲染给**起草官**的禁忌简报。
 *
 * 设计取舍：只给「规则 + 改写方向 + 可写边界」，不给完整 examples 列表——
 * 起草时注入过多负面样例反而会诱导模型往那个方向写（实测有效的 prompt
 * 经验：说"不要想白熊"等于让人想白熊）。examples 留给评审官做判定用。
 *
 * 但 `notTaboo`（可写边界）**必须**给起草官：只讲「不能写什么」会让模型
 * 过度自我审查，末日/黑帮/灵异题材直接不敢下笔。知道「黑帮成员身份本身
 * 不违规，美化才违规」，模型才敢写、且写得对。
 */
export function renderTabooBrief(): string {
  // 按等级分块输出：fatal 在最前（模型对长文本注意力首尾强），
  // 且各档的措辞强度不同——全用一个语气会让模型要么过度自审、要么不当回事。
  const blocks = (Object.keys(TABOO_TIER_RULES) as TabooTier[]).map((tier) => {
    const rule = TABOO_TIER_RULES[tier]
    const items = taboosByTier(tier).flatMap((t) => {
      const head = `- ${t.title}：${t.rule} 改写方向：${t.workaround}`
      if (!t.notTaboo?.length) return [head]
      return [head, `  可写边界（下列情形不违规）：${t.notTaboo.join('；')}`]
    })
    return `【${rule.label}·${tier === 'caution' ? '建议规避' : '命中即阻断'}】${rule.briefLead}\n${items.join('\n')}`
  })
  return [
    '【内容红线】平台审核规则，与题材无关，按严重程度分三档。',
    ...blocks,
  ].join('\n\n')
}

/**
 * 渲染给**评审官**的禁忌检查项。
 *
 * 与 renderTabooBrief 的区别：评审需要**判定**而非**回避**，
 * 所以这里带上 examples（违规样例），让模型能对照正文对号入座。
 *
 * 同时带上 notTaboo：**判定是双向的**。只给违规样例会让评审官见「黑帮」
 * 就报、见「鬼」就报，把末日/黑帮/灵异这些合法类型小说全判死。误报与
 * 漏报一样有害——误报多了作者会直接关掉红线检查。
 */
export function renderTabooChecklist(): string[] {
  // 按等级排序输出（fatal 优先），与起草简报的分块顺序一致，
  // 让评审官从上往下读时先处理最要命的。
  return [...TABOO_CATALOG]
    .sort((a, b) => TABOO_TIER_RULES[b.severity].sortWeight - TABOO_TIER_RULES[a.severity].sortWeight)
    .map((t) => {
      const rule = TABOO_TIER_RULES[t.severity]
      // 编码后缀带上等级：评审官据此决定问题类型（进而决定严重度与是否阻断）
      const parts = [
        `[${t.code}·${rule.label}] ${t.title}：${t.rule}`,
        `违规样例——${t.examples.join('；')}`,
      ]
      if (t.notTaboo?.length) {
        parts.push(`非违例（见此勿报）——${t.notTaboo.join('；')}`)
      }
      parts.push(
        rule.blocks
          ? `命中→按「内容红线·${rule.label}」上报，阻断定稿`
          : `命中→按「内容红线·${rule.label}」上报，仅提示、不阻断定稿`,
      )
      return parts.join(' ')
    })
}
