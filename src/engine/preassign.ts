/**
 * 预指派（pre-assignment）关系的校验与派生状态。
 *
 * 预指派是“生成分派”时必须满足的硬约束：给定的（稿件，评审人）对必须出现在最终分派中，
 * 与利益冲突、单人容量、每篇人数、同人不重复规则共同求解。
 *
 * 本模块只做预检与状态派生，不做目标优化：
 *  - {@link validatePreAssignments} 逐条检查引用是否存在、是否含利益冲突、
 *    同篇预指派是否出现重复机构（机构去重硬约束：同一非空机构在同一稿件上至多一人，空机构仅代表本人）、
 *    同篇预指派是否超过名额、单人预占是否超过容量。
 *    任一问题都会让“生成分派”整体失败（不得生成部分结果），问题按条列出具体稿件、评审人、原因。
 *  - {@link derivePreAssignments} 供录入界面使用：把关系分为“有效”与“失效”两组，
 *    失效关系（引用的稿件/评审人已删除或已产生冲突等）保留在存储中并显式提示，用户可逐条移除。
 */
import type {
  AppData,
  Paper,
  PreAssignment,
  PreAssignmentIssue,
  Reviewer
} from '../types'

/** 去空白/去重后的关系列表（容忍历史脏数据），保持原顺序 */
export function dedupePreAssignments(list: PreAssignment[]): PreAssignment[] {
  const seen = new Set<string>()
  const out: PreAssignment[] = []
  for (const pa of list) {
    if (!pa || typeof pa.id !== 'string' || typeof pa.paperId !== 'string' || typeof pa.reviewerId !== 'string') continue
    const key = `${pa.paperId}|${pa.reviewerId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pa)
  }
  return out
}

export type PreIssueReason = PreAssignmentIssue['reason']

/**
 * 逐条校验预指派关系。返回的 issues 与输入顺序一致；无问题时返回空数组。
 * 同一条关系可能同时命中多个问题（例如稿件不存在时无法再判断冲突），按以下优先级报首个原因：
 * paper-missing / reviewer-missing → conflict → organization-duplicate → 名额/容量超限（后两者按“组”聚合到每条关系上）。
 */
export function validatePreAssignments(
  papers: Paper[],
  reviewers: Reviewer[],
  preAssignments: PreAssignment[]
): PreAssignmentIssue[] {
  const paperMap = new Map(papers.map((p) => [p.id, p]))
  const reviewerMap = new Map(reviewers.map((r) => [r.id, r]))
  const orgOf = (r: Reviewer | undefined): string => (r?.organization ?? '').trim()

  // 组级计数：只统计“引用都存在”的关系
  const perPaper = new Map<string, PreAssignment[]>()
  const perReviewer = new Map<string, PreAssignment[]>()
  for (const pa of preAssignments) {
    if (paperMap.has(pa.paperId) && reviewerMap.has(pa.reviewerId)) {
      perPaper.set(pa.paperId, [...(perPaper.get(pa.paperId) ?? []), pa])
      perReviewer.set(pa.reviewerId, [...(perReviewer.get(pa.reviewerId) ?? []), pa])
    }
  }
  const overflowPapers = new Set(
    [...perPaper.entries()].filter(([pid, list]) => list.length > (paperMap.get(pid)!.reviewsRequired || 0)).map(([pid]) => pid)
  )
  const overloadedReviewers = new Set(
    [...perReviewer.entries()].filter(([rid, list]) => list.length > (reviewerMap.get(rid)!.capacity || 0)).map(([rid]) => rid)
  )

  // 机构去重组：同一稿件 + 同一非空机构出现 ≥2 条预指派即构成硬冲突。
  // 空机构仅代表评审人本人，不与任何其他空值/非空值合并。
  const orgDupKeys = new Set<string>()
  const orgGroups = new Map<string, PreAssignment[]>()
  for (const pa of preAssignments) {
    const paper = paperMap.get(pa.paperId)
    const reviewer = reviewerMap.get(pa.reviewerId)
    const org = orgOf(reviewer)
    if (!paper || !reviewer || !org) continue
    if (reviewer.conflictPaperIds.includes(paper.id)) continue // 已按 conflict 报告的关系不再计入机构重复
    const key = `${pa.paperId}|${org}`
    orgGroups.set(key, [...(orgGroups.get(key) ?? []), pa])
  }
  for (const [key, list] of orgGroups) {
    if (list.length >= 2) orgDupKeys.add(key)
  }

  const issues: PreAssignmentIssue[] = []
  for (const pa of preAssignments) {
    const paper = paperMap.get(pa.paperId)
    const reviewer = reviewerMap.get(pa.reviewerId)

    if (!paper) {
      issues.push({
        preAssignmentId: pa.id,
        paperId: pa.paperId,
        reviewerId: pa.reviewerId,
        reviewerName: reviewer?.name,
        reason: 'paper-missing',
        message: reviewer
          ? `预指派关系（稿件 id ${pa.paperId} → ${reviewer.name}）引用的稿件已不存在，请移除该关系或恢复稿件。`
          : `预指派关系（稿件 id ${pa.paperId} → 评审人 id ${pa.reviewerId}）引用的稿件已不存在，请移除该关系。`
      })
      continue
    }
    if (!reviewer) {
      issues.push({
        preAssignmentId: pa.id,
        paperId: pa.paperId,
        reviewerId: pa.reviewerId,
        paperTitle: paper.title,
        reason: 'reviewer-missing',
        message: `预指派关系（《${paper.title}》 → 评审人 id ${pa.reviewerId}）引用的评审人已不存在，请移除该关系或恢复评审人。`
      })
      continue
    }
    if (reviewer.conflictPaperIds.includes(paper.id)) {
      issues.push({
        preAssignmentId: pa.id,
        paperId: paper.id,
        reviewerId: reviewer.id,
        paperTitle: paper.title,
        reviewerName: reviewer.name,
        reason: 'conflict',
        message: `预指派要求把《${paper.title}》分给 ${reviewer.name}，但 ${reviewer.name} 已声明与该稿件存在利益冲突：两条硬约束无法同时满足，请解除冲突或移除该预指派。`
      })
      continue
    }
    const org = orgOf(reviewer)
    const orgKey = org ? `${pa.paperId}|${org}` : ''
    if (org && orgDupKeys.has(orgKey)) {
      const group = orgGroups.get(orgKey)!
      const others = group
        .filter((x) => x.id !== pa.id)
        .map((x) => reviewerMap.get(x.reviewerId)?.name ?? x.reviewerId)
      const allNames = group.map((x) => reviewerMap.get(x.reviewerId)?.name ?? x.reviewerId)
      issues.push({
        preAssignmentId: pa.id,
        paperId: paper.id,
        reviewerId: reviewer.id,
        paperTitle: paper.title,
        reviewerName: reviewer.name,
        organization: org,
        organizationReviewerNames: allNames,
        reason: 'organization-duplicate',
        message:
          `预指派让同一篇《${paper.title}》出现机构重复：${allNames.join('、')} 同属机构「${org}」，` +
          `而每篇稿件至多选择该机构一人（空机构除外）。请移除其中多余的预指派（与 ${reviewer.name} 冲突的是 ${others.join('、')}）。`
      })
      continue
    }
    if (overflowPapers.has(paper.id)) {
      const list = perPaper.get(paper.id)!
      issues.push({
        preAssignmentId: pa.id,
        paperId: paper.id,
        reviewerId: reviewer.id,
        paperTitle: paper.title,
        reviewerName: reviewer.name,
        reason: 'paper-overflow',
        message: `《${paper.title}》仅需 ${paper.reviewsRequired} 位评审人，但为其指定了 ${list.length} 条预指派（超出 ${list.length - paper.reviewsRequired}）：预指派人数不得超过稿件名额。`
      })
      continue
    }
    if (overloadedReviewers.has(reviewer.id)) {
      const list = perReviewer.get(reviewer.id)!
      issues.push({
        preAssignmentId: pa.id,
        paperId: paper.id,
        reviewerId: reviewer.id,
        paperTitle: paper.title,
        reviewerName: reviewer.name,
        reason: 'reviewer-overload',
        message: `${reviewer.name} 的容量为 ${reviewer.capacity}，但被 ${list.length} 条预指派提前占用（超出 ${list.length - reviewer.capacity}）：单人预占名额不得超过容量。`
      })
    }
  }
  return issues
}

/** 预指派矩阵：forced[i] 为归一化后第 i 篇稿件必须分派的评审人局部下标集合 */
export interface ForcedMatrix {
  /** forced[i] 里的每个 j 都是 eligible[i][j] === true */
  forcedByPaperIndex: Set<number>[]
  /** 以 "i_j" 为键的集合，供 ILP 建模与结果标注快速查询 */
  forcedKeys: Set<string>
  /** 全局 id → 局部下标 */
  paperIndex: Map<string, number>
  reviewerIndex: Map<string, number>
}

/** 由“引用都存在且无冲突”的有效预指派构建下标矩阵（输入应为归一化后的有效数据） */
export function buildForcedMatrix(
  papers: Paper[],
  reviewers: Reviewer[],
  preAssignments: PreAssignment[],
  eligible: boolean[][]
): ForcedMatrix {
  const paperIndex = new Map(papers.map((p, i) => [p.id, i]))
  const reviewerIndex = new Map(reviewers.map((r, j) => [r.id, j]))
  const forcedByPaperIndex = papers.map(() => new Set<number>())
  const forcedKeys = new Set<string>()
  for (const pa of dedupePreAssignments(preAssignments)) {
    const i = paperIndex.get(pa.paperId)
    const j = reviewerIndex.get(pa.reviewerId)
    if (i === undefined || j === undefined) continue
    if (!eligible[i][j]) continue // 预检已拦截冲突；此处防御性跳过
    forcedByPaperIndex[i].add(j)
    forcedKeys.add(`${i}_${j}`)
  }
  return { forcedByPaperIndex, forcedKeys, paperIndex, reviewerIndex }
}

export interface DerivedPreAssignment {
  raw: PreAssignment
  paper?: Paper
  reviewer?: Reviewer
  /** 有效：稿件与评审人均存在、无利益冲突，且未超出稿件名额/评审人容量 */
  valid: boolean
  /** 失效/超额原因（valid 时缺省） */
  issue?: PreAssignmentIssue
}

/**
 * 录入界面用：把全部存储中的关系（含历史失效关系）逐条派生为可展示状态。
 * 失效关系不会被静默删除，由界面显式提示并支持逐条移除。
 */
export function derivePreAssignments(data: AppData): DerivedPreAssignment[] {
  const list = dedupePreAssignments(data.preAssignments ?? [])
  const issues = validatePreAssignments(data.papers, data.reviewers, list)
  const issueByPaId = new Map(issues.map((x) => [x.preAssignmentId, x]))
  return list.map((raw) => ({
    raw,
    paper: data.papers.find((p) => p.id === raw.paperId),
    reviewer: data.reviewers.find((r) => r.id === raw.reviewerId),
    valid: !issueByPaId.has(raw.id),
    issue: issueByPaId.get(raw.id)
  }))
}
