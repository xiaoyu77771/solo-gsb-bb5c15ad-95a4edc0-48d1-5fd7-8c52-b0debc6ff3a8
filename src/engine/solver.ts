import solver from 'javascript-lp-solver'
import { checkFeasibility, orgAwareCapacityForPaperGroup } from './maxflow'
import { buildForcedMatrix, dedupePreAssignments, validatePreAssignments, type ForcedMatrix } from './preassign'
import { symmetricDifferenceOfEdges, validateBatchOptions } from './alternatives'
import type {
  AppData,
  AssignmentItem,
  AssignmentResult,
  AssignmentSuccess,
  InfeasibleReason,
  Paper,
  PaperCoverage,
  PreAssignment,
  Reviewer,
  ReviewerLoad,
  TopicCoverageIssue
} from '../types'

/** 标签规范化：去空白、去重，大小写不敏感保留首次写法 */
function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

interface Normalized {
  papers: Paper[]
  reviewers: Reviewer[]
  /** 去重后的预指派关系（失效引用不在此阶段剔除，由预检逐条报告） */
  preAssignments: PreAssignment[]
}

function normalize(data: AppData): Normalized {
  const papers: Paper[] = data.papers
    .map((p) => {
      const tags = normalizeTags(p.tags)
      // 必覆盖主题：沿用同一套标签归一化，且候选仅限该稿件已有标签
      //（残留项：已从 tags 删除 / 大小写或空白写法变化后的旧选择，按归一化后的键重新对齐；无法对齐者丢弃）
      const tagKeys = new Set(tags.map(tagKey))
      const required: string[] = []
      const requiredSeen = new Set<string>()
      for (const raw of Array.isArray(p.requiredTopicTags) ? p.requiredTopicTags : []) {
        const v = (raw ?? '').trim()
        if (!v) continue
        const key = v.toLowerCase()
        if (!tagKeys.has(key) || requiredSeen.has(key)) continue
        requiredSeen.add(key)
        // 保留稿件侧标签当前写法（而不是旧选择时的写法），保证结果/导出与稿件标签展示一致
        required.push(tags.find((t) => tagKey(t) === key)!)
      }
      return {
        ...p,
        title: p.title.trim(),
        tags,
        requiredTopicTags: required,
        reviewsRequired: Math.max(0, Math.floor(Number.isFinite(p.reviewsRequired) ? p.reviewsRequired : 0))
      }
    })
    .filter((p) => p.title.length > 0 && p.reviewsRequired > 0)

  const reviewers: Reviewer[] = data.reviewers
    .map((r) => ({
      ...r,
      name: r.name.trim(),
      // 机构：去除首尾空白后完全相同者视为同一机构；空串保留为空（仅代表本人，不与其他空值合并）
      organization: typeof r.organization === 'string' ? r.organization.trim() : '',
      tags: normalizeTags(r.tags),
      capacity: Math.max(0, Math.floor(Number.isFinite(r.capacity) ? r.capacity : 0)),
      conflictPaperIds: Array.from(new Set(r.conflictPaperIds))
    }))
    .filter((r) => r.name.length > 0)

  return { papers, reviewers, preAssignments: dedupePreAssignments(data.preAssignments ?? []) }
}

function hasConflict(paper: Paper, reviewer: Reviewer): boolean {
  return reviewer.conflictPaperIds.includes(paper.id)
}

function tagKey(t: string): string {
  return t.toLowerCase()
}

/** 稿件 i 与评审人 j 命中的共同主题标签 */
function matchedTagsOf(paper: Paper, reviewer: Reviewer): string[] {
  const rSet = new Set(reviewer.tags.map(tagKey))
  return paper.tags.filter((t) => rSet.has(tagKey(t)))
}

/**
 * 计算一份（可能未经归一化的）稿件与评审人命中的共同主题标签。
 * 复用求解器同一套标签归一化（去空白、大小写不敏感、保留稿件侧首次写法），
 * 供「分派互换」在结果层重算交换后的匹配情况，保证与生成结果口径一致。
 */
export function computeMatchedTags(paper: Paper, reviewer: Reviewer): string[] {
  return matchedTagsOf(
    { ...paper, tags: normalizeTags(paper.tags) },
    { ...reviewer, tags: normalizeTags(reviewer.tags) }
  )
}

/** 稿件的必覆盖主题（归一化：去空白、按小写键去重，且仅限该稿件已有标签；保留稿件侧当前写法） */
export function requiredTopicsOf(paper: Paper): string[] {
  const tags = normalizeTags(paper.tags)
  const tagKeys = new Set(tags.map(tagKey))
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(paper.requiredTopicTags) ? paper.requiredTopicTags : []) {
    const v = (raw ?? '').trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (!tagKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(tags.find((t) => tagKey(t) === key)!)
  }
  return out
}

/**
 * 计算一份分派结果在单篇稿件上的“必覆盖主题”覆盖明细：
 * 该稿全部被分派评审人的命中标签并集，对每个必覆盖主题逐一判定是否覆盖。
 * 输入可为未经归一化的原始数据（内部复用同一套标签归一化）。
 */
export function computePaperCoverage(
  paper: Paper,
  assignedReviewers: Reviewer[],
  /** 预归一化的必覆盖主题；缺省现场归一化 */
  required?: string[]
): PaperCoverage {
  const requiredTopics = required ?? requiredTopicsOf(paper)
  const normPaper = { ...paper, tags: normalizeTags(paper.tags) }
  const union = new Set<string>()
  const byReviewer = assignedReviewers.map((r) => {
    const matched = matchedTagsOf(normPaper, { ...r, tags: normalizeTags(r.tags) })
    for (const t of matched) union.add(tagKey(t))
    return { reviewerId: r.id, matchedKeys: new Set(matched.map(tagKey)) }
  })
  const coveredTopics: string[] = []
  const missingTopics: string[] = []
  const coveredBy: Record<string, string[]> = {}
  for (const topic of requiredTopics) {
    const hit = byReviewer.filter((x) => x.matchedKeys.has(tagKey(topic))).map((x) => x.reviewerId)
    if (hit.length > 0) {
      coveredTopics.push(topic)
      coveredBy[topic] = hit
    } else {
      missingTopics.push(topic)
      coveredBy[topic] = []
    }
  }
  return {
    paperId: paper.id,
    requiredTopics,
    coveredTopics,
    missingTopics,
    satisfied: missingTopics.length === 0,
    coveredBy
  }
}

