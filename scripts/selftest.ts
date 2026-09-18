import { solveAssignment, solveAssignmentBatch, computeMatchedTags } from '../src/engine/solver'
import { runStressTest, stressFingerprint } from '../src/engine/stress'
import { enumerateSwaps, applySwapCandidate, type SwapCandidate } from '../src/engine/swap'
import { symmetricDifference, validateBatchOptions } from '../src/engine/alternatives'
import type { AppData, AssignmentSuccess } from '../src/types'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✕ ${name} ${extra}`)
  }
}

const mk = (
  papers: AppData['papers'],
  reviewers: AppData['reviewers'],
  preAssignments: AppData['preAssignments'] = []
): AppData => ({ papers, reviewers, preAssignments })
const P = (id: string, title: string, reviewsRequired: number, tags: string[] = []) => ({ id: id, title, reviewsRequired, tags })
const R = (
  id: string,
  name: string,
  capacity: number,
  tags: string[] = [],
  conflictPaperIds: string[] = [],
  organization = ''
) => ({
  id, name, capacity, tags, conflictPaperIds, organization
})

// 1. 示例数据：可行且匹配/均衡合理
{
  const d = mk(
    [P('p1', 'LLM微调', 2, ['机器学习', 'NLP']), P('p2', 'GNN推荐', 2, ['机器学习', '推荐系统']), P('p3', 'KV存储', 2, ['分布式系统', '数据库']), P('p4', '联邦隐私', 2, ['安全', '机器学习'])],
    [R('a', 'Alice', 2, ['机器学习', 'NLP'], ['p1']), R('b', 'Bob', 2, ['机器学习', '推荐系统']), R('c', 'Carol', 3, ['分布式系统', '数据库'], ['p3']), R('d', 'Dave', 2, ['安全', '机器学习'])]
  )
  const res = solveAssignment(d)
  console.log('用例1 示例数据')
  check('可行', res.feasible)
  if (res.feasible) {
    check('共分配 8 个名额', res.objective.totalAssigned === 8, JSON.stringify(res.objective))
    check('每篇恰好 2 人', d.papers.every((p) => res.assignments.filter((a) => a.paperId === p.id).length === 2))
    check('无人超容量', res.loads.every((l) => l.assigned <= l.capacity))
    check('冲突对从未出现', !res.assignments.some((a) => (a.paperId === 'p1' && a.reviewerId === 'a') || (a.paperId === 'p3' && a.reviewerId === 'c')))
    check('主题匹配数=4（p3 与 c 的非匹配不可避免）', res.objective.topicMatches === 4, `got ${res.objective.topicMatches}`)
    check('最大负载=2（均衡）', res.objective.maxLoad === 2, `got ${res.objective.maxLoad}`)
  } else {
    console.log('   原因:', res.reasons.map((r) => r.message).join(' | '))
  }
}

// 2. 单篇稿件可分配人数不足
{
  const d = mk(
    [P('p1', '稿件A', 3, ['X'])],
    [R('a', '甲', 2, ['X'], ['p1']), R('b', '乙', 1), R('c', '丙', 1)]
  )
  const res = solveAssignment(d)
  console.log('用例2 单篇可分配人数不足')
  check('不可行', !res.feasible)
  if (!res.feasible) check('给出 paper-eligible 原因', res.reasons.some((r) => r.kind === 'paper-eligible'), JSON.stringify(res.reasons))
}

// 3. 全局容量不足
{
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [R('a', '甲', 1), R('b', '乙', 1)]
  )
  const res = solveAssignment(d)
  console.log('用例3 全局容量不足')
  check('不可行', !res.feasible)
  if (!res.feasible) check('给出 global-capacity 原因', res.reasons.some((r) => r.kind === 'global-capacity'))
}

// 4. 组合性瓶颈：p1,p2 都只能给 a,b（容量各1，共2），但两篇各需2人
{
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [R('a', '甲', 1, [], []), R('b', '乙', 1, [], []), R('c', '丙', 5, [], ['p1', 'p2'])]
  )
  const res = solveAssignment(d)
  console.log('用例4 组合性瓶颈')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const sub = res.reasons.find((r) => r.kind === 'subset-bottleneck')
    check('给出 subset-bottleneck 原因', !!sub, JSON.stringify(res.reasons.map((r) => r.kind)))
    check('缺口=2（广义 Hall 紧见证）', sub?.deficit === 2, `got ${sub?.deficit}`)
    check('瓶颈稿件含 p1,p2', sub?.paperIds?.length === 2)
    check('可选评审人仅 a,b（不含冲突者 c）', sub?.reviewerIds?.length === 2 && !sub.reviewerIds.includes('c'))
  }
}

// 4b. 全冲突型组合瓶颈（每篇都无任何可分配评审人）
{
  const res = solveAssignment(mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 5, [], ['p1', 'p2']), R('b', '乙', 5, [], ['p1', 'p2'])]
  ))
  console.log('用例4b 全冲突')
  check('不可行', !res.feasible)
  if (!res.feasible) check('每篇均给出单篇不足原因', res.reasons.filter((r) => r.kind === 'paper-eligible').length === 2)
}

// 5. 目标优先级：匹配优先于均衡（必要时宁愿负载不均也要拿匹配）
{
  // p1 标 X：只有 a 擅长 X；p2 无标签。容量 a=2,b=2。
  const d = mk(
    [P('p1', 'A', 1, ['X']), P('p2', 'B', 1)],
    [R('a', '甲', 2, ['X']), R('b', '乙', 2, ['Y'])]
  )
  const res = solveAssignment(d)
  console.log('用例5 主题匹配优先')
  check('可行', res.feasible)
  if (res.feasible) {
    const p1a = res.assignments.find((a) => a.paperId === 'p1')
    check('p1 分给匹配者 a', p1a?.reviewerId === 'a' && p1a.topicMatched)
  }
}

// 6. 均衡第二优先：匹配数相同时摊平负载
{
  // 两篇都无标签，两位评审人容量各 2，各需 1 → 应一人一篇
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 2), R('b', '乙', 2)]
  )
  const res = solveAssignment(d)
  console.log('用例6 负载均衡')
  if (res.feasible) check('最大负载=1', res.objective.maxLoad === 1, `got ${res.objective.maxLoad}`)
}

// 7. 无评审人
{
  const res = solveAssignment(mk([P('p1', 'A', 1)], []))
  console.log('用例7 无评审人')
  check('不可行且提示', !res.feasible && res.reasons.length > 0)
}

// 8. 较大规模性能（30 稿 ×3 + 12 评审人容量 8）
{
  const papers = Array.from({ length: 30 }, (_, i) => P(`p${i}`, `稿件${i}`, 3, ['T' + (i % 6)]))
  const reviewers = Array.from({ length: 12 }, (_, j) => R(`r${j}`, `评审${j}`, 8, j < 6 ? ['T' + (j % 6)] : []))
  const t0 = Date.now()
  const res = solveAssignment(mk(papers, reviewers))
  const ms = Date.now() - t0
  console.log(`用例8 规模 30x12（${ms} ms）`)
  check('可行且 90 个名额', res.feasible && res.objective.totalAssigned === 90, JSON.stringify(res.feasible ? res.objective : res.reasons))
}

/* ============================ 缺席压力测试 ============================ */

// 9. 示例数据：总容量 9 仅比总需求 8 多 1，任何容量 ≥2 的评审人缺席都会击穿全局容量
{
  const d = mk(
    [P('p1', 'LLM微调', 2, ['机器学习', 'NLP']), P('p2', 'GNN推荐', 2, ['机器学习', '推荐系统']), P('p3', 'KV存储', 2, ['分布式系统', '数据库']), P('p4', '联邦隐私', 2, ['安全', '机器学习'])],
    [R('a', 'Alice', 2, ['机器学习', 'NLP'], ['p1']), R('b', 'Bob', 2, ['机器学习', '推荐系统']), R('c', 'Carol', 3, ['分布式系统', '数据库'], ['p3']), R('d', 'Dave', 2, ['安全', '机器学习'])]
  )
  const out = runStressTest(d)
  console.log('用例9 缺席压力测试 · 示例数据')
  check('可运行（基线可行）', out.runnable)
  if (out.runnable) {
    const rep = out.report
    check('受测 4 人', rep.testedReviewerCount === 4)
    check('汇总 0 仍可分配 / 4 不可分配（总容量仅余 1）', rep.feasibleCount === 0 && rep.infeasibleCount === 4, JSON.stringify(rep.scenarios.map((s) => [s.reviewerId, s.feasible])))
    const carol = rep.scenarios.find((s) => s.reviewerId === 'c')
    check('Carol 缺席不可行', !!carol && !carol.feasible)
    check('Carol 缺席：全局名额缺口=2', carol?.globalDeficit === 2, `got ${carol?.globalDeficit}`)
    check('Carol 缺席：剩余容量=6', carol?.remainingCapacity === 6)
    check('Carol 缺席：受影响稿件 4 篇', carol?.affectedPapers?.length === 4, `got ${carol?.affectedPapers?.length}`)
    check('Carol 缺席：瓶颈缺口=2', carol?.deficit === 2, `got ${carol?.deficit}`)
    check('Carol 缺席：可选评审人瓶颈含其余 3 人', carol?.bottleneckReviewers?.length === 3 && !carol.bottleneckReviewers.some((b) => b.reviewerId === 'c'))
    check('不可行项不止总容量：含受影响稿件与瓶颈评审人', rep.scenarios.every((s) => s.feasible || (!!s.affectedPapers?.length && !!s.bottleneckReviewers?.length)))
    check('Alice/Bob/Dave 缺席全局缺口各为 1', ['a', 'b', 'd'].every((id) => rep.scenarios.find((s) => s.reviewerId === id)?.globalDeficit === 1))
  }
}

// 10. 基线不可行时压力测试不可运行
{
  const d = mk([P('p1', 'A', 3, ['X'])], [R('a', '甲', 2, ['X'], ['p1']), R('b', '乙', 1), R('c', '丙', 1)])
  const out = runStressTest(d)
  console.log('用例10 基线不可行')
  check('runnable=false 且带回原因', !out.runnable && 'reasons' in out && out.reasons.length > 0)
}

// 11. 全局容量充足但组合性瓶颈：缺席后“不能只报总容量不足”
// 三篇各需 1；甲容量2 三篇均可评、乙容量2 三篇均可评、丙容量5 但对三篇全冲突。
// 基线可行（甲乙分担）。甲缺席 → 只剩乙（容量2）可评三篇：每篇可选人数仍够（1=需求），
// 但 Hall 缺口 1；此时剩余总容量 7 远大于需求 3，纯粹是组合性瓶颈。
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1), P('p3', 'C', 1)],
    [R('a', '甲', 2, [], []), R('b', '乙', 2, [], []), R('c', '丙', 5, [], ['p1', 'p2', 'p3'])]
  )
  const base = solveAssignment(d)
  console.log('用例11 缺席导致纯组合性瓶颈')
  check('基线可行', base.feasible, JSON.stringify(base.feasible ? '' : base.reasons))
  const out = runStressTest(d)
  if (out.runnable) {
    check('汇总：丙缺席仍可分配，甲乙缺席不可分配', out.report.feasibleCount === 1 && out.report.infeasibleCount === 2)
    const a = out.report.scenarios.find((s) => s.reviewerId === 'a')
    check('甲缺席不可行', !!a && !a.feasible)
    check('甲缺席：全局总容量仍够（globalDeficit=0）', a?.globalDeficit === 0, `got ${a?.globalDeficit}`)
    check('甲缺席：Hall 瓶颈缺口=1', a?.deficit === 1, `got ${a?.deficit}`)
    check('甲缺席：受影响稿件 3 篇且单篇缺口均为0（仅组合瓶颈）', a?.affectedPapers?.length === 3 && a.affectedPapers.every((p) => p.shortfall === 0 && p.available === 1), JSON.stringify(a?.affectedPapers))
    check('甲缺席：瓶颈评审人仅乙（冲突者丙排除、缺席者甲排除）', a?.bottleneckReviewers?.length === 1 && a.bottleneckReviewers[0].reviewerId === 'b' && a.bottleneckReviewers[0].capacityForGroup === 2)
  }
}

// 12. 单篇可分配人数不足型缺席：p1 仅甲可选；乙/丙缺席不影响 → 该数据同时是“有仍有不可”的混合场景
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 1, [], []), R('b', '乙', 1, [], ['p1']), R('c', '丙', 5, [], ['p1'])]
  )
  console.log('用例12 单点缺席（p1 只有甲）')
  const out = runStressTest(d)
  if (out.runnable) {
    check('汇总：乙、丙缺席仍可分配（2），甲缺席不可分配（1）', out.report.feasibleCount === 2 && out.report.infeasibleCount === 1)
    const a = out.report.scenarios.find((s) => s.reviewerId === 'a')
    check('甲缺席不可行', !!a && !a.feasible)
    const p1 = a?.affectedPapers?.find((p) => p.paperId === 'p1')
    check('p1 剩余可选 0 人、单篇缺口 1', p1?.available === 0 && p1.shortfall === 1, JSON.stringify(p1))
    check('甲缺席：无可选评审人瓶颈（其余全部与 p1 冲突）', (a?.bottleneckReviewers?.length ?? 0) === 0)
  }
}

// 13. 全员冗余：任何人缺席都仍可分配
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 2), R('b', '乙', 2), R('c', '丙', 2)]
  )
  console.log('用例13 全员冗余')
  const out = runStressTest(d)
  if (out.runnable) check('3 人缺席全部仍可分配', out.report.feasibleCount === 3 && out.report.infeasibleCount === 0)
}

// 14. 数据指纹：容量/冲突/需求等变化后指纹改变；无关顺序与展示名不影响
{
  const d1 = mk([P('p1', 'A', 2, ['x'])], [R('a', '甲', 2, ['X'], []), R('b', '乙', 1)])
  const f1 = stressFingerprint(d1)
  const d2: AppData = { papers: d1.papers, reviewers: [R('b', '乙', 1), R('a', '甲', 2, ['X'], [])] }
  console.log('用例14 数据指纹与过期判定')
  check('仅数组顺序变化指纹不变（归一化排序）', stressFingerprint(d2) === f1)
  const d3 = mk([P('p1', 'A', 2, ['x'])], [R('a', '甲', 3, ['X'], []), R('b', '乙', 1)])
  check('容量变化指纹改变（结果立即过期）', stressFingerprint(d3) !== f1)
  const d4 = mk([P('p1', 'A', 1, ['x'])], d1.reviewers)
  check('需求变化指纹改变', stressFingerprint(d4) !== f1)
  const d5 = mk(d1.papers, [R('a', '甲', 2, ['X'], ['p1']), R('b', '乙', 1)])
  check('冲突变化指纹改变', stressFingerprint(d5) !== f1)
}

// 15. 压力测试不改变录入数据（缺席模拟用副本）
{
  const d = mk([P('p1', 'A', 1)], [R('a', '甲', 1), R('b', '乙', 1)])
  const snapshot = JSON.stringify(d)
  runStressTest(d)
  console.log('用例15 不修改录入数据')
  check('运行后输入数据引用内容不变', JSON.stringify(d) === snapshot)
  check('评审人容量仍为原值', d.reviewers.every((r) => r.capacity >= 1))
}

// 16. 基线含容量 0 的评审人：不参与受测；缺席诊断中“剩余可选人数”也不计入他们
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 1), R('b', '乙', 1), R('z', '容量为零者', 0)]
  )
  const out = runStressTest(d)
  console.log('用例16 容量0评审人')
  if (out.runnable) {
    check('仅受测 2 人（容量0者不参与）', out.report.testedReviewerCount === 2)
    const a = out.report.scenarios.find((s) => s.reviewerId === 'a')
    check('甲缺席不可行', !!a && !a.feasible)
    const p1 = a?.affectedPapers?.find((p) => p.paperId === 'p1')
    // z 容量为 0 不能承担名额；p1 缺席甲后只有乙可选（available=1，需求1，不缺），真正缺口在 Hall 组层面
    check('p1 剩余可选计数不含容量0者（=1）', p1?.available === 1, JSON.stringify(p1))
  }
}

/* ============================ 分派互换（一换一） ============================ */

/** 由分派清单构造一个结构合法的 AssignmentSuccess（用于互换引擎的可控输入） */
function makeSuccess(d: AppData, pairs: Array<[string, string]>): AssignmentSuccess {
  const assignments = pairs.map(([paperId, reviewerId]) => {
    const paper = d.papers.find((p) => p.id === paperId)!
    const reviewer = d.reviewers.find((r) => r.id === reviewerId)!
    const tags = computeMatchedTags(paper, reviewer)
    return { paperId, reviewerId, topicMatched: tags.length > 0, matchedTags: tags }
  })
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  const loads = d.reviewers.map((r) => ({ reviewerId: r.id, assigned: counts.get(r.id) ?? 0, capacity: r.capacity }))
  return {
    feasible: true,
    assignments,
    loads,
    objective: {
      topicMatches: assignments.filter((a) => a.topicMatched).length,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: assignments.length,
      totalRequired: assignments.length,
      preassignedCount: assignments.filter((a) => a.preassigned === true).length
    }
  }
}

const findCandidate = (list: SwapCandidate[], a: string, fromA: string, b: string, fromB: string) =>
  list.find(
    (c) =>
      (c.sideA.reviewerId === a && c.sideA.fromPaperId === fromA && c.sideB.reviewerId === b && c.sideB.fromPaperId === fromB) ||
      (c.sideA.reviewerId === b && c.sideA.fromPaperId === fromB && c.sideB.reviewerId === a && c.sideB.fromPaperId === fromA)
  )

// 17. 基本枚举 + 确认互换：净增匹配、只更新结果、不改录入数据
{
  const d = mk(
    [P('p1', 'ML', 1, ['ML']), P('p2', '系统', 1, ['SYS'])],
    [R('a', 'Alice', 2, ['ML']), R('b', 'Bob', 2, ['SYS']), R('c', 'Carol', 2, [])]
  )
  // 故意给出“都不匹配”的现状：a 评 p2、c 评 p1；把 p1 还给 a 可 +1
  const res = makeSuccess(d, [
    ['p2', 'a'],
    ['p1', 'c']
  ])
  const en = enumerateSwaps(d, res, 'a', 'c')
  console.log('用例17 互换枚举与应用')
  check('仅 1 个候选（a 的 p2 × c 的 p1）', en.candidates.length === 1, JSON.stringify(en.candidates.length))
  const cand = findCandidate(en.candidates, 'a', 'p2', 'c', 'p1')
  check('候选净增匹配 +1', cand?.deltaMatches === 1, `got ${cand?.deltaMatches}`)
  const snapshot = JSON.stringify(d)
  const next = cand ? applySwapCandidate(d, res, cand) : null
  check('应用后仍可行并标记已人工调整 / swapCount=1', !!next && next.manuallyAdjusted === true && next.swapCount === 1)
  check('交换后 a 评 p1（匹配）、c 评 p2（不匹配）', !!next && next.assignments.some((x) => x.paperId === 'p1' && x.reviewerId === 'a' && x.topicMatched) && next.assignments.some((x) => x.paperId === 'p2' && x.reviewerId === 'c' && !x.topicMatched))
  check('总匹配数升到 1、负载统计仍正确（a=1,c=1）', next?.objective.topicMatches === 1 && next.loads.find((l) => l.reviewerId === 'a')?.assigned === 1 && next.loads.find((l) => l.reviewerId === 'c')?.assigned === 1)
  check('每篇人数仍为 1、无人超容量', !!next && next.assignments.length === 2 && next.loads.every((l) => l.assigned <= l.capacity))
  check('录入数据完全不变', JSON.stringify(d) === snapshot)
  check('原结果对象未被原地修改', res.assignments.some((x) => x.paperId === 'p2' && x.reviewerId === 'a'))
  check('原结果未带人工标记', res.manuallyAdjusted === undefined && res.swapCount === undefined)
  // 再互换一次：swapCount 累计为 2
  const en2 = next ? enumerateSwaps(d, next, 'a', 'c') : { candidates: [] as SwapCandidate[] }
  const back = en2.candidates[0] ? applySwapCandidate(d, next!, en2.candidates[0]) : null
  check('可再次互换且 swapCount=2、匹配数回落 0', !!back && back.swapCount === 2 && back.objective.topicMatches === 0 && back.manuallyAdjusted === true)
}

// 18. 排除规则：同稿（组合不变）/ 利益冲突 / 重复承担
{
  const d = mk(
    [P('p1', 'A', 2, ['X']), P('p2', 'B', 2, ['Y'])],
    [R('a', '甲', 2, ['X']), R('b', '乙', 2, ['Y']), R('c', '丙', 2, [])]
  )
  // a 评 p1；b 评 p1、p2；c 评 p2。枚举 a×b：
  //  - p1(a)×p1(b) 同稿 → samePaper
  //  - p1(a)×p2(b)：换后 a 评 p2、b 评 p1，但 b 已评 p1 → duplicate
  const res = makeSuccess(d, [
    ['p1', 'a'],
    ['p1', 'b'],
    ['p2', 'b'],
    ['p2', 'c']
  ])
  const enAB = enumerateSwaps(d, res, 'a', 'b')
  console.log('用例18 互换排除项')
  check('同稿与重复承担被排除，无可行候选', enAB.candidates.length === 0)
  check('同稿计数=1', enAB.excluded.samePaper === 1, `got ${enAB.excluded.samePaper}`)
  check('重复承担计数=1', enAB.excluded.duplicate === 1, `got ${enAB.excluded.duplicate}`)

  // a×c：a 仅评 p1、c 仅评 p2，唯一交叉对 p1×p2 可行，没有同稿项
  const enAC = enumerateSwaps(d, res, 'a', 'c')
  check('a×c 有 1 个可行候选、无同稿/冲突/重复项', enAC.candidates.length === 1 && enAC.excluded.samePaper === 0 && enAC.excluded.duplicate === 0 && enAC.excluded.conflict === 0)

  // 利益冲突：a×b 中令换后 a 评其冲突稿。构造 b 评 p2、a 评 p1，a 对 p2 冲突
  const d2 = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 2, [], ['p2']), R('b', '乙', 2)]
  )
  const res2 = makeSuccess(d2, [
    ['p1', 'a'],
    ['p2', 'b']
  ])
  const en2 = enumerateSwaps(d2, res2, 'a', 'b')
  check('换后触发利益冲突的候选被排除', en2.candidates.length === 0 && en2.excluded.conflict === 1, `conflict=${en2.excluded.conflict}`)
}

// 19. 排序：按主题匹配净增从高到低
{
  const d = mk(
    [P('p1', '1', 1, ['X']), P('p2', '2', 1, ['Q']), P('p3', '3', 1, ['Z']), P('p4', '4', 1, ['W'])],
    [R('a', '甲', 4, ['X']), R('b', '乙', 4, ['Z', 'W']), R('c', '丙', 4, [])]
  )
  // 现状：a 评 p2（不匹配，标签 Q 无人擅长）、p3（不匹配）；b 评 p1（不匹配）；c 评 p4。
  // b(p1)×a(p2): a→p1 匹配 X(+1)，b→p2 不匹配(0) ⇒ +1
  // b(p1)×a(p3): a→p1 匹配 X(+1)，b→p3 匹配 Z(+1) ⇒ +2
  const res = makeSuccess(d, [
    ['p2', 'a'],
    ['p3', 'a'],
    ['p1', 'b'],
    ['p4', 'c']
  ])
  const en = enumerateSwaps(d, res, 'a', 'b')
  console.log('用例19 候选按匹配净增排序')
  check('共 2 个候选', en.candidates.length === 2)
  check('首位净增 +2、次位 +1（从高到低）', en.candidates[0].deltaMatches === 2 && en.candidates[1].deltaMatches === 1, JSON.stringify(en.candidates.map((c) => c.deltaMatches)))
  const up = en.candidates[0]
  check('首位应用后总匹配数 +2（0→2）', applySwapCandidate(d, res, up)?.objective.topicMatches === res.objective.topicMatches + 2)
}

// 20. 防御性拒绝：违规/过期候选不被应用
{
  const d = mk(
    [P('p1', 'A', 1, ['X']), P('p2', 'B', 1, ['Y'])],
    [R('a', '甲', 2, ['X'], ['p2']), R('b', '乙', 2, ['Y'])]
  )
  const res = makeSuccess(d, [
    ['p1', 'a'],
    ['p2', 'b']
  ])
  console.log('用例20 违规候选拒绝')
  // 伪造一个换后让 a 评冲突稿 p2 的候选
  const bogus: SwapCandidate = {
    reviewerAId: 'a',
    reviewerBId: 'b',
    sideA: { reviewerId: 'a', fromPaperId: 'p1', toPaperId: 'p2', fromMatchedTags: ['X'], toMatchedTags: [], fromMatched: true, toMatched: false },
    sideB: { reviewerId: 'b', fromPaperId: 'p2', toPaperId: 'p1', fromMatchedTags: ['Y'], toMatchedTags: [], fromMatched: true, toMatched: false },
    deltaMatches: -2
  }
  check('冲突候选 applySwapCandidate 返回 null', applySwapCandidate(d, res, bogus) === null)

  // 过期候选：fromPaper 已不在该评审人名下
  const staleCand: SwapCandidate = {
    ...bogus,
    sideA: { ...bogus.sideA, fromPaperId: 'p2' },
    sideB: { ...bogus.sideB, fromPaperId: 'p1' }
  }
  check('与当前分派不符的过期候选返回 null', applySwapCandidate(d, res, staleCand) === null)
}

/* ============================ 预指派（硬约束） ============================ */

const PA = (id: string, paperId: string, reviewerId: string) => ({ id, paperId, reviewerId })

// 21. 预指派入选：非匹配的评审人也会被强制分派，其余名额仍按匹配/均衡优化
{
  const d = mk(
    [P('p1', 'A', 2, ['X']), P('p2', 'B', 1)],
    [R('a', '甲', 2, ['X']), R('b', '乙', 2), R('c', '丙', 2, ['X'])],
    [PA('pa1', 'p1', 'b')] // p1 标签 X，乙不匹配；强制后 p1 = 乙 + 一位匹配者
  )
  const res = solveAssignment(d)
  console.log('用例21 预指派强制入选')
  check('可行', res.feasible, res.feasible ? '' : JSON.stringify(res.reasons.map((r) => r.kind)))
  if (res.feasible) {
    const p1 = res.assignments.filter((a) => a.paperId === 'p1')
    check('p1 恰好含被预指派的乙', p1.length === 2 && p1.some((a) => a.reviewerId === 'b'))
    check('乙的该条标记 preassigned=true', !!p1.find((a) => a.reviewerId === 'b')?.preassigned)
    check('其余分派未标记 preassigned', res.assignments.filter((a) => a.reviewerId !== 'b' || a.paperId !== 'p1').every((a) => !a.preassigned))
    check('preassignedCount=1', res.objective.preassignedCount === 1, `got ${res.objective.preassignedCount}`)
    check('p1 另一人仍是匹配者（匹配数不白丢）', p1.some((a) => a.reviewerId !== 'b' && a.topicMatched))
    check('无人超容量、每篇人数正确', res.loads.every((l) => l.assigned <= l.capacity) && res.objective.totalAssigned === 3)
  }
}

// 22. 预指派引用不存在的稿件/评审人：整体失败、逐条给原因、无部分结果
{
  const d = mk(
    [P('p1', 'A', 1)],
    [R('a', '甲', 1)],
    [PA('pa1', 'ghost', 'a'), PA('pa2', 'p1', 'ghostrev')]
  )
  const res = solveAssignment(d)
  console.log('用例22 预指派引用缺失')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const pre = res.reasons.find((r) => r.kind === 'preassignment')
    check('给出 preassignment 原因且 2 条 issue', !!pre && pre.issues?.length === 2, JSON.stringify(res.reasons.map((r) => r.kind)))
    check('含稿件缺失原因', pre?.issues?.some((i) => i.reason === 'paper-missing'))
    check('含评审人缺失原因', pre?.issues?.some((i) => i.reason === 'reviewer-missing'))
    check('每条都带具体稿件/评审人 id', pre?.issues?.every((i) => (i.paperId || i.reviewerId) && i.preAssignmentId))
    check('失败结果不含任何分派（无部分结果）', !('assignments' in res))
  }
}

// 23. 预指派与利益冲突并存：失败并定位到具体稿件/评审人
{
  const d = mk(
    [P('p1', 'A', 1)],
    [R('a', '甲', 1, [], ['p1'])],
    [PA('pa1', 'p1', 'a')]
  )
  const res = solveAssignment(d)
  console.log('用例23 预指派含利益冲突')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const iss = res.reasons.find((r) => r.kind === 'preassignment')?.issues
    check('原因为 conflict 且定位 p1/a', iss?.length === 1 && iss[0].reason === 'conflict' && iss[0].paperId === 'p1' && iss[0].reviewerId === 'a')
  }
}

// 24. 同篇预指派超过名额：失败
{
  const d = mk(
    [P('p1', 'A', 1)],
    [R('a', '甲', 2), R('b', '乙', 2)],
    [PA('pa1', 'p1', 'a'), PA('pa2', 'p1', 'b')]
  )
  const res = solveAssignment(d)
  console.log('用例24 同篇预指派超额')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const iss = res.reasons.find((r) => r.kind === 'preassignment')?.issues
    check('两条都报 paper-overflow', iss?.length === 2 && iss.every((i) => i.reason === 'paper-overflow'), JSON.stringify(iss?.map((i) => i.reason)))
  }
}

// 25. 单人预占超过容量：失败（即使各篇自身名额没超）
{
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [R('a', '甲', 1), R('b', '乙', 2), R('c', '丙', 2)],
    [PA('pa1', 'p1', 'a'), PA('pa2', 'p2', 'a')]
  )
  const res = solveAssignment(d)
  console.log('用例25 单人预占超容量')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const iss = res.reasons.find((r) => r.kind === 'preassignment')?.issues
    check('两条都报 reviewer-overload 且定位评审人 a', iss?.length === 2 && iss.every((i) => i.reason === 'reviewer-overload' && i.reviewerId === 'a'))
  }
}

// 26. 预指派本身合法但让整体调不开：残量最大流报组合瓶颈，且预指派仍被保证
{
  // p1,p2 各需 2；甲容量2且是 p1,p2 唯一额外可选（丙对两篇冲突）。
  // 预指派：p1→乙、p2→乙（乙容量2）。剩余：每篇还需1人，只有甲能评 → 甲需承担 2 篇，容量2 恰好够 → 应可行。
  {
    const d = mk(
      [P('p1', 'A', 2), P('p2', 'B', 2)],
      [R('a', '甲', 2), R('b', '乙', 2), R('c', '丙', 5, [], ['p1', 'p2'])],
      [PA('pa1', 'p1', 'b'), PA('pa2', 'p2', 'b')]
    )
    const res = solveAssignment(d)
    console.log('用例26a 预指派对调可行')
    check('可行且两条预指派都在结果中', res.feasible && res.assignments.filter((x) => x.reviewerId === 'b').length === 2, JSON.stringify(res.feasible ? res.objective : res.reasons.map((r) => r.kind)))
  }
  // 同上但甲容量1：乙被两篇各预占1，甲只剩1个自由名额而两篇各差1 → 残量 Hall 缺口1，不可行
  {
    const d = mk(
      [P('p1', 'A', 2), P('p2', 'B', 2)],
      [R('a', '甲', 1), R('b', '乙', 2), R('c', '丙', 5, [], ['p1', 'p2'])],
      [PA('pa1', 'p1', 'b'), PA('pa2', 'p2', 'b')]
    )
    const res = solveAssignment(d)
    console.log('用例26b 预指派导致组合瓶颈')
    check('不可行（预指派预检通过、残量最大流失败）', !res.feasible)
    if (!res.feasible) {
      check('报 subset-bottleneck 而不是 preassignment', res.reasons.some((r) => r.kind === 'subset-bottleneck') && !res.reasons.some((r) => r.kind === 'preassignment'), JSON.stringify(res.reasons.map((r) => r.kind)))
    }
  }
}

// 27. 失效关系保留与逐条移除（派生状态），并兼容旧数据（缺省字段）
{
  const { derivePreAssignments } = await import('../src/engine/preassign')
  // 修改评审人：删除后关系保留、标记 reviewer-missing
  let d: AppData = mk([P('p1', 'A', 1)], [R('a', '甲', 1)], [PA('pa1', 'p1', 'a')])
  d = { ...d, reviewers: [] }
  let derived = derivePreAssignments(d)
  console.log('用例27 失效关系保留 / 旧数据兼容')
  check('删除评审人后关系仍保留', d.preAssignments.length === 1 && derived.length === 1)
  check('标记为失效且原因为 reviewer-missing', !derived[0].valid && derived[0].issue?.reason === 'reviewer-missing')
  // 恢复评审人但加上冲突 → 仍失效，原因变为 conflict
  d = { ...d, reviewers: [R('a', '甲', 1, [], ['p1'])] }
  derived = derivePreAssignments(d)
  check('新增冲突后失效关系仍保留、原因转为 conflict', derived.length === 1 && !derived[0].valid && derived[0].issue?.reason === 'conflict')
  // 解除冲突 → 自动恢复有效（无需用户重建）
  d = { ...d, reviewers: [R('a', '甲', 1)] }
  derived = derivePreAssignments(d)
  check('解除冲突后关系恢复有效', derived[0].valid)
  // 旧数据：完全没有 preAssignments 字段
  const legacy = JSON.parse(JSON.stringify({ papers: [P('p1', 'A', 1)], reviewers: [R('a', '甲', 1)] })) as AppData
  check('旧结构数据派生为空列表不报错', derivePreAssignments(legacy).length === 0)
}

// 28. JSON 导出标明预指派
{
  const { buildExportPayload } = await import('../src/exporter')
  const d = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, ['X']), R('b', '乙', 2)],
    [PA('pa1', 'p1', 'b')]
  )
  const res = solveAssignment(d)
  console.log('用例28 导出标明预指派')
  check('求解成功', res.feasible)
  if (res.feasible) {
    const payload = buildExportPayload(d, res)
    check('summary 含 preassignedCount=1', payload.summary.preassignedCount === 1)
    const rowB = payload.assignments.find((a) => a.reviewerId === 'b')
    const rowA = payload.assignments.find((a) => a.reviewerId === 'a')
    check('乙的分派 preassigned=true、其余为 false', rowB?.preassigned === true && rowA?.preassigned === false)
  }
}

// 29. 互换不会换走预指派
{
  const d = mk(
    [P('p1', 'ML', 1, ['ML']), P('p2', '系统', 1, ['SYS'])],
    [R('a', 'Alice', 2, ['ML']), R('b', 'Bob', 2, ['SYS']), R('c', 'Carol', 2)],
    [
      PA('pa1', 'p2', 'a'), // 预指派 a 评 p2（不匹配）；即便换成 p1 更优也不允许
      PA('pa2', 'p1', 'c') // 预指派 c 评 p1（不匹配）
    ]
  )
  const res = solveAssignment(d)
  console.log('用例29 互换保护预指派')
  check(
    '求解成功且 a→p2、c→p1 带预指派标记',
    res.feasible &&
      !!res.assignments.find((x) => x.paperId === 'p2' && x.reviewerId === 'a' && x.preassigned) &&
      !!res.assignments.find((x) => x.paperId === 'p1' && x.reviewerId === 'c' && x.preassigned)
  )
  if (res.feasible) {
    // 两人各自被预指派的稿件正好是唯一可换对象（一换一会同时移走两条预指派）→ 必须全部排除
    const en = enumerateSwaps(d, res, 'a', 'c')
    check('涉及预指派的候选数=0，preassigned 计数=1', en.candidates.length === 0 && en.excluded.preassigned === 1, JSON.stringify(en.excluded))
    // 防御性应用同样拒绝伪造的、会移走预指派的候选
    const bogus: SwapCandidate = {
      reviewerAId: 'a',
      reviewerBId: 'c',
      sideA: { reviewerId: 'a', fromPaperId: 'p2', toPaperId: 'p1', fromMatchedTags: [], toMatchedTags: ['ML'], fromMatched: false, toMatched: true },
      sideB: { reviewerId: 'c', fromPaperId: 'p1', toPaperId: 'p2', fromMatchedTags: [], toMatchedTags: [], fromMatched: false, toMatched: false },
      deltaMatches: 1
    }
    check('applySwapCandidate 拒绝移走预指派', applySwapCandidate(d, res, bogus) === null)
  }
}

// 30. 预指派失效时，压力测试同样不可运行（基线硬约束判定同源）
{
  const d = mk(
    [P('p1', 'A', 1)],
    [R('a', '甲', 2), R('b', '乙', 2)],
    [PA('pa1', 'p1', 'a'), PA('pa2', 'ghost', 'b')]
  )
  const out = runStressTest(d)
  console.log('用例30 预指派失效时压力测试不可运行')
  check('runnable=false 且原因含预指派问题', !out.runnable && 'reasons' in out && out.reasons.some((m) => m.includes('预指派')))
}

/* ============================ 机构去重（硬约束） ============================ */

// 31. 基本机构去重：同一稿件不会被分给同机构两人（即使总容量/人数都够）
{
  // p1 需 2；a、b 同机构「清华」，c 另一机构。只能取 a/b 中一人 + c → 可行
  const d = mk(
    [P('p1', 'A', 2, ['X'])],
    [R('a', '甲', 2, ['X'], [], '清华'), R('b', '乙', 2, ['X'], [], '清华'), R('c', '丙', 2, ['X'], [], '北大')]
  )
  const res = solveAssignment(d)
  console.log('用例31 机构去重基本可行')
  check('可行', res.feasible, res.feasible ? '' : JSON.stringify(res.reasons.map((r) => r.kind)))
  if (res.feasible) {
    const ids = res.assignments.filter((a) => a.paperId === 'p1').map((a) => a.reviewerId)
    check('p1 恰好 2 人', ids.length === 2)
    check('同稿不出现同机构两人（清华最多一人）', !(ids.includes('a') && ids.includes('b')), JSON.stringify(ids))
    check('丙（北大）必入选', ids.includes('c'))
  }
}

// 31b. 机构去重导致不可行：p1 需 2，但可选评审人全部同机构
{
  const d = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 2, [], [], '清华'), R('c', '丙', 2, [], [], '清华')]
  )
  const res = solveAssignment(d)
  console.log('用例31b 同机构全员→不可行')
  check('不可行', !res.feasible)
  if (!res.feasible) check('给出单篇人数不足原因', res.reasons.some((r) => r.kind === 'paper-eligible'), JSON.stringify(res.reasons.map((r) => r.kind)))
}

// 31c. 同一评审人仍可承担多篇不同稿件（机构槽按稿件展开，不跨稿封禁）
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 2, [], [], '清华')]
  )
  const res = solveAssignment(d)
  console.log('用例31c 同机构可分任不同稿件')
  check('可行且两篇各 1 人', res.feasible && res.objective.totalAssigned === 2, JSON.stringify(res.feasible ? res.objective : res.reasons.map((r) => r.kind)))
}

// 32. 空机构不与其他空值合并：多位空机构评审人可同稿
{
  const d = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2), R('b', '乙', 2), R('c', '丙', 1)]
  )
  const res = solveAssignment(d)
  console.log('用例32 空机构互不合并')
  check('可行', res.feasible, res.feasible ? '' : JSON.stringify(res.reasons.map((r) => r.kind)))
  if (res.feasible) check('p1 可由两位空机构评审人同评', res.assignments.filter((a) => a.paperId === 'p1').length === 2)
}

// 32b. 去首尾空白后视为同一机构（且区分大小写）
{
  const d1 = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, [], [], '  清华 '), R('b', '乙', 2, [], [], '清华'), R('c', '丙', 2, [], [], '北大')]
  )
  const res1 = solveAssignment(d1)
  console.log('用例32b 机构空白归一化')
  check('「  清华 」与「清华」视为同机构 → 需由丙补位，方案仍可行', res1.feasible, JSON.stringify(res1.feasible ? '' : res1.reasons.map((r) => r.kind)))
  if (res1.feasible) {
    const ids = res1.assignments.filter((a) => a.paperId === 'p1').map((a) => a.reviewerId)
    check('甲乙不同时入选（去空白后同机构）', !(ids.includes('a') && ids.includes('b')), JSON.stringify(ids))
    check('丙（北大）必入选', ids.includes('c'))
  }
  // 大小写不同视为不同机构（要求是“完全相同”）
  const d2 = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, [], [], 'MIT'), R('b', '乙', 2, [], [], 'mit')]
  )
  const res2 = solveAssignment(d2)
  console.log('用例32c 机构区分大小写')
  check('MIT 与 mit 视为不同机构（可同稿）', res2.feasible, res2.feasible ? '' : JSON.stringify(res2.reasons.map((r) => r.kind)))
}

// 33. 预指派已让同稿出现重复机构：整体拒绝、列出稿件/机构/相关评审人、无部分结果
{
  const d = mk(
    [P('p1', 'A', 3)],
    [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 2, [], [], '清华'), R('c', '丙', 2, [], [], '北大')],
    [PA('pa1', 'p1', 'a'), PA('pa2', 'p1', 'b')]
  )
  const res = solveAssignment(d)
  console.log('用例33 预指派机构重复整体拒绝')
  check('不可行', !res.feasible)
  if (!res.feasible) {
    const pre = res.reasons.find((r) => r.kind === 'preassignment')
    check('给出 preassignment 原因且 2 条 issue', !!pre && pre.issues?.length === 2, JSON.stringify(res.reasons.map((r) => r.kind)))
    const orgIssues = pre?.issues?.filter((i) => i.reason === 'organization-duplicate')
    check('两条都是 organization-duplicate', orgIssues?.length === 2, JSON.stringify(pre?.issues?.map((i) => i.reason)))
    check('issue 带机构名「清华」', orgIssues?.every((i) => i.organization === '清华'))
    check('issue 列出相关评审人（甲乙）', orgIssues?.every((i) => (i.organizationReviewerNames ?? []).length === 2))
    check('定位到稿件 p1', orgIssues?.every((i) => i.paperId === 'p1'))
    check('失败结果不含任何分派（无部分结果）', !('assignments' in res))
  }
}

// 33b. 预指派封禁机构：机构名额被预指派占住后，自由分配不得再给同机构者（否则整体不可行）
{
  // p1 需 2；预指派 a（清华）。其余可选 b（清华）、c（清华），再加 d（北大）。
  // 自由名额只能给 d（b/c 机构被封禁）→ 还需 1 人，d 恰好够 → 可行且 b/c 不得入选
  const d = mk(
    [P('p1', 'A', 2)],
    [
      R('a', '甲', 2, [], [], '清华'),
      R('b', '乙', 2, [], [], '清华'),
      R('c', '丙', 2, [], [], '清华'),
      R('dd', '丁', 2, [], [], '北大')
    ],
    [PA('pa1', 'p1', 'a')]
  )
  const res = solveAssignment(d)
  console.log('用例33b 预指派封禁同机构自由名额')
  check('可行', res.feasible, res.feasible ? '' : JSON.stringify(res.reasons.map((r) => r.kind)))
  if (res.feasible) {
    const ids = res.assignments.filter((x) => x.paperId === 'p1').map((x) => x.reviewerId)
    check('p1 = 甲 + 丁（乙/丙被机构封禁）', ids.includes('a') && ids.includes('dd') && !ids.includes('b') && !ids.includes('c'), JSON.stringify(ids))
  }
  // 去掉丁 → 只剩同机构者 → 不可行（报瓶颈，而非静默选同机构）
  const d2 = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 2, [], [], '清华'), R('c', '丙', 2, [], [], '清华')],
    [PA('pa1', 'p1', 'a')]
  )
  const res2 = solveAssignment(d2)
  console.log('用例33c 预指派封禁后无其他机构可选')
  check('不可行且非预指派预检问题（残量瓶颈）', !res2.feasible && !res2.reasons.some((r) => r.kind === 'preassignment'), JSON.stringify(res2.feasible ? '' : res2.reasons.map((r) => r.kind)))
}

// 34. 机构去重下的组合瓶颈：多篇稿件只能由同机构评审人承担
{
  // p1,p2 各需 2；甲、乙同机构「清华」且对两篇均可评；丙容量 5 但对两篇全冲突。
  // 每篇最多从清华取 1 人 → 每篇至多 1 个名额，两篇缺口各 1 → 单篇不足
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [R('a', '甲', 5, [], [], '清华'), R('b', '乙', 5, [], [], '清华'), R('c', '丙', 5, [], ['p1', 'p2'], '北大')]
  )
  const res = solveAssignment(d)
  console.log('用例34 机构集中型瓶颈')
  check('不可行', !res.feasible)
  if (!res.feasible) check('两篇均报单篇不足', res.reasons.filter((r) => r.kind === 'paper-eligible').length === 2, JSON.stringify(res.reasons.map((r) => r.kind)))
}

// 35. 互换不得违反机构去重
{
  // p1：a（清华）、dd（北大）；p2：b（清华）、c（清华）。
  // a×b：唯一交叉对是 p1(a)×p2(b)。换后 b 到 p1 时，p1 上 a 离开只剩 dd（北大）看似不冲突；
  // 但 a 到 p2 时，p2 上仍在位的 c 与 a 同属清华 → 机构冲突，必须排除；反向亦然。
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [
      R('a', '甲', 2, [], [], '清华'),
      R('b', '乙', 2, [], [], '清华'),
      R('c', '丙', 2, [], [], '清华'),
      R('dd', '丁', 2, [], [], '北大')
    ]
  )
  const res = makeSuccess(d, [
    ['p1', 'a'],
    ['p1', 'dd'],
    ['p2', 'b'],
    ['p2', 'c']
  ])
  const en = enumerateSwaps(d, res, 'a', 'b')
  console.log('用例35 互换机构去重')
  check('同机构互换候选=0（p2 上仍有同机构的丙）', en.candidates.length === 0, JSON.stringify(en.candidates.length))
  check('机构排除计数=1（p1×p2 唯一交叉对）', en.excluded.organization === 1, `got ${en.excluded.organization}`)
  // 伪造机构冲突候选，防御性应用应返回 null
  const bogus: SwapCandidate = {
    reviewerAId: 'a',
    reviewerBId: 'b',
    sideA: { reviewerId: 'a', fromPaperId: 'p1', toPaperId: 'p2', fromMatchedTags: [], toMatchedTags: [], fromMatched: false, toMatched: false },
    sideB: { reviewerId: 'b', fromPaperId: 'p2', toPaperId: 'p1', fromMatchedTags: [], toMatchedTags: [], fromMatched: false, toMatched: false },
    deltaMatches: 0
  }
  check('applySwapCandidate 拒绝机构冲突（p2 上丙同机构）', applySwapCandidate(d, res, bogus) === null)
}

// 35b. 两位同机构评审人在不同稿件间“纯对调”，交换后各自目标稿件无其他同机构者 → 合法
{
  // p1：a（清华）、dd（北大）；p2：b（清华）、e（北大）。
  // a×b：p1(a)×p2(b)：换后 p1 = 丁(北大)+乙(清华)、p2 = 戊(北大)+甲(清华)，均不重复 → 放行
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2)],
    [
      R('a', '甲', 2, [], [], '清华'),
      R('b', '乙', 2, [], [], '清华'),
      R('dd', '丁', 2, [], [], '北大'),
      R('e', '戊', 2, [], [], '北大')
    ]
  )
  const res = makeSuccess(d, [
    ['p1', 'a'],
    ['p1', 'dd'],
    ['p2', 'b'],
    ['p2', 'e']
  ])
  const en = enumerateSwaps(d, res, 'a', 'b')
  console.log('用例35b 同稿无其他同机构者时互换放行')
  check('存在 1 个合法候选（机构排除=0）', en.candidates.length === 1 && en.excluded.organization === 0, JSON.stringify([en.candidates.length, en.excluded]))
  const next = en.candidates[0] ? applySwapCandidate(d, res, en.candidates[0]) : null
  check('应用成功：p1 变为乙、p2 变为甲，机构仍不重复', !!next && next.assignments.some((x) => x.paperId === 'p1' && x.reviewerId === 'b') && next.assignments.some((x) => x.paperId === 'p2' && x.reviewerId === 'a'))
}

// 36. 旧本地数据缺少机构字段：按空值加载与求解
{
  const legacy = {
    papers: [P('p1', 'A', 2)],
    reviewers: [
      { id: 'a', name: '甲', tags: [], capacity: 2, conflictPaperIds: [] },
      { id: 'b', name: '乙', tags: [], capacity: 2, conflictPaperIds: [] }
    ]
  }
  console.log('用例36 旧数据无机构字段')
  // @ts-expect-error 故意构造缺字段旧结构
  const res = solveAssignment(legacy)
  check('无机构字段视为空值、可正常求解（两位空机构可同稿）', res.feasible && res.objective.totalAssigned === 2)
}

// 37. 导出包含机构信息
{
  const { buildExportPayload } = await import('../src/exporter')
  const d = mk(
    [P('p1', 'A', 2)],
    [R('a', '甲', 2, ['X'], [], '  清华大学 '), R('b', '乙', 2, [], [], '北京大学')]
  )
  const res = solveAssignment(d)
  console.log('用例37 导出含机构')
  check('求解成功', res.feasible)
  if (res.feasible) {
    const payload = buildExportPayload(d, res)
    const rowA = payload.assignments.find((x) => x.reviewerId === 'a')
    check('分派行带去空白后的机构名', rowA?.reviewerOrganization === '清华大学', JSON.stringify(rowA))
    const loadA = payload.reviewerLoads.find((x) => x.reviewerId === 'a')
    check('负载行带机构名', loadA?.reviewerOrganization === '清华大学')
  }
}

// 38. 数据指纹随机构变化（机构变了，压力测试报告应过期）
{
  const d1 = mk([P('p1', 'A', 1)], [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 1, [], [], '北大')])
  const d2 = mk([P('p1', 'A', 1)], [R('a', '甲', 2, [], [], '清华'), R('b', '乙', 1, [], [], '复旦')])
  console.log('用例38 机构进入数据指纹')
  check('机构变化指纹改变', stressFingerprint(d1) !== stressFingerprint(d2))
  const d3 = mk([P('p1', 'A', 1)], [R('a', '甲', 2, [], [], '  清华'), R('b', '乙', 1, [], [], '北大')])
  check('仅首尾空白不同指纹不变（归一化后相同）', stressFingerprint(d1) === stressFingerprint(d3))
}

// 39. 缺席者自身被预指派：容量置 0 后单人预占超容量，基线不可行 → 压力测试不可运行
{
  const d = mk(
    [P('p1', 'A', 1)],
    [R('a', '甲', 1), R('b', '乙', 2)],
    [PA('pa1', 'p1', 'a')]
  )
  // 基线可行（甲容量1 恰好）；模拟甲缺席时 evaluateHardConstraints 应报 reviewer-overload
  console.log('用例39 缺席预指派者（容量置0超预占）')
  check('基线可行', solveAssignment(d).feasible)
  const out = runStressTest(d)
  check('可运行（基线可行）', out.runnable)
  if (out.runnable) {
    const a = out.report.scenarios.find((s) => s.reviewerId === 'a')
    check('甲缺席场景存在且不可行', !!a && !a.feasible, JSON.stringify(a?.feasible))
  }
}

/* ============================ 备选方案（1～3 个方案 + 差异 N） ============================ */

// 40. count=1 退化为单方案：返回普通 AssignmentSuccess（无 kind），与 solveAssignment 一致
{
  const d = mk(
    [P('p1', 'ML', 1, ['ML']), P('p2', 'SYS', 1, ['SYS'])],
    [R('a', 'Alice', 2, ['ML']), R('b', 'Bob', 2, ['SYS']), R('c', 'Carol', 2)]
  )
  const single = solveAssignment(d)
  const batch1 = solveAssignmentBatch(d, 1, 0)
  console.log('用例40 备选模式 count=1 退化为单方案')
  check('count=1 返回普通成功结果（无 batch 标记）', batch1.feasible && (batch1 as { kind?: string }).kind === undefined)
  check('与 solveAssignment 分派完全一致', JSON.stringify(batch1) === JSON.stringify(single))
}

// 41. 生成 3 个方案：全部可行、满足全部硬约束，两两差异 ≥ N
{
  // 4 篇各需 2，6 位容量充足、无冲突，提供多种可行组合
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 2), P('p3', 'C', 2), P('p4', 'D', 2)],
    [R('a', '甲', 4), R('b', '乙', 4), R('c', '丙', 4), R('dd', '丁', 4), R('e', '戊', 4), R('f', '己', 4)]
  )
  const N = 2
  const out = solveAssignmentBatch(d, 3, N)
  console.log('用例41 生成3个备选方案')
  check('返回批量结果且含 3 个方案', out.feasible && (out as { kind?: string }).kind === 'batch' && (out as any).solutions?.length === 3, JSON.stringify((out as any).solutions?.length))
  if (out.feasible && (out as { kind?: string }).kind === 'batch') {
    const sols = (out as any).solutions as AssignmentSuccess[]
    check('无停止原因（凑满数量）', !(out as any).stopReason)
    check('记录 requestedCount=3 与 N=2', (out as any).requestedCount === 3 && (out as any).minDifference === 2)
    // 第 1 个方案与单方案字典序最优完全一致
    check('方案1 即字典序最优方案', JSON.stringify(sols[0]) === JSON.stringify(solveAssignment(d)))
    // 每个方案都满足全部硬约束
    let allValid = true
    for (const s of sols) {
      if (s.objective.totalAssigned !== 8) allValid = false
      if (s.loads.some((l) => l.assigned > l.capacity)) allValid = false
      const perPaper = new Map<string, number>()
      for (const it of s.assignments) perPaper.set(it.paperId, (perPaper.get(it.paperId) ?? 0) + 1)
      for (const p of d.papers) if (perPaper.get(p.id) !== 2) allValid = false
    }
    check('每个方案均满足全部硬约束（名额/容量/人数）', allValid)
    // 两两对称差 ≥ N
    let pairwise = true
    const diffs: number[] = []
    for (let i = 0; i < sols.length; i++)
      for (let j = i + 1; j < sols.length; j++) {
        const df = symmetricDifference(sols[i], sols[j])
        diffs.push(df)
        if (df < N) pairwise = false
      }
    check('任意两方案关系对称差 ≥ N=2', pairwise, JSON.stringify(diffs))
    check('每个方案与方案1都不同（diffToFirst > 0）', sols.slice(1).every((s) => symmetricDifference(sols[0], s) >= N))
  }
}

// 42. 差异条数为对称差：所有方案关系条数相同（恒为偶数差异）
{
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1)],
    [R('a', '甲', 2), R('b', '乙', 2), R('c', '丙', 2)]
  )
  const out = solveAssignmentBatch(d, 2, 2)
  console.log('用例42 对称差恒为偶数')
  if (out.feasible && (out as { kind?: string }).kind === 'batch') {
    const sols = (out as any).solutions as AssignmentSuccess[]
    const df = symmetricDifference(sols[0], sols[1])
    check('两方案差异为偶数 2（互换一位评审人）', df === 2, `got ${df}`)
  } else {
    check('批量求解成功', false)
  }
}

// 43. 无法凑满数量：保留已找到方案并给出停止原因
{
  // 单篇稿件只需 1 人，恰有 2 位无冲突评审人：可行方案只有“选甲”“选乙”两种，
  // 两两对称差=2；请求 3 个、N=2 时找到 2 个后第 3 次 ILP 在切割下不可行。
  const d = mk([P('p1', 'A', 1)], [R('a', '甲', 2), R('b', '乙', 2)])
  const out = solveAssignmentBatch(d, 3, 2)
  console.log('用例43 无法凑满时保留并说明原因')
  check('批量结果仍成功（保留已找到方案）', out.feasible && (out as { kind?: string }).kind === 'batch')
  if (out.feasible && (out as { kind?: string }).kind === 'batch') {
    check('只找到 2 个方案（可行结构仅有两种）', (out as any).solutions.length === 2, `got ${(out as any).solutions.length}`)
    check('给出停止原因', typeof (out as any).stopReason === 'string' && (out as any).stopReason.includes('停止'), String((out as any).stopReason))
    check('requestedCount 仍记录为 3', (out as any).requestedCount === 3)
    check('保留的 2 个方案本身差异=2', symmetricDifference((out as any).solutions[0], (out as any).solutions[1]) === 2)
  }
}

// 44. N 超过可实现上界时（引擎层）校验失败
{
  const d = mk([P('p1', 'A', 2)], [R('a', '甲', 2, [], ['p0']), R('b', '乙', 2), R('c', '丙', 2)])
  const first = solveAssignment(d) as AssignmentSuccess
  console.log('用例44 N 校验')
  const v1 = validateBatchOptions({ requestedCount: 2, minDifferenceInput: 5, reference: first })
  check('N=5 超过上界 4 → 拒绝', !v1.ok)
  const v2 = validateBatchOptions({ requestedCount: 2, minDifferenceInput: 4, reference: first })
  check('N=4 等于上界 → 通过', v2.ok && v2.minDifference === 4)
  const v3 = validateBatchOptions({ requestedCount: 2, minDifferenceInput: 0, reference: first })
  check('N=0 拒绝', !v3.ok)
  const v4 = validateBatchOptions({ requestedCount: 1, minDifferenceInput: 0, reference: first })
  check('count=1 不需要 N', v4.ok)
  // 批量入口对越界 N 返回失败结果（不抛异常）
  const bad = solveAssignmentBatch(d, 2, 99)
  check('批量入口对越界 N 返回失败', !bad.feasible)
}

// 45. 预指派压缩可实现差异：上界只计自由关系
{
  // p1 需 2，其中 b 被预指派（所有方案相同）；p2 需 1。总名额 3，自由 2 → 上界 4
  const d = mk(
    [P('p1', 'A', 2), P('p2', 'B', 1)],
    [R('a', '甲', 3), R('b', '乙', 3), R('c', '丙', 3)],
    [PA('pa1', 'p1', 'b')]
  )
  const first = solveAssignment(d) as AssignmentSuccess
  console.log('用例45 预指派压缩差异上界')
  check('上界 = 2×(3−1)=4', validateBatchOptions({ requestedCount: 3, minDifferenceInput: 4, reference: first }).ok)
  check('N=6 超过（预指派不可变）→ 拒绝', !validateBatchOptions({ requestedCount: 3, minDifferenceInput: 6, reference: first }).ok)
  const out = solveAssignmentBatch(d, 2, 4)
  if (out.feasible && (out as { kind?: string }).kind === 'batch') {
    const sols = (out as any).solutions as AssignmentSuccess[]
    check('两方案都保留预指派 b→p1', sols.every((s) => s.assignments.some((x) => x.paperId === 'p1' && x.reviewerId === 'b' && x.preassigned)))
    check('自由关系完全错开（对称差=4）', sols.length === 2 && symmetricDifference(sols[0], sols[1]) === 4, `got ${sols.length === 2 ? symmetricDifference(sols[0], sols[1]) : '-'}`)
  } else {
    check('N=4 批量求解成功', false)
  }
}

// 46. 备选方案导出：写入方案序号与差异统计
{
  const { buildExportPayload } = await import('../src/exporter')
  const d = mk(
    [P('p1', 'A', 1), P('p2', 'B', 1), P('p3', 'C', 1)],
    [R('a', '甲', 3), R('b', '乙', 3), R('c', '丙', 3), R('dd', '丁', 3)]
  )
  const out = solveAssignmentBatch(d, 2, 2)
  console.log('用例46 备选导出序号与差异')
  if (out.feasible && (out as { kind?: string }).kind === 'batch') {
    const sols = (out as any).solutions as AssignmentSuccess[]
    const df = symmetricDifference(sols[0], sols[1])
    const p0 = buildExportPayload(d, sols[0], { index: 1, total: 2, minDifference: 2, diffToFirst: 0 })
    const p1 = buildExportPayload(d, sols[1], { index: 2, total: 2, minDifference: 2, diffToFirst: df })
    check('方案1导出 solution.index=1、diffToFirst=0', p0.solution.index === 1 && p0.solution.diffToFirst === 0 && p0.solution.total === 2 && p0.solution.minDifference === 2)
    check('方案2导出 solution.index=2、diffToFirst=实际对称差', p1.solution.index === 2 && p1.solution.diffToFirst === df && df >= 2, JSON.stringify(p1.solution))
    // 单方案默认导出仍带默认 meta（超集兼容）
    const single = buildExportPayload(d, sols[0])
    check('单方案导出默认 meta 为 1/1/0/0', single.solution.index === 1 && single.solution.total === 1 && single.solution.minDifference === 0 && single.solution.diffToFirst === 0)
  } else {
    check('批量求解成功', false)
  }
}

// 47. 备选模式互换：守卫排除会让差异跌破 N 的候选
{
  // 构造两个已知方案，方案2 与方案1 恰好相差 2（处于 N=2 临界）；
  // 在方案2 上做某些互换会把它变回方案1（差异 0），必须被守卫排除。
  const d = mk(
    [P('p1', 'ML', 1, ['ML']), P('p2', 'SYS', 1, ['SYS'])],
    [R('a', 'Alice', 2, ['ML']), R('b', 'Bob', 2, ['SYS']), R('c', 'Carol', 2, [])]
  )
  // 方案1（最优匹配）：a→p1, b→p2；方案2：a→p2, c→p1（差异 4）
  const s1 = makeSuccess(d, [
    ['p1', 'a'],
    ['p2', 'b']
  ])
  const s2 = makeSuccess(d, [
    ['p1', 'c'],
    ['p2', 'a']
  ])
  console.log('用例47 备选互换多样性守卫')
  check('构造的两方案差异=4', symmetricDifference(s1, s2) === 4, `got ${symmetricDifference(s1, s2)}`)
  const edges1 = new Set(s1.assignments.map((x) => `${x.paperId}␟${x.reviewerId}`))
  // 在 s2 上枚举 a×c：互换 a(p2)×c(p1) → a→p1, c→p2，与 s1 差异变为 2（仍 ≥ N=2，放行）
  const guard2: { minDifference: number; otherEdgeSets: Set<string>[] } = { minDifference: 2, otherEdgeSets: [edges1] }
  const en2 = enumerateSwaps(d, s2, 'a', 'c', guard2)
  check('守卫 N=2：互换后差异=2 的候选放行', en2.candidates.length === 1, `got ${en2.candidates.length}`)
  // N=4：互换后与 s1 差异变 2 < 4 → 必须排除
  const guard4 = { minDifference: 4, otherEdgeSets: [edges1] }
  const en4 = enumerateSwaps(d, s2, 'a', 'c', guard4)
  check('守卫 N=4：差异跌破的候选被排除（diversity 计数）', en4.candidates.length === 0 && en4.excluded.diversity === 1, JSON.stringify(en4.excluded))
  // 应用阶段同样拒绝
  const cand = en2.candidates[0]
  check('applySwapCandidate 在 N=4 守卫下返回 null', cand ? applySwapCandidate(d, s2, cand, guard4) === null : false)
  // 无守卫时行为与原来一致（向后兼容）
  const enNoGuard = enumerateSwaps(d, s2, 'a', 'c')
  check('无守卫时 diversity 计数为 0、候选正常', enNoGuard.candidates.length === 1 && enNoGuard.excluded.diversity === 0)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
