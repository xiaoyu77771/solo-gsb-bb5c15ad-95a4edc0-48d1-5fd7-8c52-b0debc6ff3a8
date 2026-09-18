/** 领域数据模型 */

export interface Paper {
  id: string
  title: string
  /** 该稿件需要的评审人数 */
  reviewsRequired: number
  /** 主题标签 */
  tags: string[]
}

export interface Reviewer {
  id: string
  name: string
  /** 所属机构：去除首尾空白后完全相同者视为同一机构；空串表示无机构（仅代表本人，不与其他空值合并） */
  organization: string
  /** 擅长标签 */
  tags: string[]
  /** 最多承担的稿件数（容量） */
  capacity: number
  /** 声明利益冲突的稿件 id */
  conflictPaperIds: string[]
}

/**
 * 预指派关系：生成时必须把该稿件分给该评审人（硬约束）。
 * 独立于稿件/评审人存储：即使引用的稿件或评审人被删除，关系仍保留，
 * 由界面显式提示为“失效关系”，用户可逐条移除。
 */
export interface PreAssignment {
  id: string
  paperId: string
  reviewerId: string
}

export interface AppData {
  papers: Paper[]
  reviewers: Reviewer[]
  /** 预指派关系（旧数据缺省为 []，读取时兼容补全） */
  preAssignments: PreAssignment[]
}

/** 单篇稿件的一条分配结果 */
export interface AssignmentItem {
  paperId: string
  reviewerId: string
  /** 是否命中至少一个共同主题标签 */
  topicMatched: boolean
  /** 命中的共同标签 */
  matchedTags: string[]
  /** 该分派是否来自预指派硬约束 */
  preassigned?: boolean
}

/** 评审人在结果中的负载信息 */
export interface ReviewerLoad {
  reviewerId: string
  assigned: number
  capacity: number
}

export type InfeasibleKind =
  | 'global-capacity'
  | 'paper-eligible'
  | 'subset-bottleneck'
  | 'preassignment'

/** 预指派关系在“生成分派”预检时被发现的具体问题（逐条列出稿件、评审人与原因） */
export interface PreAssignmentIssue {
  /** 触发问题的预指派关系 id（界面可据此直接移除该条） */
  preAssignmentId: string
  paperId?: string
  reviewerId?: string
  /** 用于展示的稿件标题（稿件不存在时缺省） */
  paperTitle?: string
  /** 用于展示的评审人姓名（评审人不存在时缺省） */
  reviewerName?: string
  /** 机构去重冲突时：规范化后的机构名（去首尾空白后的非空值） */
  organization?: string
  /** 机构去重冲突时：同一稿件上该机构涉及的全部评审人姓名 */
  organizationReviewerNames?: string[]
  /** 问题类型 */
  reason:
    | 'paper-missing' // 引用的稿件已不存在
    | 'reviewer-missing' // 引用的评审人已不存在
    | 'conflict' // 稿件与评审人之间声明了利益冲突
    | 'organization-duplicate' // 同一稿件的预指派中出现了同一机构的多位评审人
    | 'paper-overflow' // 同篇预指派人数超过该稿件所需人数
    | 'reviewer-overload' // 该评审人被预占名额超过其容量
  message: string
}

export interface InfeasibleReason {
  kind: InfeasibleKind
  message: string
  /** paper-eligible: 对应稿件 id 列表 */
  paperIds?: string[]
  /** subset-bottleneck / global-capacity: 瓶颈涉及的评审人 id 列表 */
  reviewerIds?: string[]
  /** subset-bottleneck 时: 缺口数量 */
  deficit?: number
  /** preassignment: 逐条预指派问题 */
  issues?: PreAssignmentIssue[]
}