/**
 * 硬约束评估结果。
 * 可行性、不可行原因与归一化后的输入一并返回，供分配主流程与缺席压力测试复用。
 */
export interface HardConstraintEvaluation {
  feasible: boolean
  reasons: InfeasibleReason[]
  papers: Paper[]
  reviewers: Reviewer[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突 */
  eligible: boolean[][]
  demands: number[]
  capacities: number[]
  /** 评审人机构（归一化、去首尾空白）；空串表示无机构 */
  organizations: string[]
  totalRequired: number
  /** 归一化（去重）后的预指派关系，顺序与存储一致 */
  preAssignments: PreAssignment[]
  /** 预指派问题（逐条）；非空时整体不可行，且不生成任何部分结果 */
  preAssignmentIssues: ReturnType<typeof validatePreAssignments>
  /** 有效预指派矩阵（仅在预检通过时有意义） */
  forced: ForcedMatrix
  /** 预指派占用后，评审人 j 对“自由名额”的剩余容量 = 容量 − 被预指派数 */
  residualCapacities: number[]
  /** 预指派占用后，稿件 i 仍需自由分配的名额 = 需求 − 预指派数 */
  residualDemands: number[]
  /**
   * 每篇稿件上被预指派占住唯一名额的非空机构集合：
   * 自由分配不得再从这些机构中为该稿件选择评审人（同稿每机构至多一人）。
   */
  blockedOrgsByPaper: Set<string>[]
  /** 每篇稿件归一化后的必覆盖主题（稿件侧写法）；无必覆盖主题的稿件为空数组 */
  requiredTopicsByPaper: string[][]
}

/**
 * 残量网络可行性输入：预指派边视为已固定发送的流量，只保留“自由”边（非预指派），
 * 源→稿件容量为剩余需求，评审人→汇容量为剩余容量（容量−预占），
 * 并把预指派已占用的机构名额按稿件封禁。生成分派与压力测试共用同一口径。
 */
export function buildResidualFeasibilityInput(hc: HardConstraintEvaluation): {
  demands: number[]
  capacities: number[]
  eligible: boolean[][]
  organizations: string[]
  blockedOrgsByPaper: Set<string>[]
} {
  const residualEligible = hc.papers.map((_, i) =>
    hc.reviewers.map((_, j) => hc.eligible[i][j] && !hc.forced.forcedByPaperIndex[i].has(j))
  )
  return {
    demands: hc.residualDemands,
    capacities: hc.residualCapacities,
    eligible: residualEligible,
    organizations: hc.organizations,
    blockedOrgsByPaper: hc.blockedOrgsByPaper
  }
}

/**
 * 稿件 i 在机构去重约束下还能从自由评审人处获得的名额上界：
 * 无冲突、未被预指派占用，且其机构未被该稿件上的预指派封禁；同一非空机构只计 1 人，
 * 空机构逐人计数（互不合并）。
 * onlyPositiveCapacity 用于缺席诊断：容量已置 0（或缺席导致剩余容量 ≤ 0）者不计入可选名额。
 */
export function effectiveFreeReviewerCount(args: {
  i: number
  reviewers: Reviewer[]
  eligible: boolean[][]
  organizations: string[]
  forcedByPaper: Set<number>
  blockedOrgs: Set<string>
  /** 额外的逐评审人容量上界（缺省取评审人归一化容量）；传 0 即视为缺席，不计入可选 */
  effectiveCapacities?: number[]
}): number {
  const { i, reviewers, eligible, organizations, forcedByPaper, blockedOrgs, effectiveCapacities } = args
  const countedOrgs = new Set<string>()
  let n = 0
  for (let j = 0; j < reviewers.length; j++) {
    if (!eligible[i][j]) continue
    if (forcedByPaper.has(j)) continue
    const cap = effectiveCapacities ? effectiveCapacities[j] : reviewers[j].capacity
    if (cap <= 0) continue
    const org = organizations[j]
    if (org) {
      if (blockedOrgs.has(org) || countedOrgs.has(org)) continue
      countedOrgs.add(org)
    }
    n++
  }
  return n
}

/**
 * 仅评估硬约束（冲突 / 容量 / 人数 / 机构去重 / 预指派），不做任何目标优化、不改变输入数据。
 * 缺席压力测试把某位评审人容量改为 0 后调用本函数，即“使用既有硬约束可行性逻辑重新判定”
 * （预指派同样是硬约束：容量置 0 后，被该评审人预占的名额会立刻显现为超限）。
 */
export function evaluateHardConstraints(rawData: AppData): HardConstraintEvaluation {
  const { papers, reviewers, preAssignments } = normalize(rawData)
  const P = papers.length
  const R = reviewers.length

  // ---- 冲突矩阵 ----
  const eligible: boolean[][] = papers.map((p) => reviewers.map((r) => !hasConflict(p, r)))
  const demands = papers.map((p) => p.reviewsRequired)
  const capacities = reviewers.map((r) => r.capacity)
  const organizations = reviewers.map((r) => r.organization)
  const totalRequired = demands.reduce((a, b) => a + b, 0)

  // ---- 预指派预检（最高优先级）：引用缺失 / 利益冲突 / 机构重复 / 同篇超额 / 单人超容量 ----
  const preAssignmentIssues = validatePreAssignments(papers, reviewers, preAssignments)
  const forced = buildForcedMatrix(papers, reviewers, preAssignments, eligible)
  const residualCapacities = reviewers.map((r, j) => {
    const reserved = papers.reduce((n, _, i) => n + (forced.forcedByPaperIndex[i].has(j) ? 1 : 0), 0)
    return r.capacity - reserved
  })
  const residualDemands = demands.map((d, i) => d - forced.forcedByPaperIndex[i].size)
  // 机构去重：预指派已确定占住该稿件上其机构的唯一名额，自由分配不得再选同机构者
  const blockedOrgsByPaper: Set<string>[] = papers.map((_, i) => {
    const s = new Set<string>()
    for (const j of forced.forcedByPaperIndex[i]) {
      if (organizations[j]) s.add(organizations[j])
    }
    return s
  })
  // 必覆盖主题（归一化阶段已把候选限定在该稿件标签内、按稿件侧写法对齐）
  const requiredTopicsByPaper = papers.map((p) => (p.requiredTopicTags ?? []).slice())

  const emptyEval = (reasons: InfeasibleReason[]): HardConstraintEvaluation => ({
    feasible: false,
    reasons,
    papers,
    reviewers,
    preAssignments,
    eligible,
    demands,
    capacities,
    organizations,
    totalRequired,
    preAssignmentIssues,
    forced,
    residualCapacities,
    residualDemands,
    blockedOrgsByPaper,
    requiredTopicsByPaper
  })

  // 残量网络输入（自由边 + 机构封禁），预检诊断与正式可行性判定共用同一口径
  const residualInput = buildResidualFeasibilityInput(emptyEval([]))

  if (preAssignmentIssues.length > 0) {
    return emptyEval([
      {
        kind: 'preassignment',
        message:
          `预指派关系存在 ${preAssignmentIssues.length} 条无法满足的问题。预指派是生成分派时必须满足的硬约束，` +
          `任一问题存在时都不会生成部分结果；请逐条移除或修正后重新生成。`,
        issues: preAssignmentIssues
      }
    ])
  }

  const reasons: InfeasibleReason[] = []

  // ---- 退化情形 ----
  if (P === 0) {
    return emptyEval([
      { kind: 'paper-eligible', message: '没有需要分配的有效稿件（请至少录入一篇需要评审的稿件）。' }
    ])
  }
  if (R === 0) {
    reasons.push({
      kind: 'global-capacity',
      message: `尚未录入任何评审人，${papers.reduce((a, p) => a + p.reviewsRequired, 0)} 个评审名额无人承担。`
    })
    return emptyEval(reasons)
  }

  // ---- 原因 1（最具体）：单篇稿件可分配评审人数不足 ----
  // 预指派占用的评审人已确定占住该篇名额，单篇只需再找到 需求−预指派数 位不同评审人；
  // 机构去重同时生效：被预指派封禁的机构、以及彼此同机构的自由评审人只按 1 个名额计。
  const perPaperFailures: InfeasibleReason[] = []
  for (let i = 0; i < P; i++) {
    const reserved = forced.forcedByPaperIndex[i]
    const avail = effectiveFreeReviewerCount({
      i,
      reviewers,
      eligible,
      organizations,
      forcedByPaper: reserved,
      blockedOrgs: blockedOrgsByPaper[i]
    })
    const need = residualDemands[i]
    if (avail < need) {
      const forcedNames = [...reserved].map((j) => reviewers[j].name)
      const blockedNames = [...blockedOrgsByPaper[i]]
        .map((org) => `「${org}」`)
        .join('、')
      perPaperFailures.push({
        kind: 'paper-eligible',
        paperIds: [papers[i].id],
        message:
          `《${papers[i].title}》需要 ${demands[i]} 位评审人` +
          (reserved.size > 0
            ? `（其中 ${reserved.size} 位已由预指派确定：${forcedNames.join('、')}），还需 ${need} 位`
            : '') +
          `，但在无利益冲突且满足“每篇稿件同一机构至多一人”的评审人中仅能再选出 ${Math.max(0, avail)} 位（缺口 ${need - Math.max(0, avail)}）。` +
          (blockedNames ? `其中机构 ${blockedNames} 的名额已被预指派占用。` : '')
      })
    }
  }

  // ---- 全局容量：预指派已提前占住各评审人名额，自由名额总量不得少于剩余总需求 ----
  const totalResidualCapacity = residualCapacities.reduce((a, b) => a + b, 0)
  const totalResidualDemand = residualDemands.reduce((a, b) => a + b, 0)
  if (totalResidualCapacity < totalResidualDemand) {
    const totalForced = forced.forcedKeys.size
    reasons.push({
      kind: 'global-capacity',
      reviewerIds: reviewers.map((r) => r.id),
      message:
        totalForced > 0
          ? `全部稿件共需 ${totalRequired} 个名额，其中 ${totalForced} 个已由预指派提前占住；剩余 ${totalResidualDemand} 个自由名额，而评审人的剩余容量合计仅 ${totalResidualCapacity}（缺口 ${totalResidualDemand - totalResidualCapacity}）。请增加评审人、提高容量或减少预指派。`
          : `全部稿件共需 ${totalRequired} 个评审名额，而 ${R} 位评审人的容量合计仅 ${capacities.reduce((a, b) => a + b, 0)}（缺口 ${totalRequired - capacities.reduce((a, b) => a + b, 0)}）。请增加评审人或提高容量。`
    })
  }

  // ---- 最大流可行性检验（残量视角）----
  // 预指派边视为已固定发送的流量：网络中只保留“自由”边（非预指派），
  // 源→稿件容量为剩余需求，评审人→汇容量为剩余容量（容量−预占），
  // 并在“论文→机构”层封禁已被预指派占住的机构名额（同一稿件每机构至多一人）。
  const feas = checkFeasibility(residualInput)

  if (!feas.feasible && reasons.length === 0 && perPaperFailures.length === 0) {
    // 组合性瓶颈（广义 Hall 条件违反）：
    // 取残量网源侧可达稿件集合 Z，令 Y 为与 Z 中任一稿件有自由边、且仍有自由容量的全部评审人。
    // 机构去重同时计入：Y 对 Z 的可承担名额上界用同构“稿件→机构→评审人”网络精确实测
    //（不能逐人 min 求和，否则会高估同机构名额）。
    const Zidx = feas.sourceReachablePapers
    const Zset = Zidx.map((i) => papers[i])
    const Yidx: number[] = []
    for (let j = 0; j < R; j++) {
      if (residualCapacities[j] <= 0) continue
      if (Zidx.some((i) => residualInput.eligible[i][j])) Yidx.push(j)
    }
    const Yset = Yidx.map((j) => reviewers[j])
    const demandZ = Zidx.reduce((a, i) => a + residualDemands[i], 0)
    // 精确上界：仅以 Z 中稿件为左部、机构层容量 1 的子网络最大流
    const capY = orgAwareCapacityForPaperGroup(residualInput, Zidx)
    const totalForced = forced.forcedKeys.size
    const orgNote = organizations.some((o) => o)
      ? '同一稿件对每个机构至多选择一人（空机构除外），机构集中也会形成名额瓶颈；'
      : ''
    reasons.push({
      kind: 'subset-bottleneck',
      paperIds: Zset.map((p) => p.id),
      reviewerIds: Yset.map((r) => r.id),
      deficit: demandZ - capY,
      message:
        `存在一组 ${Zset.length} 篇稿件，其可选评审人范围相互重叠、形成容量瓶颈：扣除预指派后它们共需 ${demandZ} 个自由名额，` +
        `而 ${Yset.length} 位无冲突且仍有剩余容量的评审人对这组稿件至多能承担 ${capY} 个自由名额（缺口 ${demandZ - capY}，已计入每位评审人对同一篇稿件至多评一次、` +
        `以及同一稿件对每个机构至多一人）。\n` +
        orgNote +
        `瓶颈稿件：${Zset.map((p) => `《${p.title}》`).join('、')}；\n` +
        `可选评审人：${Yset.length ? Yset.map((r) => r.name).join('、') : '（无，全部存在利益冲突、机构名额被预指派占满或容量已被预指派占满）'}。\n` +
        (totalForced > 0 ? `预指派已提前占住 ${totalForced} 个名额；` : '') +
        `建议：为这些稿件补充评审人、解除部分冲突、提高相关评审人容量，或调整预指派。`
    })
  }

  // ---- 必覆盖主题检验（ILP；与预指派/冲突/容量/人数/机构去重共同求解）----
  // 最大流网络只能表达“选谁评”的容量约束，无法表达“命中标签并集须覆盖指定主题”，
  // 因此覆盖性用与正式优化同一套 ILP（runPhase，无目标切割）单独判可行。
  let coverageFeasible = true
  let coverageReason: InfeasibleReason | undefined
  if (feas.feasible && requiredTopicsByPaper.some((t) => t.length > 0)) {
    const coveragePhase = runPhase(
      papers,
      reviewers,
      eligible,
      organizations,
      demands,
      totalRequired,
      null,
      forced,
      [],
      requiredTopicsByPaper
    )
    if (!coveragePhase.feasible) {
      coverageFeasible = false
      coverageReason = diagnoseCoverageFailure(
        papers,
        reviewers,
        eligible,
        organizations,
        demands,
        totalRequired,
        forced,
        requiredTopicsByPaper
      )
    }
  }

  return {
    feasible: feas.feasible && coverageFeasible,
    reasons: coverageFeasible ? (feas.feasible ? [] : [...perPaperFailures, ...reasons]) : [...(coverageReason ? [coverageReason] : [])],
    papers,
    reviewers,
    preAssignments,
    eligible,
    demands,
    capacities,
    organizations,
    totalRequired,
    preAssignmentIssues,
    forced,
    residualCapacities,
    residualDemands,
    blockedOrgsByPaper,
    requiredTopicsByPaper
  }
}

/**
 * 必覆盖主题不可行诊断：指出具体稿件与缺失主题。
 *
 * 对每个设置了必覆盖主题的 (稿件 i, 主题 t) 分别运行一次“只强制该单条覆盖约束、
 * 其余全部硬约束不变”的 ILP：
 *  - 若该单约束 ILP 仍不可行，则在任何可行分派中 t 都无法被 i 覆盖（严格不可覆盖：
 *    无人能命中、命中者全部冲突/同机构被封禁/容量或预指派占死）；
 *  - 若单约束可解但全部覆盖同时求解不可行，则是跨稿件容量竞争（稀缺的命中评审人
 *    无法同时服务所有稿件），相应稿件主题计入“竞争型缺口”并给出放宽建议。
 * 廉价预判（并集为空）先行，可直接判定严格不可覆盖而无需再跑 ILP。
 */
function diagnoseCoverageFailure(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  requiredTopicsByPaper: string[][]
): InfeasibleReason {
  const issues: TopicCoverageIssue[] = []

  for (let i = 0; i < papers.length; i++) {
    const required = requiredTopicsByPaper[i]
    if (required.length === 0) continue

    // 廉价预判：无冲突（且不违反预指派封禁）的可命中评审人并集
    const unionReachable = (t: string): boolean => {
      const key = tagKey(t)
      const blocked = new Set<string>()
      for (const j of forced.forcedByPaperIndex[i]) {
        if (organizations[j]) blocked.add(organizations[j])
      }
      const countedOrgs = new Set<string>()
      for (let j = 0; j < reviewers.length; j++) {
        if (!eligible[i][j]) continue
        // 预指派评审人必然在位，直接计入；不占用机构名额之外的额外判定
        if (forced.forcedByPaperIndex[i].has(j)) {
          if (reviewers[j].tags.some((rt) => tagKey(rt) === key)) return true
          continue
        }
        const org = organizations[j]
        if (org) {
          if (blocked.has(org) || countedOrgs.has(org)) continue
          countedOrgs.add(org)
        }
        if (reviewers[j].tags.some((rt) => tagKey(rt) === key)) return true
      }
      return false
    }

    const strictMissing: string[] = []
    const contestedMissing: string[] = []
    for (const t of required) {
      if (!unionReachable(t)) {
        strictMissing.push(t)
        continue
      }
      // 单约束 ILP：全局只保留“稿件 i 覆盖主题 t”这一条覆盖约束
      //（其他稿件的必覆盖主题暂时全部放开；人数/容量/冲突/机构/预指派仍全部生效）。
      // 不可行即说明在任何全局分派中该主题都无法被该稿件覆盖；可行而联合模型不可行则是跨稿容量竞争。
      const probe = requiredTopicsByPaper.map((_, k) => (k === i ? [t] : []))
      const r = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, null, forced, [], probe)
      if (!r.feasible) strictMissing.push(t)
      else contestedMissing.push(t)
    }

    if (strictMissing.length > 0) {
      issues.push({
        paperId: papers[i].id,
        paperTitle: papers[i].title,
        missingTopics: strictMissing,
        strictlyUncoverable: true
      })
    } else if (contestedMissing.length > 0) {
      issues.push({
        paperId: papers[i].id,
        paperTitle: papers[i].title,
        missingTopics: contestedMissing,
        strictlyUncoverable: false
      })
    }
  }

