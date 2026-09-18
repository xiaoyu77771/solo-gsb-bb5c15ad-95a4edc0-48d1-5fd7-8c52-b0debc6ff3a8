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
  ReviewerLoad
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
      // 必覆盖主题：候选仅限该稿件已有标签；存储中残留（标签被删除/改名）的值按大小写不敏感剔除，
      // 写法以稿件标签侧首次出现为准（与命中标签口径一致）。
      const tagByKey = new Map(tags.map((t) => [tagKey(t), t]))
      const seenCover = new Set<string>()
      const mustCoverTags: string[] = []
      for (const raw of Array.isArray(p.mustCoverTags) ? p.mustCoverTags : []) {
        const key = tagKey(typeof raw === 'string' ? raw.trim() : '')
        const canonical = tagByKey.get(key)
        if (canonical && !seenCover.has(key)) {
          seenCover.add(key)
          mustCoverTags.push(canonical)
        }
      }
      return {
        ...p,
        title: p.title.trim(),
        tags,
        mustCoverTags,
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

/**
 * 计算单篇稿件的必覆盖主题覆盖明细（结果构建、互换复核共用同一口径）。
 * assignedReviewers 为实际分给该稿件的评审人；命中标签按大小写不敏感取并集，
 * 写法以稿件标签侧首次出现为准。paper / reviewers 应为归一化后的数据。
 */
export function coverageOfNormalized(paper: Paper, assignedReviewers: Reviewer[]): PaperCoverage {
  const required = paper.mustCoverTags ?? []
  const union = new Map<string, string>()
  for (const r of assignedReviewers) {
    for (const t of matchedTagsOf(paper, r)) {
      const key = tagKey(t)
      if (!union.has(key)) union.set(key, t)
    }
  }
  const coveredTags = required.filter((t) => union.has(tagKey(t)))
  const missingTags = required.filter((t) => !union.has(tagKey(t)))
  return {
    paperId: paper.id,
    requiredTags: required,
    coveredTags,
    missingTags,
    unionMatchedTags: [...union.values()],
    satisfied: missingTags.length === 0
  }
}

/** 对外便捷入口：对可能未经归一化的稿件/评审人数据计算覆盖明细 */
export function computePaperCoverage(paper: Paper, assignedReviewers: Reviewer[]): PaperCoverage {
  return coverageOfNormalized(
    { ...paper, tags: normalizeTags(paper.tags), mustCoverTags: (paper.mustCoverTags ?? []).map((t) => t.trim()) },
    assignedReviewers.map((r) => ({ ...r, tags: normalizeTags(r.tags) }))
  )
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
  /**
   * 每篇稿件的必覆盖主题（归一化后的稿件标签子集）：
   * 分给该稿件的评审人命中标签并集必须覆盖其中每一个主题（硬约束）。
   */
  requiredTopics: string[][]
  /** 是否至少存在一个必覆盖主题（无必覆盖主题时走纯最大流可行性，行为与旧版完全一致） */
  hasCoverageConstraints: boolean
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
 * 必覆盖主题的结构性预检：在不做整体 ILP 的前提下，逐稿逐主题统计
 * “能命中该主题”的可选评审人数——预指派中命中者直接固定贡献一个名额；
 * 自由评审人还须无利益冲突、未被预指派占用、剩余容量 > 0、机构名额未被预指派封禁，
 * 且同一非空机构只计 1 人（机构去重口径）。
 *
 * 返回的每一项表示：在不考虑其他稿件争用的单稿视角下，该主题已经没有任何可命中的评审人，
 * 属于无论如何都无法覆盖的必覆盖主题（最终联合判定再用 ILP 见证补齐“互相争用”型缺口）。
 */
function findStructurallyUncoverableTopics(args: {
  papers: Paper[]
  reviewers: Reviewer[]
  eligible: boolean[][]
  organizations: string[]
  residualCapacities: number[]
  forced: ForcedMatrix
  blockedOrgsByPaper: Set<string>[]
}): Array<{ paper: Paper; missingTags: string[] }> {
  const { papers, reviewers, eligible, organizations, residualCapacities, forced, blockedOrgsByPaper } = args
  const out: Array<{ paper: Paper; missingTags: string[] }> = []
  for (let i = 0; i < papers.length; i++) {
    const required = papers[i].mustCoverTags ?? []
    if (required.length === 0) continue
    const missing: string[] = []
    for (const tag of required) {
      // 预指派命中：该主题已被固定覆盖
      const forcedHits = [...forced.forcedByPaperIndex[i]].some(
        (j) => matchedTagsOf(papers[i], reviewers[j]).some((t) => tagKey(t) === tagKey(tag))
      )
      if (forcedHits) continue
      // 自由可选命中者：无冲突、未预占、剩余容量 > 0、机构未封禁且同机构只计一人
      let coverable = false
      const countedOrgs = new Set<string>()
      for (let j = 0; j < reviewers.length; j++) {
        if (!eligible[i][j]) continue
        if (forced.forcedByPaperIndex[i].has(j)) continue
        if (residualCapacities[j] <= 0) continue
        const hit = matchedTagsOf(papers[i], reviewers[j]).some((t) => tagKey(t) === tagKey(tag))
        if (!hit) continue
        const org = organizations[j]
        if (org) {
          if (blockedOrgsByPaper[i].has(org) || countedOrgs.has(org)) continue
          countedOrgs.add(org)
        }
        coverable = true
        break
      }
      if (!coverable) missing.push(tag)
    }
    if (missing.length > 0) out.push({ paper: papers[i], missingTags: missing })
  }
  return out
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
  // 必覆盖主题（归一化时已保证是稿件标签的子集）
  const requiredTopics = papers.map((p) => p.mustCoverTags ?? [])
  const hasCoverageConstraints = requiredTopics.some((list) => list.length > 0)

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
    requiredTopics,
    hasCoverageConstraints
  })

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

  // ---- 必覆盖主题结构性预检：单稿视角下已无任何评审人可命中的主题（无论整体如何调配都无法覆盖） ----
  const structuralCoverageFailures = hasCoverageConstraints
    ? findStructurallyUncoverableTopics({
        papers,
        reviewers,
        eligible,
        organizations,
        residualCapacities,
        forced,
        blockedOrgsByPaper
      })
    : []
  const structuralCoverageReason: InfeasibleReason | null =
    structuralCoverageFailures.length > 0
      ? {
          kind: 'topic-coverage',
          paperIds: structuralCoverageFailures.map((x) => x.paper.id),
          missingCoverage: structuralCoverageFailures.map((x) => ({
            paperId: x.paper.id,
            paperTitle: x.paper.title,
            missingTags: x.missingTags
          })),
          message: buildCoverageFailureMessage(
            structuralCoverageFailures.map((x) => ({ title: x.paper.title, missingTags: x.missingTags })),
            true
          )
        }
      : null

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
  // ---- 最大流可行性检验（残量视角，不含必覆盖主题）----
  // 预指派边视为已固定发送的流量：网络中只保留“自由”边（非预指派），
  // 源→稿件容量为剩余需求，评审人→汇容量为剩余容量（容量−预占），
  // 并在“论文→机构”层封禁已被预指派占住的机构名额（同一稿件每机构至多一人）。
  const residualInput = buildResidualFeasibilityInput(emptyEval([]))
  const feas = checkFeasibility(residualInput)

  if (!feas.feasible && reasons.length === 0 && perPaperFailures.length === 0 && structuralCoverageReason === null) {    // 组合性瓶颈（广义 Hall 条件违反）：
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

  // ---- 必覆盖主题联合判定（仅在不含覆盖约束以外的硬约束均通过时才有意义）----
  // 残量最大流只保证人数/容量/机构/冲突可行；必覆盖主题是“每篇每主题 ≥1 名命中评审人”的
  // 下界型硬约束，用与正式优化同一套 ILP 精确判定：
  //  - hard：把覆盖行作为 min 1 约束，不可行即整体停止；
  //  - 不可行时再跑 soft 见证（最大化被满足的必覆盖主题数，无 min 约束，恒可行），
  //    由见证解指出哪些稿件的哪些主题无法与其他约束同时满足。
  let coverageFeasible = true
  let coverageReason: InfeasibleReason | null = null
  if (hasCoverageConstraints) {
    if (!feas.feasible) {
      // 人数/容量/机构层面已不可行：只附带结构性必覆盖缺口（若有），其余以容量类原因为准
      coverageFeasible = false
      coverageReason = structuralCoverageReason
    } else {
      const hard = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, null, forced, [], requiredTopics, 'hard')
      if (!hard.feasible) {
        coverageFeasible = false
        // soft 见证：容量/人数/机构/预指派行保持不变（最大流已证明该体系可行），
        // 仅去掉覆盖下界、改为最大化被满足的主题数，因此恒能返回一个完整分派作为见证。
        const soft = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, null, forced, [], requiredTopics, 'soft')
        const witnessItems = parseSolution(papers, reviewers, eligible, soft.raw, forced)
        const witnessMissing: Array<{ paperId: string; title: string; missingTags: string[] }> = []
        for (let i = 0; i < papers.length; i++) {
          const required = requiredTopics[i]
          if (required.length === 0) continue
          const assigned = witnessItems
            .filter((a) => a.paperId === papers[i].id)
            .map((a) => reviewers[forced.reviewerIndex.get(a.reviewerId)!])
          const cov = coverageOfNormalized(papers[i], assigned)
          if (cov.missingTags.length > 0) {
            witnessMissing.push({ paperId: papers[i].id, title: papers[i].title, missingTags: cov.missingTags })
          }
        }
        // soft 见证下仍缺失的主题必然无法与其他全部硬约束同时满足；
        // 若见证解恰好全部覆盖（理论上 hard 不可行时不应出现），退回结构性预检结果。
        const detail =
          witnessMissing.length > 0
            ? witnessMissing
            : structuralCoverageFailures.map((x) => ({ paperId: x.paper.id, title: x.paper.title, missingTags: x.missingTags }))
        coverageReason = {
          kind: 'topic-coverage',
          paperIds: detail.map((x) => x.paperId),
          missingCoverage: detail.map((x) => ({
            paperId: x.paperId,
            paperTitle: x.title,
            missingTags: x.missingTags
          })),
          message: buildCoverageFailureMessage(
            detail.map((x) => ({ title: x.title, missingTags: x.missingTags })),
            false
          )
        }
      }
    }
  }

  const feasible = feas.feasible && coverageFeasible
  const failureReasons: InfeasibleReason[] = []
  if (!feasible) {
    failureReasons.push(...perPaperFailures, ...reasons)
    if (coverageReason) failureReasons.unshift(coverageReason)
  }

  return {
    feasible,
    reasons: failureReasons,
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
    requiredTopics,
    hasCoverageConstraints
  }
}