export interface AssignmentSuccess {
  feasible: true
  assignments: AssignmentItem[]
  loads: ReviewerLoad[]
  objective: {
    topicMatches: number
    maxLoad: number
    totalAssigned: number
    totalRequired: number
    /** 来自预指派硬约束的分派条数 */
    preassignedCount: number
  }
  /** 是否经过「分派互换」人工调整（重新生成分派后清空） */
  manuallyAdjusted?: boolean
  /** 累计执行的一换一互换次数（仅用于展示与导出追溯） */
  swapCount?: number
}

export interface AssignmentFailure {
  feasible: false
  reasons: InfeasibleReason[]
}

/**
 * 备选方案批量结果（用户选择生成 2～3 个方案时）。
 * 首个方案与单方案模式完全一致（字典序最优）；后续方案满足全部硬约束，
 * 且与已生成的每个方案至少相差 minDifference 条稿件—评审人关系（对称差异）。
 * 无法凑满 requestedCount 时，保留已找到方案并在 stopReason 说明停止原因。
 */
export interface AssignmentBatchSuccess {
  feasible: true
  /** 判别标记：普通 AssignmentSuccess 不带 kind */
  kind: 'batch'
  /** 用户请求的方案数（1～3） */
  requestedCount: number
  /** 用户输入并通过校验的最小差异条数 N */
  minDifference: number
  /** 未能凑满数量时的停止原因说明；凑满时缺省 */
  stopReason?: string
  /** 已找到的方案（至少 1 个；第 1 个为字典序最优方案） */
  solutions: AssignmentSuccess[]
}

export type AssignmentResult = AssignmentSuccess | AssignmentBatchSuccess | AssignmentFailure

/** 类型守卫：是否为备选方案批量结果 */
export function isBatchResult(result: AssignmentResult): result is AssignmentBatchSuccess {
  return result.feasible && (result as AssignmentBatchSuccess).kind === 'batch'
}

/* ------------------------- 评审人缺席压力测试 ------------------------- */

/** 缺席场景中的“可选评审人瓶颈”见证条目 */
export interface StressBottleneckReviewer {
  reviewerId: string
  /** 评审人自身容量 */
  capacity: number
  /** 在受影响稿件组内可评（无利益冲突）的稿件数 */
  eligiblePaperCount: number
  /** 对该稿件组至多能承担的名额 = min(容量, 组内可评稿件数) */
  capacityForGroup: number
}

/** 缺席场景中的受影响稿件 */
export interface StressAffectedPaper {
  paperId: string
  /** 该稿件所需评审人数 */
  required: number
  /** 缺席后仍可分配（无冲突且容量 > 0）的评审人数 */
  available: number
  /** 该稿件自身的名额缺口（available < required 时 > 0；否则为 0，表示仅参与组合性瓶颈） */
  shortfall: number
}

/** 单个评审人完全缺席（容量置 0）的模拟结果 */
export interface StressScenario {
  reviewerId: string
  /** 该评审人被抽走的原容量 */
  capacity: number
  feasible: boolean
  /** 人类可读结论 */
  message: string
  /** —— 不可行时的结构化诊断（可行时缺省） —— */
  /** 受影响稿件（Hall 缺陷稿件组，单篇不足者在前） */
  affectedPapers?: StressAffectedPaper[]
  /** 组合性瓶颈名额缺口（广义 Hall 紧见证：组需求 - 可选评审人至多承担量） */
  deficit?: number
  /** 缺席后全局剩余总容量相对总需求的缺口（可能为 0，此时缺口纯为组合性瓶颈） */
  globalDeficit?: number
  /** 缺席后剩余总容量 */
  remainingCapacity?: number
  /** 可选评审人瓶颈（Hall 见证评审人集合） */
  bottleneckReviewers?: StressBottleneckReviewer[]
}

export interface StressTestReport {
  /** 运行时录入数据指纹；数据变化后与当前指纹不一致即标记过期 */
  fingerprint: string
  runAt: string
  /** 参与模拟的评审人数（容量 > 0） */
  testedReviewerCount: number
  totalRequired: number
  totalCapacity: number
  feasibleCount: number
  infeasibleCount: number
  scenarios: StressScenario[]
}