  const strict = issues.filter((x) => x.strictlyUncoverable)
  const contested = issues.filter((x) => !x.strictlyUncoverable)
  const paperIds = issues.map((x) => x.paperId)

  const strictLines = strict.map(
    (x) => `  · 《${x.paperTitle}》缺失主题：${x.missingTopics.map((t) => `「${t}」`).join('、')}`
  )
  const contestedLines = contested.map(
    (x) => `  · 《${x.paperTitle}》缺失主题：${x.missingTopics.map((t) => `「${t}」`).join('、')}`
  )

  const message =
    `必覆盖主题硬约束无法满足：分给稿件的评审人命中标签并集必须覆盖该稿设置的全部必覆盖主题。\n` +
    (strict.length > 0
      ? `以下 ${strict.length} 篇稿件的部分主题在当前数据下没有任何可选评审人能命中` +
        `（已计入利益冲突回避、每稿每机构至多一人、预指派占住的名额与评审人容量）：\n${strictLines.join('\n')}\n` +
        `请为相应稿件补充擅长这些主题的评审人、解除利益冲突，或调整预指派 / 机构与容量设置。\n`
      : '') +
    (contested.length > 0
      ? `以下 ${contested.length} 篇稿件的主题虽各有评审人能命中，但在全部硬约束共同求解时` +
        `（命中者还要同时服务其他稿件、受容量与机构去重限制）无法同时覆盖：\n${contestedLines.join('\n')}\n` +
        `请提高相关评审人容量、补充能命中这些主题的评审人，或放宽部分必覆盖主题。`
      : '')

