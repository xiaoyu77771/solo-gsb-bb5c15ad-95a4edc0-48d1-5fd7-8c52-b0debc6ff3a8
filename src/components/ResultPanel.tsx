import { useEffect, useMemo, useState } from 'react'
import type { AppData, AssignmentBatchSuccess, AssignmentResult, AssignmentSuccess } from '../types'
import { isBatchResult } from '../types'
import type { DiversityGuard, SwapCandidate } from '../engine/swap'
import { assignmentEdges, symmetricDifference } from '../engine/alternatives'
import { SwapTool } from './SwapTool'

interface ResultPanelProps {
  data: AppData
  result: AssignmentResult | null
  /** 当前结果是否因录入数据变化而已过期（过期时不允许互换） */
  stale: boolean
  /** 导出当前选中方案（参数为方案序号下标，单方案恒为 0） */
  onExport: (planIndex: number) => void
  onApplySwap: (candidate: SwapCandidate) => void
  /** 备选模式：当前选中方案下标（受控；缺省时由面板内部维护，首项为 0） */
  activeIndex?: number
  onActiveIndexChange?: (index: number) => void
}

const kindLabel: Record<string, string> = {
  'global-capacity': '全局容量不足',
  'paper-eligible': '单篇稿件可分配人数不足',
  'subset-bottleneck': '组合性瓶颈（局部容量不足）',
  preassignment: '预指派硬约束无法满足'
}

const issueLabel: Record<string, string> = {
  'paper-missing': '引用稿件不存在',
  'reviewer-missing': '引用评审人不存在',
  conflict: '与利益冲突冲突',
  'organization-duplicate': '预指派机构重复',
  'paper-overflow': '同篇预指派超过名额',
  'reviewer-overload': '单人预占超过容量'
}

export function ResultPanel({ data, result, stale, onExport, onApplySwap, activeIndex, onActiveIndexChange }: ResultPanelProps) {
  const [innerIndex, setInnerIndex] = useState(0)
  const batch: AssignmentBatchSuccess | null = result && result.feasible && isBatchResult(result) ? result : null
  const planIndex = activeIndex ?? innerIndex
  const setPlanIndex = (i: number) => {
    setInnerIndex(i)
    onActiveIndexChange?.(i)
  }

  // 结果被重新生成（方案数变化）后，选中项回到第 1 个方案
  const solutionCount = batch ? batch.solutions.length : 1
  useEffect(() => {
    setInnerIndex(0)
    onActiveIndexChange?.(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solutionCount, batch?.requestedCount])

  if (!result) {
    return (
      <section className="result-empty">
        <p>点击页面顶部的「▶ 生成分派」按钮，系统将在浏览器本地完成整数规划求解。</p>
        <ul>
          <li>
            <strong>硬约束</strong>：预指派必须入选、利益冲突回避、评审人容量上限、每篇稿件所需评审人数、
            同一篇稿件对每个机构至多选择一人（空机构除外），五者必须全部满足；
          </li>
          <li>
            <strong>优化目标</strong>：先最大化主题标签匹配，再最小化评审人最大负载（负载均衡）。
          </li>
          <li>
            <strong>备选方案</strong>：可在顶部选择生成 1～3 个方案；第 1 个仍是上述最优方案，
            其余方案满足全部硬约束，并与每个已生成方案至少相差 N 条稿件—评审人关系（N 由你指定）。
          </li>
        </ul>
      </section>
    )
  }

  if (!result.feasible) {
    return <FailureView result={result} />
  }

  // 备选方案批量结果：标签切换
  if (batch) {
    const safeIndex = Math.min(planIndex, batch.solutions.length - 1)
    const active = batch.solutions[safeIndex]
    const diffs = batch.solutions.map((s) => (s === batch.solutions[0] ? 0 : symmetricDifference(s, batch.solutions[0])))
    // 互换守卫：当前方案改派后仍须与每个“其余方案”保持 ≥ N 条差异
    const guard: DiversityGuard = {
      minDifference: batch.minDifference,
      otherEdgeSets: batch.solutions
        .map((s, i) => (i === safeIndex ? null : assignmentEdges(s)))
        .filter((e): e is Set<string> => e !== null)
    }
    return (
      <section>
        <div className="result-banner result-banner--ok">
          <h2>
            ✓ 分配完成
            <span className="batch-summary-text">
              共找到 <strong>{batch.solutions.length}</strong>/{batch.requestedCount} 个方案
              {batch.solutions.length > 1 && ` · 方案间至少相差 ${batch.minDifference} 条关系`}
            </span>
          </h2>
          <p>
            方案 1 为字典序最优方案（主题匹配最大化、最大负载最小化）；其余方案满足全部硬约束并满足差异条数要求。
            可切换标签对比，导出的是当前选中的方案。
          </p>
        </div>

        {batch.stopReason && (
          <div className="stress-stale-banner plan-stop-banner">⏸ {batch.stopReason}</div>
        )}

        <div className="plan-tabs" role="tablist">
          {batch.solutions.map((s, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === safeIndex}
              className={`plan-tab ${i === safeIndex ? 'active' : ''}`}
              onClick={() => setPlanIndex(i)}
            >
              <span className="plan-tab-no">
                方案 {i + 1}
                {i === 0 && <em className="plan-tab-best">最优</em>}
                {s.manuallyAdjusted && <em className="plan-tab-manual" title="该方案经过人工互换调整">✎</em>}
              </span>
              <span className="plan-tab-stats">
                匹配 <strong>{s.objective.topicMatches}</strong> · 最大负载 <strong>{s.objective.maxLoad}</strong> ·
                相对方案1差异 <strong>{diffs[i]}</strong>
              </span>
            </button>
          ))}
        </div>

        <SolutionView
          key={safeIndex}
          data={data}
          solution={active}
          stale={stale}
          onExport={() => onExport(safeIndex)}
          onApplySwap={onApplySwap}
          guard={guard}
          planMeta={{
            index: safeIndex,
            total: batch.solutions.length,
            requestedCount: batch.requestedCount,
            minDifference: batch.minDifference,
            diffToFirst: diffs[safeIndex]
          }}
        />
      </section>
    )
  }

  // 单方案成功结果（默认模式；count=1 时与历史行为完全一致）
  const single = result as AssignmentSuccess
  return (
    <SolutionView
      data={data}
      solution={single}
      stale={stale}
      onExport={() => onExport(0)}
      onApplySwap={onApplySwap}
    />
  )
}

