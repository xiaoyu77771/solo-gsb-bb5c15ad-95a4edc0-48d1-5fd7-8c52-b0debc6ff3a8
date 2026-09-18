/**
 * 评审人缺席压力测试。
 *
 * 仅在当前录入数据本身满足全部硬约束（可生成方案）时运行：
 * 对每一位容量 > 0 的评审人，分别模拟其“完全缺席”（容量临时置 0，不修改录入数据），
 * 再调用 {@link evaluateHardConstraints} —— 与“生成分派”完全相同的硬约束可行性逻辑
 * （利益冲突 / 容量 / 人数 / 机构去重，含“论文→机构→评审人”层的 Dinic 最大流 + 最小割瓶颈定位）—— 重新判定。
 *
 * 不可行的场景不止报告“总容量不足”，还给出：
 *  - 缺席者；
 *  - 受影响稿件（广义 Hall 缺陷稿件组，逐稿列出需求、剩余可选评审人数、单篇缺口）；
 *  - 名额缺口（Hall 紧见证缺口 + 全局剩余容量缺口两个口径）；
 *  - 可选评审人瓶颈（Hall 见证评审人集合及其对该稿件组至多能承担的名额）。
 */
import { checkFeasibility, orgAwareCapacityForPaperGroup } from './maxflow'
import {
  buildResidualFeasibilityInput,
  effectiveFreeReviewerCount,
  evaluateHardConstraints,
  type HardConstraintEvaluation
} from './solver'
import type {
  AppData,
  Reviewer,
  StressAffectedPaper,
  StressBottleneckReviewer,
  StressScenario,
  StressTestReport
} from '../types'

/**
 * 录入数据指纹：只纳入与硬约束相关的有效字段（标题/需求/标签/冲突；姓名/机构/容量）。
 * 压力测试报告保存运行时指纹，App 用它与当前指纹比对以立即标记“结果已过期”。
 * 可传入已算好的硬约束评估以复用归一化结果（避免每次按键重复跑最大流）。
 */
export function stressFingerprint(data: AppData, precomputed?: HardConstraintEvaluation): string {
  const hc = precomputed ?? evaluateHardConstraints(data)
  const papers = hc.papers
    .map((p) => `${p.id}|${p.title}|${p.reviewsRequired}|${[...p.tags].sort().join(',')}`)
    .sort()
  const reviewers = hc.reviewers
    .map(
      (r) =>
        `${r.id}|${r.name}|${r.organization}|${r.capacity}|${[...r.tags].sort().join(',')}|${[...r.conflictPaperIds].sort().join(',')}`
    )
    .sort()
  // 预指派也是硬约束：增删关系后压力测试报告同样立即过期
  const preAssignments = hc.preAssignments
    .map((pa) => `${pa.paperId}>${pa.reviewerId}`)
    .sort()
  return JSON.stringify({ papers, reviewers, preAssignments })
}

export type StressTestOutcome =
  | { runnable: true; report: StressTestReport }
  | { runnable: false; reasons: string[] }

/**
 * 运行缺席压力测试。
 *
 * 当前数据不可生成方案时不模拟（runnable: false）——缺席只会更差，
 * 此时应先按“生成分派”给出的不可行原因调整录入数据。
 */
export function runStressTest(data: AppData): StressTestOutcome {
  const baseline = evaluateHardConstraints(data)
  if (!baseline.feasible) {
    return { runnable: false, reasons: baseline.reasons.map((r) => r.message) }
  }

  const { reviewers } = baseline
  const totalRequired = baseline.totalRequired
  const totalCapacity = baseline.capacities.reduce((a, b) => a + b, 0)

  // 只对容量 > 0 的评审人模拟缺席；容量本就为 0 的评审人缺席与否没有区别
  const targets = reviewers
    .map((r, j) => ({ r, j }))
    .filter(({ r }) => r.capacity > 0)
    .sort((a, b) =>
      a.r.name.localeCompare(b.r.name, 'zh-Hans-CN') || a.r.id.localeCompare(b.r.id)
    )

  const scenarios: StressScenario[] = targets.map(({ r, j }) =>
    simulateAbsence(data, reviewers, r.id, j, totalRequired)
  )

  const infeasibleCount = scenarios.filter((s) => !s.feasible).length
  const report: StressTestReport = {
    fingerprint: stressFingerprint(data, baseline),
    runAt: new Date().toISOString(),
    testedReviewerCount: targets.length,
    totalRequired,
    totalCapacity,
    feasibleCount: scenarios.length - infeasibleCount,
    infeasibleCount,
    // 不可行的场景排在前面，便于优先查看单点风险
    scenarios: scenarios.sort((a, b) => Number(a.feasible) - Number(b.feasible))
  }
  return { runnable: true, report }
}