  return { kind: 'topic-coverage', message, paperIds, coverageIssues: issues }
}

/**
 * 核心入口：执行盲审分配。
 *
 * 硬约束（全部必须满足，否则不可行）:
 *  1. 预指派：显式指定的（稿件，评审人）对必须出现在分派中；
 *  2. 利益冲突：声明冲突的稿件-评审人对绝不分配；
 *  3. 容量：每位评审人承担稿件数不超过 capacity（含被预指派预占的名额）；
 *  4. 人数：每篇稿件恰好得到 reviewsRequired 位互不相同的评审人；
 *  5. 机构去重：同一篇稿件至多选择每个机构（去首尾空白后相同的非空机构名）一人；
 *     机构为空的评审人不受此限，且空值之间互不合并（仅代表本人）；
 *  6. 必覆盖主题：每篇稿件可从其已有标签中多选“必覆盖主题”；分给该稿件的评审人
 *     命中标签的并集必须覆盖全部所选主题（无必覆盖主题的稿件不受此约束）。
 *
 * 优化目标（硬约束满足后）:
 *  第一优先 最大化稿件主题标签与评审人擅长标签的匹配数；
 *  第二优先 最小化评审人最大负载（负载均衡）。
 */
export function solveAssignment(rawData: AppData): AssignmentResult {
  // ---- 硬约束可行性（与缺席压力测试共用同一套判定逻辑；预指派问题在此逐条报告） ----
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    return { feasible: false, reasons: hc.reasons }
  }

  // ---- 硬约束可行：用整数规划做目标优化（预指派关系作为强制变量） ----
  // 单方案模式不带多样性切割，预检（最大流 + 覆盖 ILP）已证明可行；
  // optimize 仅在求解器/兜底启发式双双异常时才可能返回 null，此时如实报告而非产出违规结果。
  const result = optimize(hc.papers, hc.reviewers, hc.eligible, hc.organizations, hc.demands, hc.totalRequired, hc.forced)
  if (!result) {
    return {
      feasible: false,
      reasons: [
        {
          kind: 'topic-coverage',
          message:
            '硬约束预检通过，但优化器本次未能构造出完整满足全部约束（含必覆盖主题）的分派。' +
            '请重试生成；若问题持续，请检查容量、必覆盖主题与机构设置。'
        }
      ]
    }
  }
  return result
}

