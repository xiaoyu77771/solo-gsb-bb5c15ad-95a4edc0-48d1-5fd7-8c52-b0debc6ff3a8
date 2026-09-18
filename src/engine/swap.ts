/**
 * 分派互换（一换一）。
 *
 * 在一个已成功的分配结果上，选定两位均已承担任务的评审人 A、B，
 * 枚举 A 当前承担的稿件 p 与 B 当前承担的稿件 q 之间的所有互换候选：
 * 交换后 A 改评 q、B 改评 p（其余分派不变）。
 *
 * 候选必须同时满足，缺一不可：
 *  0. 被换走的两条分派都不是预指派：预指派是与冲突/容量/人数并列的硬约束，
 *     任何互换都不得把预指派评审人从其指定稿件上换走；
 *  1. 非同稿、交换后组合确实改变：p ≠ q（同稿时 A、B 互相对调，二人仍评同一篇，
 *     组合毫无变化，也会让该稿出现重复评审人，直接排除）；
 *  2. 无利益冲突：A 未声明回避 q、B 未声明回避 p；
 *  3. 不重复承担同一稿件：交换前 A 未评 q（即 q ∉ A 的现有稿件）、
 *     B 未评 p（即 p ∉ B 的现有稿件）。一换一是一对一替换，每位评审人的稿件数
 *     不变，因此「每篇稿件人数不变」与「个人容量不超限」天然保持，无需额外处理；
 *  4. 不违反机构去重：交换后 A 在 q 上的机构、B 在 p 上的机构，都不得与该稿件上
 *     其余评审人（去首尾空白后）的非空机构相同；机构为空者不受限制，空值互不合并。
 *
 * 候选按「主题匹配净增」从高到低排序，供界面预览后由用户确认；
 * 确认时仅在结果层改派，不触碰录入数据（AppData）。
 */
import { computeMatchedTags } from './solver'
import { symmetricDifferenceOfEdges } from './alternatives'
import type { AppData, AssignmentItem, AssignmentSuccess, Paper, Reviewer } from '../types'

/**
 * 备选方案多样性守卫（仅在一次生成多个方案时有值）：
 * 人工互换后当前方案与每个“其余方案”的关系对称差仍必须 ≥ minDifference。
 * otherEdgeSets 为其余方案当前的关系集合（全局 "paperId␟reviewerId" 键）。
 */
export interface DiversityGuard {
  minDifference: number
  otherEdgeSets: Set<string>[]
}

/** 单条一换一候选的交换单侧描述（谁把自己的哪篇换成对方的哪篇） */
export interface SwapSide {
  reviewerId: string
  /** 交换前该评审人承担的稿件 */
  fromPaperId: string
  /** 交换后该评审人改承担的稿件（原属对方） */
  toPaperId: string
  /** 交换前命中的标签（fromPaper × 该评审人） */
  fromMatchedTags: string[]
  /** 交换后命中的标签（toPaper × 该评审人） */
  toMatchedTags: string[]
  /** 交换前该侧是否主题匹配 */
  fromMatched: boolean
  /** 交换后该侧是否主题匹配 */
  toMatched: boolean
}

/** 一条可行的一换一候选及其交换前后变化 */
export interface SwapCandidate {
  reviewerAId: string
  reviewerBId: string
  sideA: SwapSide
  sideB: SwapSide
  /** 主题匹配数净变化 = 交换后两侧匹配数 − 交换前两侧匹配数（可正/零/负） */
  deltaMatches: number
}

/** 枚举一对评审人之间候选时被排除的计数（供界面说明“为什么候选变少”） */
export interface SwapExclusionCounts {
  /** 同稿（p === q），交换后组合不变 */
  samePaper: number
  /** 交换后触发利益冲突 */
  conflict: number
  /** 交换后某评审人会重复承担同一稿件 */
  duplicate: number
  /** 被换走的分派中有预指派（硬约束不允许互换移除预指派） */
  preassigned: number
  /** 交换后会让同一稿件出现同一机构的两位评审人（机构去重硬约束） */
  organization: number
  /** 交换后当前方案与某备选方案的差异条数会低于 N（备选模式多样性约束） */
  diversity: number
}

