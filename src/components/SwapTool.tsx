import { useEffect, useMemo, useState } from 'react'
import type { AppData, AssignmentSuccess } from '../types'
import { enumerateSwaps, type DiversityGuard, type SwapCandidate, type SwapSide } from '../engine/swap'

interface SwapToolProps {
  data: AppData
  result: AssignmentSuccess
  onApply: (candidate: SwapCandidate) => void
  /** 备选模式：保证互换后当前方案与其余方案差异条数不低于 N（单方案模式缺省） */
  guard?: DiversityGuard
}

/**
 * 分派互换工具：选两位已有任务的评审人，列出其间全部合法一换一候选，
 * 预览交换前后稿件 / 命中标签 / 总匹配数变化，确认后只更新当前结果。
 */
export function SwapTool({ data, result, onApply, guard }: SwapToolProps) {
  const paperMap = useMemo(() => new Map(data.papers.map((p) => [p.id, p])), [data.papers])
  const reviewerMap = useMemo(() => new Map(data.reviewers.map((r) => [r.id, r])), [data.reviewers])

  // 仅列出当前已承担任务的评审人
  const busyReviewers = useMemo(() => {
    const count = new Map<string, number>()
    for (const a of result.assignments) count.set(a.reviewerId, (count.get(a.reviewerId) ?? 0) + 1)
    return result.loads
      .filter((l) => (count.get(l.reviewerId) ?? 0) > 0)
      .map((l) => ({ id: l.reviewerId, name: reviewerMap.get(l.reviewerId)?.name ?? l.reviewerId, assigned: count.get(l.reviewerId) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))
  }, [result, reviewerMap])

  const [reviewerAId, setReviewerAId] = useState('')
  const [reviewerBId, setReviewerBId] = useState('')

  // 结果被替换（应用互换 / 重新生成）后，清掉可能已失效的选择
  useEffect(() => {
    setReviewerAId('')
    setReviewerBId('')
  }, [result])

  const enumeration = useMemo(() => {
    if (!reviewerAId || !reviewerBId) return null
    return enumerateSwaps(data, result, reviewerAId, reviewerBId, guard)
  }, [data, result, reviewerAId, reviewerBId, guard])

  const paperTitle = (id: string) => paperMap.get(id)?.title ?? id
  const reviewerName = (id: string) => reviewerMap.get(id)?.name ?? id

  return (
    <div className="swap-tool">
      <div className="swap-tool-head">
        <h3 className="subhead swap-title">🔀 分派互换（一换一）</h3>
        <p className="muted swap-desc">
          选择两位<strong>已有任务</strong>的评审人，枚举其任务之间所有一换一候选；
          自动排除同稿（交换后组合不变）、交换后触发利益冲突、让同一评审人重复承担同一稿件、
          让<strong>同一稿件出现同一机构两位评审人</strong>（机构去重硬约束）的项，
          以及<strong>预指派</strong>分派（硬约束不允许互换换走）
          {guard && guard.otherEdgeSets.length > 0 && (
            <>
              ；备选模式下还会排除让本方案与其余方案<strong>差异少于 {guard.minDifference} 条</strong>的互换
            </>
          )}
          ，
          候选按主题匹配净增从高到低排列。确认后仅改派当前结果，录入数据不变。
        </p>
      </div>

      <div className="swap-pickers">
        <label className="swap-picker">
          <span className="field-label">评审人 A</span>
          <select
            className="input swap-select"
            value={reviewerAId}
            onChange={(e) => {
              const v = e.target.value
              // 避免两位选成同一人：若与对方相同则交换两人的位置（仍指向刚选中的人在 A）
              if (v && v === reviewerBId) {
                setReviewerBId(reviewerAId)
                setReviewerAId(v)
              } else {
                setReviewerAId(v)
              }
            }}
          >
            <option value="">请选择…</option>
            {busyReviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（承担 {r.assigned} 篇）
              </option>
            ))}
          </select>
        </label>
        <span className="swap-arrows" aria-hidden>
          ⇄
        </span>
        <label className="swap-picker">
          <span className="field-label">评审人 B</span>
          <select
            className="input swap-select"
            value={reviewerBId}
            onChange={(e) => {
              const v = e.target.value
              if (v && v === reviewerAId) {
                setReviewerAId(reviewerBId)
                setReviewerBId(v)
              } else {
                setReviewerBId(v)
              }
            }}
          >
            <option value="">请选择…</option>
            {busyReviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}（承担 {r.assigned} 篇）
              </option>
            ))}
          </select>
        </label>
      </div>

      {(!reviewerAId || !reviewerBId) && (
        <p className="empty-hint">请先在上方各选一位已承担稿件的评审人。</p>
      )}

      {reviewerAId && reviewerBId && reviewerAId === reviewerBId && (
        <p className="empty-hint">两位评审人不能相同。</p>
      )}

      {enumeration && reviewerAId !== reviewerBId && (
        <>
          <div className="swap-summary">
            共枚举到 <strong>{enumeration.candidates.length}</strong> 个可行互换候选
            {enumeration.candidates.length === 0 && '——这两位评审人的现有任务之间没有可安全互换的组合'}
            {(enumeration.excluded.samePaper +
              enumeration.excluded.conflict +
              enumeration.excluded.duplicate +
              enumeration.excluded.organization +
              enumeration.excluded.preassigned +
              enumeration.excluded.diversity >
              0) && (
              <span className="muted">
                （已排除：同稿/组合不变 {enumeration.excluded.samePaper}，利益冲突 {enumeration.excluded.conflict}
                ，重复承担 {enumeration.excluded.duplicate}，同机构 {enumeration.excluded.organization}
                ，预指派 {enumeration.excluded.preassigned}
                {enumeration.excluded.diversity > 0 && `，备选差异不足 ${enumeration.excluded.diversity}`}）
              </span>
            )}
          </div>

          {enumeration.candidates.length > 0 && (
            <div className="swap-candidate-list">
              {enumeration.candidates.map((c, idx) => (
                <SwapCandidateCard
                  key={`${c.sideA.fromPaperId}-${c.sideB.fromPaperId}`}
                  candidate={c}
                  index={idx}
                  paperTitle={paperTitle}
                  reviewerName={reviewerName}
                  onApply={() => onApply(c)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SwapCandidateCard({
  candidate,
  index,
  paperTitle,
  reviewerName,
  onApply
}: {
  candidate: SwapCandidate
  index: number
  paperTitle: (id: string) => string
  reviewerName: (id: string) => string
  onApply: () => void
}) {
  const delta = candidate.deltaMatches
  const deltaCls = delta > 0 ? 'swap-delta--up' : delta < 0 ? 'swap-delta--down' : 'swap-delta--flat'
  const deltaText = delta > 0 ? `+${delta}` : `${delta}`
  return (
    <div className="card swap-card">
      <div className="swap-card-head">
        <span className="swap-candidate-no">#{index + 1}</span>
        <span className={`swap-delta ${deltaCls}`}>
          主题匹配净变化 {delta > 0 ? '▲' : delta < 0 ? '▼' : '＝'} {deltaText}
        </span>
        <button className="btn btn-primary swap-apply" onClick={onApply}>
          ✓ 确认互换
        </button>
      </div>
      <div className="swap-sides">
        <SwapSideRow side={candidate.sideA} paperTitle={paperTitle} reviewerName={reviewerName} />
        <div className="swap-cross" aria-hidden>
          ⇅
        </div>
        <SwapSideRow side={candidate.sideB} paperTitle={paperTitle} reviewerName={reviewerName} />
      </div>
    </div>
  )
}

function SwapSideRow({
  side,
  paperTitle,
  reviewerName
}: {
  side: SwapSide
  paperTitle: (id: string) => string
  reviewerName: (id: string) => string
}) {
  return (
    <div className="swap-side">
      <div className="swap-reviewer">{reviewerName(side.reviewerId)}</div>
      <div className={`swap-assignment ${side.fromMatched ? 'is-match' : 'is-nomatch'}`}>
        <span className="swap-tag-label">交换前</span>
        <span className="paper-title">《{paperTitle(side.fromPaperId)}》</span>
        <MatchBadge matched={side.fromMatched} tags={side.fromMatchedTags} />
      </div>
      <div className="swap-arrow-down" aria-hidden>
        ↓
      </div>
      <div className={`swap-assignment ${side.toMatched ? 'is-match' : 'is-nomatch'}`}>
        <span className="swap-tag-label">交换后</span>
        <span className="paper-title">《{paperTitle(side.toPaperId)}》</span>
        <MatchBadge matched={side.toMatched} tags={side.toMatchedTags} />
      </div>
    </div>
  )
}

function MatchBadge({ matched, tags }: { matched: boolean; tags: string[] }) {
  return (
    <span className="swap-match">
      {matched ? <span className="badge badge-match">主题匹配</span> : <span className="badge badge-nomatch">无直接匹配</span>}
      {tags.length > 0 && (
        <span className="mini-tags">
          {tags.map((t) => (
            <span className="mini-tag mini-tag--green" key={t}>
              {t}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