/**
 * 备选方案批量入口。
 *
 * requestedCount 为用户选择的方案数（1～3），minDifference 为用户输入并校验过的 N：
 *  - 第 1 个方案与单方案模式完全一致（字典序：主题匹配最大化 → 最大负载最小化）；
 *  - 第 k（k ≥ 2）个方案必须满足全部硬约束，且与已生成的每个方案的关系对称差 ≥ N。
 *    求解时把每个旧方案作为一条多样性切割加入同一 ILP（仍按字典序选最优的合格备选）。
 *  - 若不存在满足切割的方案，则停止生成并说明原因；已找到的方案全部保留。
 *
 * requestedCount === 1 时退化为 {@link solveAssignment}（返回普通 AssignmentSuccess，
 * 保持现有单方案默认行为与导出/互换逻辑完全不变）。
 */
export function solveAssignmentBatch(
  rawData: AppData,
  requestedCount: number,
  minDifference: number
): AssignmentResult {
  const count = Math.floor(requestedCount)
  if (!Number.isInteger(requestedCount) || count < 1 || count > 3) {
    return { feasible: false, reasons: [{ kind: 'paper-eligible', message: '方案数量必须是 1～3 之间的整数。' }] }
  }
  if (count === 1) return solveAssignment(rawData)

  // ---- 硬约束可行性（与单方案同源；不可行时不产生任何部分结果） ----
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    return { feasible: false, reasons: hc.reasons }
  }

  const { papers, reviewers, eligible, organizations, demands, totalRequired, forced } = hc

  // 第 1 个方案：现有字典序最优
  const first = optimize(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  if (!first) {
    // 理论不可达（最大流已保证无切割可行）；防御性失败
    return { feasible: false, reasons: [{ kind: 'subset-bottleneck', message: '首方案求解失败，请重试。' }] }
  }

  // 参数校验（N 为正整数且不超过当前数据的可实现上界）
  const validation = validateBatchOptions({ requestedCount: count, minDifferenceInput: minDifference, reference: first })
  if (!validation.ok) {
    return { feasible: false, reasons: [{ kind: 'paper-eligible', message: validation.message }] }
  }
  const N = validation.minDifference

  const solutions: AssignmentSuccess[] = [first]
  const edgeSets: Set<string>[] = []
  {
    // 用局部下标键构造切割（forced 下标在方案间一致，自由边按下标比对）
    const paperIndex = forced.paperIndex
    const reviewerIndex = forced.reviewerIndex
    const edges = new Set<string>()
    for (const a of first.assignments) {
      const i = paperIndex.get(a.paperId)
      const j = reviewerIndex.get(a.reviewerId)
      if (i !== undefined && j !== undefined) edges.add(`${i}_${j}`)
    }
    edgeSets.push(edges)
  }

  let stopReason: string | undefined
  for (let k = 1; k < count; k++) {
    // 与“已生成的每个方案”至少相差 N 条关系
    const cuts: DiversityCut[] = edgeSets.map((keys) => ({ keys, minSymmetricDifference: N }))
    const candidate = optimize(papers, reviewers, eligible, organizations, demands, totalRequired, forced, cuts)
    if (!candidate) {
      const found = solutions.length
      stopReason =
        `已生成 ${found} 个方案后停止：在满足全部硬约束的前提下，找不到与已生成的每个方案` +
        `都至少相差 ${N} 条稿件—评审人关系的第 ${found + 1} 个方案（第 ${found + 1} 次整数规划在全部多样性约束下不可行）。` +
        `已找到的 ${found} 个方案全部保留；可调小差异条数 N、减少预指派或放宽容量后重试。`
      break
    }
    // 防御性复核：用全局关系集合再算一次对称差，确保与每个旧方案都达到 N
    const candidateEdges = new Set<string>()
    for (const a of candidate.assignments) candidateEdges.add(`${a.paperId}␟${a.reviewerId}`)
    let violated = false
    for (let s = 0; s < solutions.length; s++) {
      const prev = new Set<string>()
      for (const a of solutions[s].assignments) prev.add(`${a.paperId}␟${a.reviewerId}`)
      if (symmetricDifferenceOfEdges(candidateEdges, prev) < N) {
        violated = true
        break
      }
    }
    if (violated) {
      stopReason =
        `已生成 ${solutions.length} 个方案后停止：求解器返回的候选未能通过差异条数复核（少于 ${N} 条）。` +
        `已找到的 ${solutions.length} 个方案全部保留。`
      break
    }
    // 记录局部下标键，供下一轮切割使用
    const localKeys = new Set<string>()
    for (const a of candidate.assignments) {
      const i = forced.paperIndex.get(a.paperId)
      const j = forced.reviewerIndex.get(a.reviewerId)
      if (i !== undefined && j !== undefined) localKeys.add(`${i}_${j}`)
    }
    edgeSets.push(localKeys)
    solutions.push(candidate)
  }

  return { feasible: true, kind: 'batch', requestedCount: count, minDifference: N, solutions, stopReason }
}