export interface SwapEnumeration {
  candidates: SwapCandidate[]
  excluded: SwapExclusionCounts
}

/** 当前方案应用一次互换后的关系集合（用于备选模式差异复核） */
function edgesAfterSwap(assignments: AssignmentItem[], candidate: SwapCandidate): Set<string> {
  const edges = new Set<string>()
  for (const a of assignments) {
    const movingA = a.paperId === candidate.sideA.fromPaperId && a.reviewerId === candidate.sideA.reviewerId
    const movingB = a.paperId === candidate.sideB.fromPaperId && a.reviewerId === candidate.sideB.reviewerId
    if (!movingA && !movingB) edges.add(`${a.paperId}␟${a.reviewerId}`)
  }
  edges.add(`${candidate.sideA.toPaperId}␟${candidate.sideA.reviewerId}`)
  edges.add(`${candidate.sideB.toPaperId}␟${candidate.sideB.reviewerId}`)
  return edges
}

/** 备选模式：交换后不得让当前方案与任何其余方案的差异条数低于 N */
function violatesDiversity(candidate: SwapCandidate, current: AssignmentSuccess, guard: DiversityGuard | undefined): boolean {
  if (!guard || guard.otherEdgeSets.length === 0) return false
  const nextEdges = edgesAfterSwap(current.assignments, candidate)
  return guard.otherEdgeSets.some((other) => symmetricDifferenceOfEdges(nextEdges, other) < guard.minDifference)
}

function matchInfo(paper: Paper | undefined, reviewer: Reviewer | undefined): { tags: string[]; matched: boolean } {
  if (!paper || !reviewer) return { tags: [], matched: false }
  const tags = computeMatchedTags(paper, reviewer)
  return { tags, matched: tags.length > 0 }
}

/** 评审人在当前结果中承担的全部稿件 id */
function papersOf(assignments: AssignmentItem[], reviewerId: string): Set<string> {
  return new Set(assignments.filter((a) => a.reviewerId === reviewerId).map((a) => a.paperId))
}

/** 机构规范化：去首尾空白；空串表示无机构（仅代表本人，不参与去重） */
function orgOf(reviewer: Reviewer | undefined): string {
  return (reviewer?.organization ?? '').trim()
}

/**
 * 机构去重校验：交换后 reviewerId 改评 paperId 时，该稿件在交换完成后的在位评审人中
 * 是否已有与其同（非空）机构者。该稿件上两位参与互换者（leavingReviewerIds）都将离开，
 * 均不计入；其余在位评审人同机构即冲突。
 */
function orgConflictOnPaper(
  assignments: AssignmentItem[],
  reviewerMap: Map<string, Reviewer>,
  paperId: string,
  reviewerId: string,
  leavingReviewerIds: string[]
): boolean {
  const org = orgOf(reviewerMap.get(reviewerId))
  if (!org) return false // 空机构仅代表本人，不受机构去重限制
  const leaving = new Set(leavingReviewerIds)
  return assignments.some(
    (a) =>
      a.paperId === paperId &&
      !leaving.has(a.reviewerId) &&
      orgOf(reviewerMap.get(a.reviewerId)) === org
  )
}

/**
 * 枚举两位评审人之间所有可行的一换一候选。
 * 要求两位评审人当前都至少承担一篇稿件，否则返回空列表。
 */