/* ------------------------------ 失败结果 ------------------------------ */

function FailureView({ result }: { result: Extract<AssignmentResult, { feasible: false }> }) {
  const preReason = result.reasons.find((r) => r.kind === 'preassignment')
  return (
    <section>
      <div className="result-banner result-banner--fail">
        <h2>✕ 无法生成可行分配</h2>
        <p>以下硬约束无法同时满足，请按提示调整数据后重新生成（不会生成任何部分结果）：</p>
      </div>
      {preReason?.issues && preReason.issues.length > 0 && (
        <div className="reason-list">
          <div className="reason-card preassignment-reason-card">
            <span className="reason-kind">{kindLabel.preassignment}</span>
            <p className="reason-message">{preReason.message}</p>
            {(() => {
              const hasOrgIssues = preReason.issues.some((iss) => iss.organization)
              return (
                <div
                  className="preassign-issue-table"
                >
                  <div
                    className={`preassign-issue-row preassign-issue-head ${hasOrgIssues ? 'preassign-issue-row--org' : ''}`}
                  >
                    <span>稿件</span>
                    {hasOrgIssues && <span>机构</span>}
                    <span>评审人</span>
                    <span>原因</span>
                  </div>
                  {preReason.issues.map((iss) => (
                    <div
                      className={`preassign-issue-row ${hasOrgIssues ? 'preassign-issue-row--org' : ''}`}
                      key={iss.preAssignmentId}
                    >
                      <span>{iss.paperTitle ? `《${iss.paperTitle}》` : `（已删除：${iss.paperId ?? '—'}）`}</span>
                      {hasOrgIssues && (
                        <span>
                          {iss.organization ? (
                            <span className="stress-chip stress-chip--amber org-chip">🏛 {iss.organization}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </span>
                      )}
                      <span>
                        {iss.reviewerName ?? `（已删除：${iss.reviewerId ?? '—'}）`}
                        {iss.organizationReviewerNames && iss.organizationReviewerNames.length > 1 && (
                          <em className="muted preassign-issue-detail">
                            同稿同机构：{iss.organizationReviewerNames.join('、')}
                          </em>
                        )}
                      </span>
                      <span>
                        <span className="stress-chip stress-chip--red">{issueLabel[iss.reason] ?? iss.reason}</span>
                        <span className="muted preassign-issue-detail">{iss.message}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
          {result.reasons
            .filter((r) => r.kind !== 'preassignment')
            .map((r, i) => (
              <div className="reason-card" key={i}>
                <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
                <p className="reason-message">{r.message}</p>
              </div>
            ))}
        </div>
      )}
      {!preReason && (
        <div className="reason-list">
          {result.reasons.map((r, i) => (
            <div className="reason-card" key={i}>
              <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
              <p className="reason-message">{r.message}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ------------------------------ 单个方案展示 ------------------------------ */

interface PlanMeta {
  index: number
  total: number
  requestedCount: number
  minDifference: number
  diffToFirst: number
}

function SolutionView({
  data,
  solution,
  stale,
  onExport,
  onApplySwap,
  guard,
  planMeta
}: {
  data: AppData
  solution: AssignmentSuccess
  stale: boolean
  onExport: () => void
  onApplySwap: (candidate: SwapCandidate) => void
  guard?: DiversityGuard
  planMeta?: PlanMeta
}) {
  const reviewerMap = useMemo(() => new Map(data.reviewers.map((r) => [r.id, r])), [data.reviewers])
  const byPaper = useMemo(() => {
    const m = new Map<string, AssignmentSuccess['assignments']>()
    for (const a of solution.assignments) {
      const list = m.get(a.paperId) ?? []
      list.push(a)
      m.set(a.paperId, list)
    }
    return m
  }, [solution])

  const { totalRequired, totalAssigned, topicMatches, maxLoad, preassignedCount } = solution.objective

  return (
    <>
      <div className="result-banner result-banner--ok solution-banner">
        <h2>
          {planMeta ? `方案 ${planMeta.index + 1}` : '✓ 分配完成'}
          {planMeta && planMeta.index === 0 && <em className="plan-badge plan-badge--best">字典序最优</em>}
          {solution.manuallyAdjusted && (
            <span className="manual-badge" title={`已通过「分派互换」人工调整 ${solution.swapCount ?? 0} 次；录入数据未改动`}>
              ✎ 已人工调整
            </span>
          )}
        </h2>
        <div className="stat-row">
          <div className="stat">
            <strong>{totalAssigned}/{totalRequired}</strong>
            <span>分配名额</span>
          </div>
          <div className="stat">
            <strong>{topicMatches}</strong>
            <span>主题匹配数</span>
          </div>
          <div className="stat">
            <strong>{maxLoad}</strong>
            <span>评审人最大负载</span>
          </div>
          <div className="stat">
            <strong className={preassignedCount > 0 ? 'stat-pre' : undefined}>{preassignedCount}</strong>
            <span>来自预指派</span>
          </div>
          {planMeta && planMeta.index > 0 && (
            <div className="stat">
              <strong>{planMeta.diffToFirst}</strong>
              <span>相对方案 1 差异条数</span>
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={onExport}>
          ⬇ 导出当前方案 JSON{planMeta && planMeta.total > 1 ? `（方案 ${planMeta.index + 1}/${planMeta.total}）` : ''}
        </button>
      </div>

      {stale ? (
        <div className="stress-stale-banner">
          ⚠ 录入数据在生成本结果后已变化，当前分派<strong>可能已过期</strong>。
          为避免在过期方案上误改派，「分派互换」已暂停；请点击页面顶部「▶ 生成分派」刷新结果后再操作。
        </div>
      ) : (
        <SwapTool data={data} result={solution} onApply={onApplySwap} guard={guard} />
      )}

      <h3 className="subhead">逐稿分配明细</h3>
      <div className="card-list">
        {data.papers
          .filter((p) => p.reviewsRequired > 0)
          .map((p) => {
            const items = byPaper.get(p.id) ?? []
            return (
              <div className="card assignment-card" key={p.id}>
                <div className="assignment-title">
                  <span className="paper-title">{p.title || p.id}</span>
                  <span className="muted">
                    需 {p.reviewsRequired} 人 · 已分配 {items.length} 人
                  </span>
                  <div className="mini-tags">
                    {p.tags.map((t) => (
                      <span className="mini-tag mini-tag--blue" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="assignee-list">
                  {items.map((a) => {
                    const rv = reviewerMap.get(a.reviewerId)
                    return (
                      <div className={`assignee ${a.topicMatched ? 'is-match' : 'is-nomatch'}`} key={a.reviewerId}>
                        <span className="assignee-name">
                          {rv?.name ?? a.reviewerId}
                          {rv && (rv.organization ?? '').trim() && (
                            <em className="assignee-org" title="评审人机构（同一稿件每机构至多一人）">
                              🏛 {(rv.organization ?? '').trim()}
                            </em>
                          )}
                        </span>
                        {a.preassigned ? (
                          <span className="badge badge-preassigned" title="该分派来自稿件编辑区的预指派（硬约束）">
                            📌 预指派
                          </span>
                        ) : null}
                        {a.topicMatched ? (
                          <span className="badge badge-match">主题匹配</span>
                        ) : (
                          <span className="badge badge-nomatch">无直接匹配</span>
                        )}
                        {a.matchedTags.length > 0 && (
                          <div className="mini-tags">
                            {a.matchedTags.map((t) => (
                              <span className="mini-tag mini-tag--green" key={t}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
      </div>

      <h3 className="subhead">评审人负载</h3>
      <div className="load-list">
        {solution.loads.map((l) => {
          const rv = reviewerMap.get(l.reviewerId)
          const pct = l.capacity > 0 ? Math.round((l.assigned / l.capacity) * 100) : 0
          const forcedCount = solution.assignments.filter(
            (a) => a.reviewerId === l.reviewerId && a.preassigned === true
          ).length
          return (
            <div className="load-row" key={l.reviewerId}>
              <span className="load-name" title={rv?.name}>
                {rv?.name ?? l.reviewerId}
                {rv && (rv.organization ?? '').trim() && <em className="load-org" title="评审人机构">🏛 {(rv.organization ?? '').trim()}</em>}
                {forcedCount > 0 && <em className="load-preassigned" title="其中来自预指派的名额">📌 {forcedCount}</em>}
              </span>
              <div className="load-bar">
                <div
                  className={`load-fill ${pct >= 100 ? 'full' : pct >= 70 ? 'high' : ''}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <span className="load-num">
                {l.assigned}/{l.capacity}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