/* ------------------------------ 整数规划优化 ------------------------------ */

/**
 * 备选方案多样性切割（diversity cut）：新方案相对某个已生成方案必须至少有
 * {@link minSymmetricDifference} 条关系（对称差）不同。
 * keys 为旧方案选中的局部变量下标键 "i_j"。
 */
export interface DiversityCut {
  keys: Set<string>
  minSymmetricDifference: number
}

interface PhaseSolution {
  feasible: boolean
  /** 最优主题匹配数 */
  matches: number
  /** 求解器原始结果，用于读取变量取值 */
  raw: Record<string, number>
}

/**
 * 阶段模型：在“每位评审人负载 ≤ capLimit（缺省取自身容量）”下最大化主题匹配数。
 *
 * 约束矩阵是带容量二部图（b-匹配 / 运输问题）的节点-关联阵，全幺模：
 * LP 松弛的顶点解天然为整数，javascript-lp-solver 无需真正分支即可快速求得 0/1 最优解。
 * 机构去重以“每（稿件,非空机构）Σ x ≤ 1”的行约束加入（机构成员节点-关联阵依旧全幺模）；
 * 空机构不生成此类约束，因此空值仅代表本人。
 *
 * 必覆盖主题以“每（稿件 i，必覆盖主题 t）Σ_{j 命中 t} x[i][j] ≥ 1”的行约束加入。
 * 该约束破坏全幺模性（集合覆盖型行），求解器按需做整数分支；规模仍为
 * （稿件数 × 每稿必覆盖主题数）行，与机构行数同量级。
 *
 * cuts（备选方案模式）为每个已生成方案增加一行“不得重复多于 T−⌈N/2⌉ 条旧关系”：
 * 两方案分派总数相同，对称差 = 2 × 仅属于其一的关系数，⌈N/2⌉ 即单侧最少不同数。
 * 加入切割行后矩阵不再保证全幺模，求解器按需做整数分支（规模仍为同一数量级）。
 */