export function enumerateSwaps(
  data: AppData,
  result: AssignmentSuccess,
  reviewerAId: string,
  reviewerBId: string,
  guard?: DiversityGuard
): SwapEnumeration {
  const excluded: SwapExclusionCounts = { samePaper: 0, conflict: 0, duplicate: 0, preassigned: 0, organization: 0, diversity: 0 }
  if (!reviewerAId || !reviewerBId || reviewerAId === reviewerBId) {
    return { candidates: [], excluded }
  }

  const paperMap = new Map(data.papers.map((p) => [p.id, p]))
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  const reviewerA = reviewerMap.get(reviewerAId)
  const reviewerB = reviewerMap.get(reviewerBId)
  if (!reviewerA || !reviewerB) return { candidates: [], excluded }

  // A、B 当前各自承担的稿件（即“已有任务”）
  const aPapers = result.assignments.filter((a) => a.reviewerId === reviewerAId)
  const bPapers = result.assignments.filter((a) => a.reviewerId === reviewerBId)
  if (aPapers.length === 0 || bPapers.length === 0) return { candidates: [], excluded }

  // 现有承担集合，用于“交换后重复承担同一稿件”判定
  const aPaperSet = new Set(aPapers.map((a) => a.paperId))
  const bPaperSet = new Set(bPapers.map((a) => a.paperId))

  const conflictsOf = (r: Reviewer) => new Set(r.conflictPaperIds)
  const aConflicts = conflictsOf(reviewerA)
  const bConflicts = conflictsOf(reviewerB)

  const candidates: SwapCandidate[] = []

  for (const assA of aPapers) {
    const p = assA.paperId // A 现承担，交换后由 B 承担
    for (const assB of bPapers) {
      const q = assB.paperId // B 现承担，交换后由 A 承担

      // 排除项 0：预指派分派不允许被互换换走（硬约束）
      if (assA.preassigned || assB.preassigned) {
        excluded.preassigned++
        continue
      }

      // 排除项 1：同稿 → 交换后组合不变（且该稿会出现重复评审人）
      if (p === q) {
        excluded.samePaper++
        continue
      }

      // 排除项 2：交换后触发利益冲突（A 评 q、B 评 p）
      if (aConflicts.has(q) || bConflicts.has(p)) {
        excluded.conflict++
        continue
      }

      // 排除项 3：交换后同一评审人重复承担同一稿件。
      // 一换一是“拿走自己的一篇、换来对方的一篇”：若 q 本就由 A 承担，
      // 交换后 A 仍承担 q（相当于 q 没换出去却又算了一次），造成重复。
      if (aPaperSet.has(q) || bPaperSet.has(p)) {
        excluded.duplicate++
        continue
      }

      // 排除项 4：交换后违反机构去重——A 到 q、B 到 p 后，
      // 不得与该稿件交换完成后仍在位的评审人同机构（空机构不受限，空值互不合并）。
      // p 上 A、B（换入）都将处于“离开/未定”状态，q 上 B、A 同理，故两位互换者都不计入。
      if (
        orgConflictOnPaper(result.assignments, reviewerMap, q, reviewerAId, [reviewerAId, reviewerBId]) ||
        orgConflictOnPaper(result.assignments, reviewerMap, p, reviewerBId, [reviewerAId, reviewerBId])
      ) {
        excluded.organization++
        continue
      }

      const paperP = paperMap.get(p)
      const paperQ = paperMap.get(q)

      const beforeA = matchInfo(paperP, reviewerA)
      const afterA = matchInfo(paperQ, reviewerA)
      const beforeB = matchInfo(paperQ, reviewerB)
      const afterB = matchInfo(paperP, reviewerB)

      const sideA: SwapSide = {
        reviewerId: reviewerAId,
        fromPaperId: p,
        toPaperId: q,
        fromMatchedTags: beforeA.tags,
        toMatchedTags: afterA.tags,
        fromMatched: beforeA.matched,
        toMatched: afterA.matched
      }
      const sideB: SwapSide = {
        reviewerId: reviewerBId,
        fromPaperId: q,
        toPaperId: p,
        fromMatchedTags: beforeB.tags,
        toMatchedTags: afterB.tags,
        fromMatched: beforeB.matched,
        toMatched: afterB.matched
      }

      const deltaMatches =
        Number(afterA.matched) + Number(afterB.matched) - Number(beforeA.matched) - Number(beforeB.matched)

      const tentative: SwapCandidate = { reviewerAId, reviewerBId, sideA, sideB, deltaMatches }

      // 排除项 5（备选模式）：互换后当前方案与任一其余方案的差异条数会跌破 N
      if (violatesDiversity(tentative, result, guard)) {
        excluded.diversity++
        continue
      }

      candidates.push(tentative)
    }
  }

  // 按主题匹配净增从高到低；并列时交换后命中标签更多者优先，再以稿件/评审人 id 稳定排序
  candidates.sort((x, y) => {
    if (y.deltaMatches !== x.deltaMatches) return y.deltaMatches - x.deltaMatches
    const tagCount = (c: SwapCandidate) =>
      c.sideA.toMatchedTags.length + c.sideB.toMatchedTags.length
    if (tagCount(y) !== tagCount(x)) return tagCount(y) - tagCount(x)
    const key = (c: SwapCandidate) =>
      `${c.sideA.fromPaperId}|${c.sideB.fromPaperId}|${c.reviewerAId}|${c.reviewerBId}`
    return key(x).localeCompare(key(y))
  })

  return { candidates, excluded }
}

