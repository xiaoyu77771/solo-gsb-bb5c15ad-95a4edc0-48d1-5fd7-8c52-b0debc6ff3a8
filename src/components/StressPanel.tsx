import type { AppData, StressScenario, StressTestReport } from '../types'

interface StressPanelProps {
  data: AppData
  /** 当前数据本身是否满足硬约束（可生成方案）——只有满足时压力测试才可运行 */
  baselineFeasible: boolean
  /** 基线不可行时的原因（与“生成分派”同源） */
  baselineReasons: string[]
  report: StressTestReport | null
  stale: boolean
  running: boolean
  onRun: () => void
  onExport: () => void
}

export function StressPanel({
  data,
  baselineFeasible,
  baselineReasons,
  report,
  stale,
  running,
  onRun,
  onExport
}: StressPanelProps) {
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  const paperMap = new Map(data.papers.map((p) => [p.id, p]))

  return (
    <section>
      <div className="result-banner result-banner--ok">
        <h2>🧪 评审人缺席压力测试</h2>
        <p>
          逐位模拟容量 &gt; 0 的评审人<strong>完全缺席</strong>（容量临时置 0，不改动录入数据与当前分配），
          再用与生成分派完全相同的硬约束逻辑（利益冲突 / 容量 / 人数 / 机构去重，含机构层的 Dinic 最大流）重新判定是否仍可分配。
        </p>
        <div className="stress-actions">
          <button
            className="btn btn-primary"
            onClick={onRun}
            disabled={!baselineFeasible || running}
            title={baselineFeasible ? undefined : '当前数据尚不能生成可行方案，无法进行压力测试'}
          >
            {running ? '⏳ 压力测试进行中…' : report ? '↻ 重新运行压力测试' : '▶ 运行压力测试'}
          </button>
          {report && !stale && (
            <button className="btn" onClick={onExport}>
              ⬇ 导出压力测试报告 JSON
            </button>
          )}
        </div>
      </div>

      {!baselineFeasible && (
        <div className="result-banner result-banner--fail">
          <h2>✕ 当前数据无法生成可行方案，压力测试不可运行</h2>
          <p>缺席只会让容量更少、冲突约束更紧。请先在「分配结果」页按以下原因调整录入数据，能生成方案后再运行：</p>
          <ul className="stress-baseline-reasons">
            {baselineReasons.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {baselineFeasible && !report && !running && (
        <div className="result-empty">
          <p>当前数据可生成方案。点击「运行压力测试」，系统将对每位容量 &gt; 0 的评审人分别模拟一次缺席。</p>
          <ul>
            <li>
              <strong>仍可分配</strong>：该评审人缺席后，其余人仍能在全部硬约束下完成所有稿件的评审；
            </li>
            <li>
              <strong>不可分配</strong>：列出缺席者、受影响稿件、名额缺口（Hall 紧见证 + 全局剩余容量两个口径）与可选评审人瓶颈，而不只是总容量不足。
            </li>
          </ul>
        </div>
      )}

      {running && (
        <div className="result-empty">
          <p>⏳ 正在逐位模拟评审人缺席并运行最大流可行性判定，请稍候…</p>
        </div>
      )}

      {report && !running && (
        <>
          {stale && (
            <div className="stress-stale-banner">
              ⚠ 录入数据自上次压力测试（{new Date(report.runAt).toLocaleString()}）后已变化，以下结果<strong>已过期</strong>，请点击「重新运行压力测试」。
            </div>
          )}

          <div className="stat-row">
            <div className="stat">
              <strong>{report.testedReviewerCount}</strong>
              <span>受测评审人（容量&gt;0）</span>
            </div>
            <div className="stat">
              <strong className="stat-green">{report.feasibleCount}</strong>
              <span>缺席后仍可分配</span>
            </div>
            <div className="stat">
              <strong className={report.infeasibleCount > 0 ? 'stat-red' : 'stat-green'}>
                {report.infeasibleCount}
              </strong>
              <span>缺席后不可分配（单点风险）</span>
            </div>
            <div className="stat">
              <strong>
                {report.totalRequired}/{report.totalCapacity}
              </strong>
              <span>总需求名额 / 总容量</span>
            </div>
          </div>

          <h3 className="subhead">
            不可分配（{report.infeasibleCount}）
            <span className="muted"> —— 这些评审人一旦缺席，当前硬约束下无可行方案</span>
          </h3>
          <ScenarioList
            scenarios={report.scenarios.filter((s) => !s.feasible)}
            reviewerMap={reviewerMap}
            paperMap={paperMap}
            empty="无：任意一位容量大于 0 的评审人缺席，方案都仍可分配，团队具备单点缺席韧性。"
            tone="fail"
          />

          <h3 className="subhead">
            仍可分配（{report.feasibleCount}）
            <span className="muted"> —— 这些评审人缺席后仍有可行方案</span>
          </h3>
          <ScenarioList
            scenarios={report.scenarios.filter((s) => s.feasible)}
            reviewerMap={reviewerMap}
            paperMap={paperMap}
            empty="无。"
            tone="ok"
          />
        </>
      )}
    </section>
  )
}

function ScenarioList({
  scenarios,
  reviewerMap,
  paperMap,
  empty,
  tone
}: {
  scenarios: StressScenario[]
  reviewerMap: Map<string, { name: string }>
  paperMap: Map<string, { title: string }>
  empty: string
  tone: 'ok' | 'fail'
}) {
  if (scenarios.length === 0) return <p className="empty-hint">{empty}</p>
  return (
    <div className="card-list">
      {scenarios.map((s) => {
        const name = reviewerMap.get(s.reviewerId)?.name ?? s.reviewerId
        return (
          <div className={`card stress-card ${tone === 'fail' ? 'stress-card--fail' : 'stress-card--ok'}`} key={s.reviewerId}>
            <div className="stress-card-head">
              <span className={`stress-verdict ${tone === 'fail' ? 'stress-verdict--fail' : 'stress-verdict--ok'}`}>
                {tone === 'fail' ? '✕ 不可分配' : '✓ 仍可分配'}
              </span>
              <span className="stress-reviewer-name">缺席者：{name}</span>
              <span className="muted">原容量 {s.capacity}</span>
              {!s.feasible && s.globalDeficit !== undefined && (
                <span className={`stress-chip ${s.globalDeficit > 0 ? 'stress-chip--red' : 'stress-chip--amber'}`}>
                  {s.globalDeficit > 0
                    ? `全局名额缺口 ${s.globalDeficit}`
                    : '全局总容量够 · 组合性瓶颈'}
                </span>
              )}
              {!s.feasible && typeof s.deficit === 'number' && (
                <span className="stress-chip stress-chip--red">瓶颈名额缺口 {s.deficit}</span>
              )}
            </div>

            <p className="reason-message">{s.message}</p>

            {!s.feasible && s.affectedPapers && s.affectedPapers.length > 0 && (
              <div className="stress-detail">
                <div className="stress-detail-title">受影响稿件（{s.affectedPapers.length}）</div>
                <div className="stress-paper-list">
                  {s.affectedPapers.map((p) => (
                    <div className="stress-paper-row" key={p.paperId}>
                      <span className="paper-title">《{paperMap.get(p.paperId)?.title ?? p.paperId}》</span>
                      <span className="muted">需 {p.required} 人</span>
                      <span className="muted">剩余可选 {p.available} 人</span>
                      {p.shortfall > 0 && <span className="stress-chip stress-chip--red">单篇缺口 {p.shortfall}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!s.feasible && s.bottleneckReviewers && s.bottleneckReviewers.length > 0 && (
              <div className="stress-detail">
                <div className="stress-detail-title">可选评审人瓶颈（{s.bottleneckReviewers.length}）</div>
                <div className="stress-bottleneck-list">
                  {s.bottleneckReviewers.map((b) => (
                    <div className="stress-bottleneck-row" key={b.reviewerId}>
                      <span className="stress-bottleneck-name">
                        {reviewerMap.get(b.reviewerId)?.name ?? b.reviewerId}
                      </span>
                      <span className="muted">容量 {b.capacity}</span>
                      <span className="muted">对受影响稿件可评 {b.eligiblePaperCount} 篇</span>
                      <span className="stress-chip stress-chip--amber">至多承担 {b.capacityForGroup} 名额</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