function runPhase(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  capLimit: number | null,
  forced: ForcedMatrix,
  cuts: DiversityCut[] = [],
  requiredTopicsByPaper: string[][] = papers.map((p) => p.requiredTopicTags ?? [])
): PhaseSolution {
  const P = papers.length
  const R = reviewers.length

  const model: {
    optimize: string
    opType: 'max'
    constraints: Record<string, Record<string, number>>
    variables: Record<string, Record<string, number>>
    binaries: Record<string, 1>
  } = {
    optimize: 'objective',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {}
  }

  papers.forEach((_, i) => {
    model.constraints[`paper_${i}`] = { equal: demands[i] }
  })
  reviewers.forEach((r, j) => {
    model.constraints[`reviewer_${j}`] = { max: capLimit === null ? r.capacity : Math.min(r.capacity, capLimit) }
  })
  // 预指派硬约束：对应二元变量必须取 1（与冲突/容量/人数共同求解，不是事后补丁）
  for (const key of forced.forcedKeys) {
    model.constraints[`pre_${key}`] = { equal: 1 }
  }
  // 备选方案多样性：相对每个旧方案的重叠关系数不得超过 T − ⌈N/2⌉。
  // 预指派变量在每个方案中都为 1，计入切割上界但天然贡献满额重叠，不影响可行性。
  cuts.forEach((cut, ci) => {
    model.constraints[`cut_${ci}`] = { max: totalRequired - Math.ceil(cut.minSymmetricDifference / 2) }
  })
  // 机构去重硬约束：每个（稿件 i，非空机构 o）一行，Σ_j∈org(o) x[i][j] ≤ 1。
  // 空机构不生成行（空值仅代表本人，互不合并）；机构名按去首尾空白后的精确值分组（区分大小写）。
  const distinctOrgs: string[] = []
  const hasOrg = new Set<string>()
  for (let j = 0; j < R; j++) {
    const org = organizations[j]
    if (org && !hasOrg.has(org)) {
      hasOrg.add(org)
      distinctOrgs.push(org)
    }
  }
  for (let i = 0; i < P; i++) {
    for (const org of distinctOrgs) {
      model.constraints[`org_${i}_${org}`] = { max: 1 }
    }
  }
  // 必覆盖主题硬约束行：cover_{i}_{tIdx}: Σ 命中该主题的 x ≥ 1。
  // 行只对“稿件 i 与评审人 j 命中该主题”的变量赋系数 1（见下方变量构造）。
  for (let i = 0; i < P; i++) {
    requiredTopicsByPaper[i].forEach((t, ti) => {
      model.constraints[`cover_${i}_${ti}_${tagKey(t)}`] = { min: 1 }
    })
  }

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue // 冲突对不生成变量 —— 硬约束：利益冲突
      const varName = `x_${i}_${j}`
      const matched = matchedTagsOf(papers[i], reviewers[j])
      const matchedKeys = new Set(matched.map(tagKey))
      model.binaries[varName] = 1
      model.variables[varName] = {
        [`paper_${i}`]: 1,
        [`reviewer_${j}`]: 1,
        objective: matched.length > 0 ? 1 : 0
      }
      if (forced.forcedKeys.has(`${i}_${j}`)) {
        model.variables[varName][`pre_${i}_${j}`] = 1
      }
      if (organizations[j]) {
        model.variables[varName][`org_${i}_${organizations[j]}`] = 1
      }
      // 必覆盖主题：该评审人在该稿件上命中哪些必覆盖主题，就给对应覆盖行系数 1
      requiredTopicsByPaper[i].forEach((t, ti) => {
        if (matchedKeys.has(tagKey(t))) {
          model.variables[varName][`cover_${i}_${ti}_${tagKey(t)}`] = 1
        }
      })
      // 多样性切割行：仅在旧方案中出现的变量系数为 1
      cuts.forEach((cut, ci) => {
        if (cut.keys.has(`${i}_${j}`)) model.variables[varName][`cut_${ci}`] = 1
      })
    }
  }

  const res = solver.Solve(model as never) as Record<string, number | boolean>

  // 以实际取到 1 的变量数为准判定可行性（兼容求解器对 infeasible 返回 -0 的行为）
  let chosen = 0
  for (const v of Object.keys(model.variables)) {
    if (Math.round((res[v] as number) ?? 0) === 1) chosen++
  }
  const feasible = chosen === totalRequired && res.feasible !== false
  return { feasible, matches: feasible ? Math.round((res.result as number) ?? 0) : 0, raw: res as unknown as Record<string, number> }
}

function parseSolution(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  raw: Record<string, number>,
  forced: ForcedMatrix
): AssignmentItem[] {
  const P = papers.length
  const R = reviewers.length
  const assignments: AssignmentItem[] = []
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue
      if (Math.round(raw[`x_${i}_${j}`] ?? 0) !== 1) continue
      const matched = matchedTagsOf(papers[i], reviewers[j])
      const isForced = forced.forcedKeys.has(`${i}_${j}`)
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: isForced || undefined
      })
    }
  }
  return assignments.sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))
}

function buildSuccess(
  papers: Paper[],
  reviewers: Reviewer[],
  assignments: AssignmentItem[],
  totalRequired: number
): AssignmentSuccess {
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  const loads: ReviewerLoad[] = reviewers.map((r) => ({
    reviewerId: r.id,
    assigned: counts.get(r.id) ?? 0,
    capacity: r.capacity
  }))

  const sorted = [...assignments].sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))
  const byPaper = new Map<string, AssignmentItem[]>()
  for (const a of sorted) byPaper.set(a.paperId, [...(byPaper.get(a.paperId) ?? []), a])
  // 必覆盖主题覆盖明细（逐稿；入参 papers/reviewers 已归一化，直接复用其 requiredTopicTags）
  const paperCoverage: PaperCoverage[] = papers.map((p) => {
    const items = byPaper.get(p.id) ?? []
    const assignedReviewers = items
      .map((a) => reviewers.find((r) => r.id === a.reviewerId))
      .filter((r): r is Reviewer => !!r)
    return computePaperCoverage(p, assignedReviewers, p.requiredTopicTags ?? [])
  })

  return {
    feasible: true,
    assignments: sorted,
    loads,
    paperCoverage,
    objective: {
      topicMatches: assignments.filter((a) => a.topicMatched).length,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: assignments.length,
      totalRequired,
      preassignedCount: assignments.filter((a) => a.preassigned === true).length
    }
  }
}