/** 重新统计负载：一换一不改变每位评审人的承担数量，但统一按交换后分派重算以防偏差。 */
function rebuildLoads(
  assignments: AssignmentItem[],
  prevLoads: AssignmentSuccess['loads']
): AssignmentSuccess['loads'] {
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  return prevLoads.map((l) => ({ ...l, assigned: counts.get(l.reviewerId) ?? 0 }))
}

/**
 * 应用一条一换一候选，返回交换后的新成功结果。
 *
 * 只更新传入的结果（其副本），不修改录入数据 data，也不修改原 result。
 * 会再次复核全部硬约束（冲突 / 不重复 / 容量），任一不满足则拒绝并返回 null，
 * 防止使用过期候选（例如数据刚变化）做出违规改派。
 */
export function applySwapCandidate(
  data: AppData,
  result: AssignmentSuccess,
  candidate: SwapCandidate,
  guard?: DiversityGuard
): AssignmentSuccess | null {
  const { sideA, sideB } = candidate
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  const paperMap = new Map(data.papers.map((p) => [p.id, p]))
  const reviewerA = reviewerMap.get(sideA.reviewerId)
  const reviewerB = reviewerMap.get(sideB.reviewerId)
  if (!reviewerA || !reviewerB) return null
  if (!paperMap.has(sideA.fromPaperId) || !paperMap.has(sideA.toPaperId)) return null

  // ---- 防御性复核：候选必须建立在当前分派之上（被交换的两条确实存在） ----
  const has = (paperId: string, reviewerId: string) =>
    result.assignments.some((a) => a.paperId === paperId && a.reviewerId === reviewerId)
  if (!has(sideA.fromPaperId, sideA.reviewerId)) return null
  if (!has(sideB.fromPaperId, sideB.reviewerId)) return null

  // 预指派硬约束：被换走的分派不得是预指派（枚举阶段已排除，此处兜底防过期候选）
  const fromA = result.assignments.find((a) => a.paperId === sideA.fromPaperId && a.reviewerId === sideA.reviewerId)
  const fromB = result.assignments.find((a) => a.paperId === sideB.fromPaperId && a.reviewerId === sideB.reviewerId)
  if (fromA?.preassigned || fromB?.preassigned) return null

  // 同稿 / 组合不变
  if (sideA.fromPaperId === sideB.fromPaperId) return null
  // 利益冲突：交换后 A 评 toPaper（= B 的 fromPaper），B 同理
  if (reviewerA.conflictPaperIds.includes(sideA.toPaperId)) return null
  if (reviewerB.conflictPaperIds.includes(sideB.toPaperId)) return null
  // 重复承担
  const aPaperSet = papersOf(result.assignments, sideA.reviewerId)
  const bPaperSet = papersOf(result.assignments, sideB.reviewerId)
  if (aPaperSet.has(sideA.toPaperId) || bPaperSet.has(sideB.toPaperId)) return null

  // 机构去重（与枚举同一规则）：换入后不得与目标稿件交换后仍在位的评审人同机构
  const reviewerMapForOrg = new Map(data.reviewers.map((r) => [r.id, r]))
  if (orgConflictOnPaper(result.assignments, reviewerMapForOrg, sideA.toPaperId, sideA.reviewerId, [sideA.reviewerId, sideB.reviewerId])) return null
  if (orgConflictOnPaper(result.assignments, reviewerMapForOrg, sideB.toPaperId, sideB.reviewerId, [sideA.reviewerId, sideB.reviewerId])) return null

  // ---- 执行改派：替换两条分派，其余保持不变 ----
  const next: AssignmentItem[] = result.assignments.map((a) => {
    if (a.paperId === sideA.fromPaperId && a.reviewerId === sideA.reviewerId) {
      const tags = computeMatchedTags(paperMap.get(sideA.toPaperId)!, reviewerA)
      return { paperId: sideA.toPaperId, reviewerId: sideA.reviewerId, topicMatched: tags.length > 0, matchedTags: tags }
    }
    if (a.paperId === sideB.fromPaperId && a.reviewerId === sideB.reviewerId) {
      const tags = computeMatchedTags(paperMap.get(sideB.toPaperId)!, reviewerB)
      return { paperId: sideB.toPaperId, reviewerId: sideB.reviewerId, topicMatched: tags.length > 0, matchedTags: tags }
    }
    return a
  })

  next.sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))

  // ---- 复核容量与每篇人数（一换一下理论不变，仍显式校验保证结果始终合法） ----
  const loads = rebuildLoads(next, result.loads)
  if (loads.some((l) => l.assigned > l.capacity)) return null

  const perPaper = new Map<string, number>()
  const perPaperReviewers = new Map<string, Set<string>>()
  for (const a of next) {
    perPaper.set(a.paperId, (perPaper.get(a.paperId) ?? 0) + 1)
    const set = perPaperReviewers.get(a.paperId) ?? new Set<string>()
    if (set.has(a.reviewerId)) return null // 同一稿件出现重复评审人
    set.add(a.reviewerId)
    perPaperReviewers.set(a.paperId, set)
  }
  for (const paper of data.papers) {
    if (paper.reviewsRequired > 0 && perPaper.get(paper.id) !== paper.reviewsRequired) return null
  }

  // 复核机构去重：同一稿件不得出现两个去空白后相同的非空机构评审人
  const orgsByPaper = new Map<string, Set<string>>()
  const reviewerMapForCheck = new Map(data.reviewers.map((r) => [r.id, r]))
  for (const a of next) {
    const org = orgOf(reviewerMapForCheck.get(a.reviewerId))
    if (!org) continue
    const set = orgsByPaper.get(a.paperId) ?? new Set<string>()
    if (set.has(org)) return null
    set.add(org)
    orgsByPaper.set(a.paperId, set)
  }

  // 备选模式兜底复核：应用互换后的关系集合与每个其余方案的差异条数仍须 ≥ N
  if (guard && guard.otherEdgeSets.length > 0) {
    const nextEdges = edgesAfterSwap(next, candidate)
    if (guard.otherEdgeSets.some((other) => symmetricDifferenceOfEdges(nextEdges, other) < guard.minDifference)) return null
  }

  const topicMatches = next.filter((a) => a.topicMatched).length
  return {
    feasible: true,
    assignments: next,
    loads,
    objective: {
      topicMatches,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: next.length,
      totalRequired: result.objective.totalRequired,
      // 互换不会触碰任何预指派条目，数量保持不变（来自旧结果，旧结果缺省时按条目重算）
      preassignedCount:
        typeof result.objective.preassignedCount === 'number'
          ? result.objective.preassignedCount
          : next.filter((a) => a.preassigned === true).length
    },
    manuallyAdjusted: true,
    swapCount: (result.swapCount ?? 0) + 1
  }
}