/** 模拟指定评审人完全缺席（容量置 0），并用既有硬约束逻辑重新判定。 */
function simulateAbsence(
  rawData: AppData,
  reviewers: Reviewer[],
  absentId: string,
  absentIndex: number,
  totalRequired: number
): StressScenario {
  const absent = reviewers[absentIndex]

  // 不修改录入数据：构造容量置 0 的临时副本（预指派关系保持不变，仍是硬约束）
  const tempData: AppData = {
    papers: rawData.papers,
    reviewers: rawData.reviewers.map((r) =>
      r.id === absentId ? { ...r, capacity: 0 } : r
    ),
    preAssignments: rawData.preAssignments ?? []
  }
  const hc = evaluateHardConstraints(tempData)
  const remainingCapacity = hc.capacities.reduce((a, b) => a + b, 0)
  const globalDeficit = Math.max(0, totalRequired - remainingCapacity)

  const base: StressScenario = {
    reviewerId: absentId,
    capacity: absent.capacity,
    feasible: hc.feasible,
    message: ''
  }

  if (hc.feasible) {
    const activeOthers = hc.reviewers.filter((_, j) => hc.capacities[j] > 0).length
    return {
      ...base,
      feasible: true,
      message:
        `若 ${absent.name} 完全缺席（其 ${absent.capacity} 个名额改由其他人承担），` +
        `其余 ${activeOthers} 位在役评审人仍可满足全部硬约束，方案仍可分配。`,
      remainingCapacity,
      globalDeficit: 0
    }
  }

  // ---- 不可行：构建结构化诊断 ----
  // 统计“可选评审人”时排除所有容量为 0 的人：缺席者容量已被临时置 0，
  // 基线中容量本就为 0 的评审人同样不能承担名额
  const activeIdx = hc.reviewers.map((_, j) => j).filter((j) => hc.capacities[j] > 0)

  // 残量网络输入：与生成分派预检同构（自由边 + 机构封禁 + 机构层容量 1）
  const residual = buildResidualFeasibilityInput(hc)

  // 1) 单篇仍可获得的名额（已固定的预指派 + 机构去重下的自由可选），不足需求者记单篇缺口。
  // 容量已被缺席置 0（剩余容量 ≤ 0）的评审人不计入可选名额。
  const perPaperShort = new Map<number, number>()
  const forcedCountOn = (i: number) => hc.forced.forcedByPaperIndex[i].size
  for (let i = 0; i < hc.papers.length; i++) {
    const freeAvail = effectiveFreeReviewerCount({
      i,
      reviewers: hc.reviewers,
      eligible: hc.eligible,
      organizations: hc.organizations,
      forcedByPaper: hc.forced.forcedByPaperIndex[i],
      blockedOrgs: hc.blockedOrgsByPaper[i],
      effectiveCapacities: hc.residualCapacities
    })
    const avail = forcedCountOn(i) + freeAvail
    if (avail < hc.demands[i]) perPaperShort.set(i, hc.demands[i] - avail)
  }

  // 2) 残量网（含机构层）源侧可达稿件集合 Z（广义 Hall 缺陷集合）。
  const flow = checkFeasibility(residual)
  const zIdx = flow.sourceReachablePapers
    .slice()
    .sort(
      (a, b) =>
        (perPaperShort.has(b) ? 1 : 0) - (perPaperShort.has(a) ? 1 : 0) ||
        hc.papers[a].title.localeCompare(hc.papers[b].title, 'zh-Hans-CN')
    )

  // 3) Hall 见证评审人集合 Y：与 Z 中任一稿件有自由边、且剩余容量 > 0（缺席者剩余容量为 0，排除）
  const yIdx: number[] = []
  for (const j of activeIdx) {
    if (residual.capacities[j] <= 0) continue
    if (zIdx.some((i) => residual.eligible[i][j])) yIdx.push(j)
  }

  // 4) 受影响稿件：逐稿给出需求 / 剩余可选名额（含预指派，机构去重口径）/ 缺口
  const affectedPapers: StressAffectedPaper[] = zIdx.map((i) => {
    const freeAvail = effectiveFreeReviewerCount({
      i,
      reviewers: hc.reviewers,
      eligible: hc.eligible,
      organizations: hc.organizations,
      forcedByPaper: hc.forced.forcedByPaperIndex[i],
      blockedOrgs: hc.blockedOrgsByPaper[i],
      effectiveCapacities: hc.residualCapacities
    })
    return {
      paperId: hc.papers[i].id,
      required: hc.demands[i],
      available: forcedCountOn(i) + freeAvail,
      shortfall: perPaperShort.get(i) ?? 0
    }
  })

  // 5) 名额缺口（Hall 紧见证）：以 Z 为左部，在“完整需求 + 全员（含预指派固定量）”的机构层网络上
  // 实测 Y 至多能承担的总名额。残量网只计自由名额，会漏掉“预指派占住缺席者/其他评审人容量”的部分，
  // 因此这里以完整容量、完整需求另跑一次同构子网络，与生成分派预检同一套机构去重规则。
  const demandZ = zIdx.reduce((a, i) => a + hc.demands[i], 0)
  const capY = orgAwareCapacityForPaperGroup(
    {
      demands: hc.demands,
      capacities: hc.capacities,
      eligible: hc.eligible,
      organizations: hc.organizations
    },
    zIdx,
    hc.demands
  )
  const bottleneckReviewers: StressBottleneckReviewer[] = yIdx
    .map((j) => {
      const eligibleCount = zIdx.reduce((n, i) => n + (residual.eligible[i][j] ? 1 : 0), 0)
      return {
        reviewerId: hc.reviewers[j].id,
        capacity: Math.max(0, residual.capacities[j]),
        eligiblePaperCount: eligibleCount,
        capacityForGroup: Math.min(Math.max(0, residual.capacities[j]), eligibleCount)
      }
    })
    .sort(
      (a, b) =>
        a.capacityForGroup - b.capacityForGroup || a.reviewerId.localeCompare(b.reviewerId)
    )
  const deficit = Math.max(0, demandZ - capY)

  // ---- 组装可读结论（不能只报总容量不足） ----
  const paperLines = affectedPapers.map((p) => {
    const paper = hc.papers.find((x) => x.id === p.paperId)!
    const tail = p.shortfall > 0 ? `，单篇缺口 ${p.shortfall}` : '（单篇可选人数够，但整体名额调不开）'
    return `《${paper.title}》需 ${p.required} 人，剩余可选评审人 ${p.available} 位${tail}`
  })
  const bottleneckLines = bottleneckReviewers.map((b) => {
    const name = hc.reviewers.find((x) => x.id === b.reviewerId)?.name ?? b.reviewerId
    return `${name}（容量 ${b.capacity}，对该组可评 ${b.eligiblePaperCount} 篇，至多承担 ${b.capacityForGroup} 个名额）`
  })

  const globalLine =
    globalDeficit > 0
      ? `缺席后剩余总容量 ${remainingCapacity} < 总需求 ${totalRequired}，全局名额缺口 ${globalDeficit}；`
      : `缺席后剩余总容量 ${remainingCapacity} 仍不少于总需求 ${totalRequired}（全局总容量够），但可选评审人范围调不开：`

  const message =
    `若 ${absent.name} 完全缺席，则无法生成可行分配。\n` +
    `${globalLine}\n` +
    `受影响稿件共 ${affectedPapers.length} 篇、合计需求 ${demandZ} 个名额：\n` +
    paperLines.map((l) => `  · ${l}`).join('\n') +
    `\n可选评审人瓶颈：${
      bottleneckLines.length
        ? `${bottleneckReviewers.length} 位可选评审人对该组稿件至多承担 ${capY} 个名额，名额缺口 ${deficit}：\n` +
          bottleneckLines.map((l) => `  · ${l}`).join('\n')
        : `该组稿件在剩余评审人中无任何无冲突可分配者，名额缺口 ${deficit}`
    }。\n` +
    `建议：为上述稿件补充评审人、解除部分利益冲突，或提高相关评审人容量。`

  return {
    ...base,
    feasible: false,
    message,
    affectedPapers,
    deficit,
    globalDeficit,
    remainingCapacity,
    bottleneckReviewers
  }
}