function optimize(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  cuts: DiversityCut[] = []
): AssignmentSuccess | null {
  const R = reviewers.length
  const hasCuts = cuts.length > 0
  // 必覆盖主题（papers 已归一化；默认参数即取此值，这里显式计算供防御性复核与贪心兜底复用）
  const requiredTopicsByPaper = papers.map((p) => p.requiredTopicTags ?? [])

  // 阶段一：真实容量下最大化主题匹配数（预指派变量固定为 1），得到最优匹配数 M*
  const phase1 = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, null, forced, cuts)

  // 无切割时：预检（evaluateHardConstraints 的覆盖 ILP + 最大流）已保证可行；
  // 仅在求解器异常时退回覆盖感知的贪心可行解。
  // 带多样性切割时“不可行”是停止找备选的正常信号，且贪心不保证满足切割，只能返回 null。
  if (!phase1.feasible) {
    return hasCuts ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  const bestMatches = phase1.matches
  let bestRaw = phase1.raw

  // 阶段二：在不损失任何主题匹配（匹配数仍为 M*）的前提下，二分最小化最大负载 L。
  // 上界直接取阶段一解的最大负载，下界取总名额按人均摊的向上取整。
  const phase1Items = parseSolution(papers, reviewers, eligible, phase1.raw, forced)
  const phase1Counts = new Map<string, number>()
  for (const a of phase1Items) phase1Counts.set(a.reviewerId, (phase1Counts.get(a.reviewerId) ?? 0) + 1)
  const upperL = Math.max(1, ...reviewers.map((r) => phase1Counts.get(r.id) ?? 0))
  let lo = Math.max(1, Math.ceil(totalRequired / R))
  let hi = upperL

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, mid, forced, cuts)
    if (r.feasible && r.matches === bestMatches) {
      hi = mid
      bestRaw = r.raw
    } else {
      lo = mid + 1
    }
  }

  const assignments = parseSolution(papers, reviewers, eligible, bestRaw, forced)
  if (assignments.length !== totalRequired) {
    return hasCuts ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  // 防御性校验：求解结果必须完整包含全部预指派
  for (const key of forced.forcedKeys) {
    const [i, j] = key.split('_').map(Number)
    if (!assignments.some((a) => a.paperId === papers[i].id && a.reviewerId === reviewers[j].id)) {
      return hasCuts ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
    }
  }
  // 防御性校验：同一篇稿件不得出现同一机构两人（机构去重硬约束，空机构除外）
  if (hasDuplicateOrganization(papers, reviewers, assignments)) {
    return hasCuts ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  // 防御性校验：每篇稿件的必覆盖主题必须全部被命中标签并集覆盖（ILP 已保证，此处兜底求解器异常）
  const byPaper = new Map<string, AssignmentItem[]>()
  for (const a of assignments) byPaper.set(a.paperId, [...(byPaper.get(a.paperId) ?? []), a])
  const coverageOk = papers.every((p, i) => {
    if (requiredTopicsByPaper[i].length === 0) return true
    const items = byPaper.get(p.id) ?? []
    const assignedRv = items.map((a) => reviewers.find((r) => r.id === a.reviewerId)!).filter(Boolean)
    return computePaperCoverage(p, assignedRv, requiredTopicsByPaper[i]).satisfied
  })
  if (!coverageOk) {
    return hasCuts ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  return buildSuccess(papers, reviewers, assignments, totalRequired)
}

/** 结果层机构去重复核：同一稿件出现两个去空白后相同的非空机构评审人即视为违规 */
function hasDuplicateOrganization(papers: Paper[], reviewers: Reviewer[], assignments: AssignmentItem[]): boolean {
  const orgOf = new Map(reviewers.map((r) => [r.id, r.organization]))
  const byPaper = new Map<string, Set<string>>()
  for (const a of assignments) {
    const org = (orgOf.get(a.reviewerId) ?? '').trim()
    if (!org) continue
    const set = byPaper.get(a.paperId) ?? new Set<string>()
    if (set.has(org)) return true
    set.add(org)
    byPaper.set(a.paperId, set)
  }
  void papers
  return false
}

/**
 * 求解器异常时的兜底：先放入全部预指派，再贪心选取（最大流 + 覆盖 ILP 已保证存在可行解）。
 * 选取优先级：先尽量覆盖该稿尚未满足的“必覆盖主题”，再按主题匹配、当前负载最低；
 * 每选一人后重排候选（边际覆盖数会变化）。贪心只在求解器异常时触发，仅求得到合法可行解。
 */
function greedyFallback(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix
): AssignmentSuccess | null {
  const assigned = new Map<string, number>(reviewers.map((r) => [r.id, 0]))
  const assignments: AssignmentItem[] = []
  const placed = new Set<string>()
  // 每篇稿件已占住的非空机构（预指派先行占位，自由选取不得再选同机构者）
  const usedOrgsByPaper = papers.map(() => new Set<string>())
  // 每篇稿件已被（含预指派）覆盖的必覆盖主题键
  const coveredKeysByPaper = papers.map(() => new Set<string>())

  const place = (i: number, j: number, preassigned: boolean) => {
    const matched = matchedTagsOf(papers[i], reviewers[j])
    assignments.push({
      paperId: papers[i].id,
      reviewerId: reviewers[j].id,
      topicMatched: matched.length > 0,
      matchedTags: matched,
      preassigned: preassigned || undefined
    })
    assigned.set(reviewers[j].id, (assigned.get(reviewers[j].id) ?? 0) + 1)
    placed.add(`${i}_${j}`)
    if (organizations[j]) usedOrgsByPaper[i].add(organizations[j])
    for (const t of matched) coveredKeysByPaper[i].add(tagKey(t))
  }

  // 预指派先无条件占位（预检已保证其不冲突、不超额、无同稿重复机构）
  for (let i = 0; i < papers.length; i++) {
    for (const j of forced.forcedByPaperIndex[i]) place(i, j, true)
  }

  // 剩余必覆盖主题最多的稿件优先（贪心先解最紧的覆盖需求）
  const ordered = [...papers.map((_, i) => i)].sort((a, b) => {
    const ra = (papers[a].requiredTopicTags ?? []).filter((t) => !coveredKeysByPaper[a].has(tagKey(t))).length
    const rb = (papers[b].requiredTopicTags ?? []).filter((t) => !coveredKeysByPaper[b].has(tagKey(t))).length
    if (rb !== ra) return rb - ra
    return demands[b] - demands[a]
  })
  for (const i of ordered) {
    const paper = papers[i]
    const requiredKeys = (paper.requiredTopicTags ?? []).map(tagKey)
    let need = demands[i] - forced.forcedByPaperIndex[i].size
    while (need > 0) {
      need--
      const candidates = reviewers
        .map((r, j) => {
          if (!eligible[i][j] || placed.has(`${i}_${j}`)) return null
          if (organizations[j] && usedOrgsByPaper[i].has(organizations[j])) return null
          const matched = matchedTagsOf(paper, r)
          const mKeys = new Set(matched.map(tagKey))
          // 边际必覆盖数：选此人能新覆盖多少个当前仍缺失的必覆盖主题
          const marginalCover = requiredKeys.filter((k) => !coveredKeysByPaper[i].has(k) && mKeys.has(k)).length
          return { r, j, matched, marginalCover }
        })
        .filter((x): x is { r: Reviewer; j: number; matched: string[]; marginalCover: number } => x !== null)
        .sort((a, b) => {
          if (b.marginalCover !== a.marginalCover) return b.marginalCover - a.marginalCover
          if ((a.matched.length > 0 ? 1 : 0) !== (b.matched.length > 0 ? 1 : 0))
            return b.matched.length - a.matched.length
          return (assigned.get(a.r.id) ?? 0) - (assigned.get(b.r.id) ?? 0)
        })
      const pick = candidates[0]
      if (!pick) break
      place(i, pick.j, false)
    }
  }

  // 兜底自检：必覆盖主题未全覆盖说明贪心失败，交回 null（由上层作为不可行处理，不产出违规结果）
  const coverageOk = papers.every((p, i) =>
    (p.requiredTopicTags ?? []).every((t) => coveredKeysByPaper[i].has(tagKey(t)))
  )
  if (!coverageOk) return null
  return buildSuccess(papers, reviewers, assignments, totalRequired)
}