/** 组装“必覆盖主题无法满足”的不可行原因文案（逐稿列出缺失主题） */
function buildCoverageFailureMessage(
  detail: Array<{ title: string; missingTags: string[] }>,
  structural: boolean
): string {
  const lines = detail.map(
    (x) => `  · 《${x.title}》缺失必覆盖主题：${x.missingTags.map((t) => `「${t}」`).join('、')}`
  )
  return (
    (structural
      ? '以下稿件的“必覆盖主题”中存在完全没有评审人可以命中的主题（已计入利益冲突回避、机构去重、容量与预指派占用）：\n'
      : '在同时满足预指派、利益冲突、容量、每篇人数、机构去重与备选差异等全部硬约束的前提下，无法覆盖以下稿件的全部必覆盖主题（整体停止，不生成任何方案）：\n') +
    lines.join('\n') +
    `\n请为这些稿件补充擅长相应主题的评审人、解除利益冲突、调整预指派，或在稿件编辑区移除相应必覆盖主题后重试。`
  )
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
 *  6. 必覆盖主题：每篇稿件勾选的必覆盖主题，必须被该稿件全部分派评审人命中标签的并集覆盖
 *     （候选仅限该稿件已有标签；未勾选时无此约束）。与备选方案多样性切割共同求解。
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

  // ---- 硬约束可行：用整数规划做目标优化（预指派关系作为强制变量、必覆盖主题作为下界约束） ----
  // 单方案模式不带多样性切割，预检已保证可行，optimize 不会返回 null
  return optimize(
    hc.papers,
    hc.reviewers,
    hc.eligible,
    hc.organizations,
    hc.demands,
    hc.totalRequired,
    hc.forced,
    [],
    hc.requiredTopics
  )!
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

  const { papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics } = hc

  // 第 1 个方案：现有字典序最优
  const first = optimize(papers, reviewers, eligible, organizations, demands, totalRequired, forced, [], requiredTopics)
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
    const candidate = optimize(papers, reviewers, eligible, organizations, demands, totalRequired, forced, cuts, requiredTopics)
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
 * 必覆盖主题求解模式：
 *  - hard：每个（稿件 i，必覆盖主题 t）施加 Σ_{命中 t 的 x[i][j]} ≥ 1 的硬约束；
 *    objective 仍为主题匹配数，用于正式优化与可行性联合判定。
 *  - soft：不施加强制下界，改为为每个（i,t）引入 0/1 变量 y[i][t]，
 *    令 y ≤ Σ 命中 x 并最大化 Σ y（即最大化被满足的必覆盖主题数）。
 *    恒可行（容量/人数等其余约束已由最大流保证），用于在 hard 不可行时产出
 *    “最多能满足多少主题”的见证解，逐稿指出无法覆盖的缺失主题。
 */
type CoverageMode = 'none' | 'hard' | 'soft'

/**
 * 阶段模型：在“每位评审人负载 ≤ capLimit（缺省取自身容量）”下最大化主题匹配数。
 *
 * 约束矩阵是带容量二部图（b-匹配 / 运输问题）的节点-关联阵，全幺模：
 * LP 松弛的顶点解天然为整数，javascript-lp-solver 无需真正分支即可快速求得 0/1 最优解。
 * 机构去重以“每（稿件,非空机构）Σ x ≤ 1”的行约束加入（机构成员节点-关联阵依旧全幺模）；
 * 空机构不生成此类约束，因此空值仅代表本人。
 *
 * 必覆盖主题（requiredTopics[i]）：
 *  - hard 模式下为每个（i,t）加 Σ_{j 命中 t} x[i][j] ≥ 1 的下界行，与预指派/容量/机构共同求解；
 *  - soft 模式下引入 0/1 变量 y[i][t]，以 y[i][t] ≤ Σ 命中 x 约束其“被覆盖才取 1”，目标改为最大化 Σ y。
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
  requiredTopics: string[][] = [],
  coverageMode: CoverageMode = 'none'
): PhaseSolution {
  const P = papers.length
  const R = reviewers.length

  // 预计算每个（i,t）命中主题的评审人下标集合（大小写不敏感）
  const coverHits: Set<number>[][] = papers.map((paper, i) =>
    (requiredTopics[i] ?? []).map((tag) => {
      const s = new Set<number>()
      for (let j = 0; j < R; j++) {
        if (eligible[i][j] && matchedTagsOf(paper, reviewers[j]).some((t) => tagKey(t) === tagKey(tag))) s.add(j)
      }
      return s
    })
  )

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
  // 必覆盖主题：
  //  hard → coverrow 为 min 1 的下界行：该稿件命中该主题的分派数至少 1；
  //  soft → coverrow 为 y 变量的上界承载行（Σ 命中 x − y ≥ 0），y 取 1 必须至少有一条命中分派。
  const coverVarNames: string[] = []
  if (coverageMode === 'hard') {
    for (let i = 0; i < P; i++) {
      coverHits[i].forEach((_, ti) => {
        model.constraints[`cover_${i}_${ti}`] = { min: 1 }
      })
    }
  } else if (coverageMode === 'soft') {
    for (let i = 0; i < P; i++) {
      coverHits[i].forEach((_, ti) => {
        // Σ 命中 x − y ≥ 0
        model.constraints[`cover_${i}_${ti}`] = { min: 0 }
        const yName = `y_${i}_${ti}`
        coverVarNames.push(yName)
        model.binaries[yName] = 1
        model.variables[yName] = { [`cover_${i}_${ti}`]: -1, objective: 1 }
      })
    }
  }

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue // 冲突对不生成变量 —— 硬约束：利益冲突
      const varName = `x_${i}_${j}`
      const matched = matchedTagsOf(papers[i], reviewers[j]).length > 0
      // soft 见证只追求“覆盖主题数”，x 不再计入 objective（避免与覆盖目标混淆）
      const objectiveCoef = coverageMode === 'soft' ? 0 : matched ? 1 : 0
      model.binaries[varName] = 1
      model.variables[varName] = {
        [`paper_${i}`]: 1,
        [`reviewer_${j}`]: 1,
        objective: objectiveCoef
      }
      if (forced.forcedKeys.has(`${i}_${j}`)) {
        model.variables[varName][`pre_${i}_${j}`] = 1
      }
      if (organizations[j]) {
        model.variables[varName][`org_${i}_${organizations[j]}`] = 1
      }
      // 必覆盖主题行：仅当该评审人命中该稿件该主题时系数为 1
      if (coverageMode === 'hard' || coverageMode === 'soft') {
        coverHits[i].forEach((hitJs, ti) => {
          if (hitJs.has(j)) model.variables[varName][`cover_${i}_${ti}`] = 1
        })
      }
      // 多样性切割行：仅在旧方案中出现的变量系数为 1
      cuts.forEach((cut, ci) => {
        if (cut.keys.has(`${i}_${j}`)) model.variables[varName][`cut_${ci}`] = 1
      })
    }
  }

  const res = solver.Solve(model as never) as Record<string, number | boolean>

  // 以实际取到 1 的 x 变量数为准判定可行性（兼容求解器对 infeasible 返回 -0 的行为）
  let chosen = 0
  for (const v of Object.keys(model.variables)) {
    if (v.startsWith('x_') && Math.round((res[v] as number) ?? 0) === 1) chosen++
  }
  const feasible = chosen === totalRequired && res.feasible !== false
  if (coverageMode === 'soft') {
    // 见证目标值 = 被满足的必覆盖主题数
    const covered = coverVarNames.reduce((n, y) => n + Math.round((res[y] as number) ?? 0), 0)
    return { feasible, matches: feasible ? covered : 0, raw: res as unknown as Record<string, number> }
  }
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

  // 逐稿必覆盖主题覆盖明细（无必覆盖主题时为 satisfied=true 的空明细）
  const reviewerIndex = new Map(reviewers.map((r) => [r.id, r]))
  const coverageByPaper: PaperCoverage[] = papers.map((p) => {
    const assignedReviewers = assignments
      .filter((a) => a.paperId === p.id)
      .map((a) => reviewerIndex.get(a.reviewerId)!)
      .filter(Boolean)
    return coverageOfNormalized(p, assignedReviewers)
  })

  return {
    feasible: true,
    assignments: [...assignments].sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId)),
    loads,
    coverageByPaper,
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
  cuts: DiversityCut[] = [],
  requiredTopics: string[][] = []
): AssignmentSuccess | null {
  const R = reviewers.length
  const hasCuts = cuts.length > 0
  const coverageMode: CoverageMode = requiredTopics.some((list) => list.length > 0) ? 'hard' : 'none'

  // 阶段一：真实容量下最大化主题匹配数（预指派变量固定为 1、必覆盖主题下界生效），得到最优匹配数 M*
  const phase1 = runPhase(
    papers,
    reviewers,
    eligible,
    organizations,
    demands,
    totalRequired,
    null,
    forced,
    cuts,
    requiredTopics,
    coverageMode
  )

  // 无切割时：理论上预检（含必覆盖主题）已保证可行，求解器异常可退回覆盖感知贪心解；
  // 带多样性切割时“不可行”是停止找备选的正常信号，且贪心不保证满足切割，只能返回 null。
  if (!phase1.feasible) {
    return hasCuts
      ? null
      : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics)
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
    const r = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, mid, forced, cuts, requiredTopics, coverageMode)
    if (r.feasible && r.matches === bestMatches) {
      hi = mid
      bestRaw = r.raw
    } else {
      lo = mid + 1
    }
  }

  const assignments = parseSolution(papers, reviewers, eligible, bestRaw, forced)
  if (assignments.length !== totalRequired) {
    return hasCuts
      ? null
      : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics)
  }
  // 防御性校验：求解结果必须完整包含全部预指派
  for (const key of forced.forcedKeys) {
    const [i, j] = key.split('_').map(Number)
    if (!assignments.some((a) => a.paperId === papers[i].id && a.reviewerId === reviewers[j].id)) {
      return hasCuts
        ? null
        : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics)
    }
  }
  // 防御性校验：同一篇稿件不得出现同一机构两人（机构去重硬约束，空机构除外）
  if (hasDuplicateOrganization(papers, reviewers, assignments)) {
    return hasCuts
      ? null
      : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics)
  }
  // 防御性校验：每篇稿件的必覆盖主题必须全部命中（硬约束）
  if (!coverageSatisfied(papers, reviewers, assignments)) {
    return hasCuts
      ? null
      : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced, requiredTopics)
  }
  return buildSuccess(papers, reviewers, assignments, totalRequired)
}

/** 结果层必覆盖主题复核：逐稿检查命中标签并集是否覆盖全部必覆盖主题 */
function coverageSatisfied(papers: Paper[], reviewers: Reviewer[], assignments: AssignmentItem[]): boolean {
  const reviewerById = new Map(reviewers.map((r) => [r.id, r]))
  return papers.every((p) => {
    const required = p.mustCoverTags ?? []
    if (required.length === 0) return true
    const union = new Set<string>()
    for (const a of assignments) {
      if (a.paperId !== p.id) continue
      const r = reviewerById.get(a.reviewerId)
      if (!r) continue
      for (const t of matchedTagsOf(p, r)) union.add(tagKey(t))
    }
    return required.every((t) => union.has(tagKey(t)))
  })
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
 * 求解器异常时的兜底：先放入全部预指派，再按主题匹配优先、当前负载最低贪心选取
 *（预检已保证存在可行解；在必覆盖主题场景下额外优先挑选能补上未覆盖主题的候选）。
 */
function greedyFallback(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  requiredTopics: string[][] = []
): AssignmentSuccess {
  const assigned = new Map<string, number>(reviewers.map((r) => [r.id, 0]))
  const assignments: AssignmentItem[] = []
  const placed = new Set<string>()
  // 每篇稿件已占住的非空机构（预指派先行占位，自由选取不得再选同机构者）
  const usedOrgsByPaper = papers.map(() => new Set<string>())
  // 每篇稿件已被命中标签覆盖的必覆盖主题（小写键）
  const coveredTopicKeysByPaper = papers.map((p, i) => {
    const s = new Set<string>()
    for (const j of forced.forcedByPaperIndex[i]) {
      for (const t of matchedTagsOf(p, reviewers[j])) s.add(tagKey(t))
    }
    return s
  })

  // 预指派先无条件占位（预检已保证其不冲突、不超额、无同稿重复机构）
  for (let i = 0; i < papers.length; i++) {
    for (const j of forced.forcedByPaperIndex[i]) {
      const matched = matchedTagsOf(papers[i], reviewers[j])
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: true
      })
      assigned.set(reviewers[j].id, (assigned.get(reviewers[j].id) ?? 0) + 1)
      placed.add(`${i}_${j}`)
      if (organizations[j]) usedOrgsByPaper[i].add(organizations[j])
    }
  }

  const ordered = [...papers].sort((a, b) => {
    // 必覆盖主题尚未补齐更多的稿件优先处理
    const remainA = (requiredTopics[papers.indexOf(a)] ?? []).filter(
      (t) => !coveredTopicKeysByPaper[papers.indexOf(a)].has(tagKey(t))
    ).length
    const remainB = (requiredTopics[papers.indexOf(b)] ?? []).filter(
      (t) => !coveredTopicKeysByPaper[papers.indexOf(b)].has(tagKey(t))
    ).length
    if (remainB !== remainA) return remainB - remainA
    return b.reviewsRequired - a.reviewsRequired
  })
  for (const paper of ordered) {
    const i = papers.indexOf(paper)
    const need = demands[i] - forced.forcedByPaperIndex[i].size
    // 逐个名额贪心：每个名额优先补上当前仍缺失的必覆盖主题
    for (let k = 0; k < need; k++) {
      const remainingRequired = (requiredTopics[i] ?? []).filter(
        (t) => !coveredTopicKeysByPaper[i].has(tagKey(t))
      )
      const choices = reviewers
        .map((r, j) => {
          const matched = matchedTagsOf(paper, r)
          // 该候选能补上几个当前仍缺失的必覆盖主题
          const coverGain = remainingRequired.reduce(
            (n, t) => n + (matched.some((mt) => tagKey(mt) === tagKey(t)) ? 1 : 0),
            0
          )
          return { r, j, matched, coverGain }
        })
        // 机构去重 + 不重复 + 无冲突；剩余容量 > 0
        .filter(
          ({ j }) =>
            eligible[i][j] &&
            !placed.has(`${i}_${j}`) &&
            !(organizations[j] && usedOrgsByPaper[i].has(organizations[j])) &&
            (assigned.get(reviewers[j].id) ?? 0) < reviewers[j].capacity
        )
        .sort((a, b) => {
          // 先比必覆盖主题补位数，再比主题匹配，最后比当前负载
          if (b.coverGain !== a.coverGain) return b.coverGain - a.coverGain
          if ((a.matched.length > 0 ? 1 : 0) !== (b.matched.length > 0 ? 1 : 0)) return b.matched.length - a.matched.length
          return (assigned.get(a.r.id) ?? 0) - (assigned.get(b.r.id) ?? 0)
        })
      const pick = choices[0]
      if (!pick) break
      assigned.set(pick.r.id, (assigned.get(pick.r.id) ?? 0) + 1)
      placed.add(`${i}_${pick.j}`)
      if (organizations[pick.j]) usedOrgsByPaper[i].add(organizations[pick.j])
      for (const t of pick.matched) coveredTopicKeysByPaper[i].add(tagKey(t))
      assignments.push({
        paperId: paper.id,
        reviewerId: pick.r.id,
        topicMatched: pick.matched.length > 0,
        matchedTags: pick.matched
      })
    }
  }

  return buildSuccess(papers, reviewers, assignments, totalRequired)
}
