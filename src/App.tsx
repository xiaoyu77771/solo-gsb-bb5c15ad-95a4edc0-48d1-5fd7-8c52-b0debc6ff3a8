import { useEffect, useMemo, useState } from 'react'
import type { AppData, AssignmentResult, Paper, Reviewer, StressTestReport } from './types'
import { isBatchResult } from './types'
import { createId, loadData, saveData } from './storage'
import { solveAssignmentBatch, evaluateHardConstraints } from './engine/solver'
import { runStressTest, stressFingerprint } from './engine/stress'
import { applySwapCandidate, type DiversityGuard, type SwapCandidate } from './engine/swap'
import { assignmentEdges, symmetricDifference } from './engine/alternatives'
import { createSampleData } from './sampleData'
import { buildExportPayload, buildStressExportPayload, downloadJson } from './exporter'
import { PapersPanel } from './components/PapersPanel'
import { ReviewersPanel } from './components/ReviewersPanel'
import { ResultPanel } from './components/ResultPanel'
import { StressPanel } from './components/StressPanel'
import './styles.css'

type Tab = 'papers' | 'reviewers' | 'result' | 'stress'

const EMPTY: AppData = { papers: [], reviewers: [], preAssignments: [] }

/** 备选模式表单参数（默认 1 个方案，保持现有单方案行为） */
interface GenerateOptions {
  count: number
  /** N 的文本输入，失焦/生成时再解析校验 */
  minDifferenceText: string
}

export default function App() {
  const [data, setData] = useState<AppData>(() => loadData() ?? EMPTY)
  const [tab, setTab] = useState<Tab>('papers')
  const [result, setResult] = useState<AssignmentResult | null>(null)
  const [stale, setStale] = useState(false)
  const [solving, setSolving] = useState(false)
  const [solveMillis, setSolveMillis] = useState<number | null>(null)
  const [options, setOptions] = useState<GenerateOptions>({ count: 1, minDifferenceText: '2' })
  const [activePlanIndex, setActivePlanIndex] = useState(0)
  const [stressReport, setStressReport] = useState<StressTestReport | null>(null)
  const [stressRunning, setStressRunning] = useState(false)

  // 数据变化自动持久化到 localStorage；已有结果则标记为过期
  useEffect(() => {
    saveData(data)
    setStale((s) => (result ? true : s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // 硬约束基线评估：与“生成分派”同源，压力测试只在当前数据可生成方案时可运行（每次录入变化即时重算）
  const baseline = useMemo(() => evaluateHardConstraints(data), [data])
  const baselineFeasible = baseline.feasible
  const baselineReasons = baseline.reasons.map((r) => r.message)

  // 压力测试过期判定：报告保存了运行时数据指纹，当前指纹不一致即立即标记过期（复用基线归一化结果）
  const currentFingerprint = useMemo(() => stressFingerprint(data, baseline), [data, baseline])
  const stressStale = stressReport !== null && stressReport.fingerprint !== currentFingerprint

  const conflictCountOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data.reviewers) for (const pid of r.conflictPaperIds) map.set(pid, (map.get(pid) ?? 0) + 1)
    return (paperId: string) => map.get(paperId) ?? 0
  }, [data.reviewers])

  const setPapers = (papers: Paper[]) => setData((d) => ({ ...d, papers }))
  const setReviewers = (reviewers: Reviewer[]) => setData((d) => ({ ...d, reviewers }))

  // ---- 预指派关系维护 ----
  // 关系独立存储：删除/修改稿件或评审人后，失效关系仍保留（不级联删除），
  // 由稿件编辑区显式列出并提示原因，用户可逐条移除。
  const addPreAssignment = (paperId: string, reviewerId: string) =>
    setData((d) => {
      if (d.preAssignments.some((pa) => pa.paperId === paperId && pa.reviewerId === reviewerId)) return d
      return { ...d, preAssignments: [...d.preAssignments, { id: createId('pre'), paperId, reviewerId }] }
    })
  const removePreAssignment = (id: string) =>
    setData((d) => ({ ...d, preAssignments: d.preAssignments.filter((pa) => pa.id !== id) }))

  const generate = () => {
    // 备选模式参数校验（count=1 时不需要 N，保持单方案默认行为）
    if (options.count > 1) {
      const parsed = Number(options.minDifferenceText)
      if (!/^\d+$/.test(options.minDifferenceText.trim()) || !Number.isInteger(parsed) || parsed < 1) {
        window.alert('请输入不小于 1 的整数作为最小差异条数 N。')
        return
      }
    }
    // 让“求解中”状态先渲染，再执行同步求解（大规模 ILP 可能耗时数百毫秒至数秒）
    setSolving(true)
    setTimeout(() => {
      const t0 = performance.now()
      const n = options.count > 1 ? Math.max(1, parseInt(options.minDifferenceText.trim(), 10)) : 0
      const r = solveAssignmentBatch(data, options.count, n)
      setSolveMillis(Math.round(performance.now() - t0))
      setResult(r)
      setActivePlanIndex(0)
      setStale(false)
      setSolving(false)
      setTab('result')
    }, 30)
  }

  const runStress = () => {
    // 与生成同理：先渲染“进行中”，再逐位同步跑最大流
    setStressRunning(true)
    setTimeout(() => {
      const outcome = runStressTest(data)
      if (outcome.runnable) setStressReport(outcome.report)
      setStressRunning(false)
    }, 30)
  }

  const loadSample = () => {
    if (data.papers.length || data.reviewers.length) {
      if (!window.confirm('载入示例数据将覆盖当前录入内容，是否继续？')) return
    }
    setData(createSampleData())
    setResult(null)
    setStale(false)
    setStressReport(null)
  }

  const clearAll = () => {
    if (!window.confirm('确定清空全部稿件与评审人数据？该操作不可撤销。')) return
    setData(EMPTY)
    setResult(null)
    setStale(false)
    setStressReport(null)
  }

  // 导出当前选中方案：批量结果时写入方案序号、总数、N 与相对方案 1 的差异条数
  const exportResult = (planIndex = 0) => {
    if (!result?.feasible) return
    if (isBatchResult(result)) {
      const batch = result
      const i = Math.min(planIndex, batch.solutions.length - 1)
      const current = batch.solutions[i]
      const diffToFirst = i === 0 ? 0 : symmetricDifference(batch.solutions[0], current)
      downloadJson(
        buildExportPayload(data, current, {
          index: i + 1,
          total: batch.solutions.length,
          minDifference: batch.minDifference,
          diffToFirst
        }),
        undefined
      )
    } else {
      downloadJson(buildExportPayload(data, result))
    }
  }

  // 确认一次一换一：仅在结果层改派（不改录入数据）。
  // 成功后结果仍是“成功且未过期”，并被标记为已人工调整；stale 保持 false。
  // 备选模式下传入多样性守卫，确保改派后与其余方案的差异条数不低于 N。
  const applySwap = (candidate: SwapCandidate) => {
    if (!result?.feasible || stale) return
    if (isBatchResult(result)) {
      const batch = result
      const i = Math.min(activePlanIndex, batch.solutions.length - 1)
      const current = batch.solutions[i]
      const guard: DiversityGuard = {
        minDifference: batch.minDifference,
        otherEdgeSets: batch.solutions
          .map((s, k) => (k === i ? null : assignmentEdges(s)))
          .filter((e): e is Set<string> => e !== null)
      }
      const next = applySwapCandidate(data, current, candidate, guard)
      if (next) {
        const solutions = batch.solutions.slice()
        solutions[i] = next
        setResult({ ...batch, solutions })
      }
    } else {
      const single = result as Extract<AssignmentResult, { feasible: true; kind?: undefined }>
      const next = applySwapCandidate(data, single, candidate)
      if (next) setResult(next)
    }
  }

  const exportStress = () => {
    if (stressReport) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      downloadJson(buildStressExportPayload(data, stressReport), `blind-review-absence-stress-${stamp}.json`)
    }
  }

  const totalRequired = data.papers.reduce((a, p) => a + Math.max(0, p.reviewsRequired || 0), 0)
  const totalCapacity = data.reviewers.reduce((a, r) => a + Math.max(0, r.capacity || 0), 0)

  // 备选模式：N 的上界 = 2 ×（总名额 − 预指派数），预指派在所有方案中必须相同
  const diffUpperBound = Math.max(0, 2 * (baseline.totalRequired - baseline.forced.forcedKeys.size))
  const nParse = options.count > 1 ? Number(options.minDifferenceText.trim()) : NaN
  const nInvalid =
    options.count > 1 &&
    (!/^\d+$/.test(options.minDifferenceText.trim()) || !Number.isInteger(nParse) || nParse < 1 || nParse > diffUpperBound)
  const nHint =
    options.count > 1 && !/^\d+$/.test(options.minDifferenceText.trim())
      ? 'N 必须是不小于 1 的整数'
      : options.count > 1 && Number.isInteger(nParse) && nParse > diffUpperBound
        ? `N 不能超过 ${diffUpperBound}（2 × 自由关系数；预指派 ${baseline.forced.forcedKeys.size} 条不可变）`
        : ''

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⚖</span>
          <div>
            <h1>盲审分配台</h1>
            <p>Blind Review Desk · 浏览器本地整数规划分配，数据不出本机</p>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-stat">
            稿件 {data.papers.length} · 名额 {totalRequired} · 评审人 {data.reviewers.length} · 容量 {totalCapacity}
          </span>
          <button className="btn btn-ghost" onClick={loadSample}>
            载入示例
          </button>
          <button className="btn btn-ghost danger" onClick={clearAll}>
            清空
          </button>
          <div className="generate-options" title="备选方案：生成 1～3 个满足全部硬约束的方案；第 1 个为字典序最优，其余方案与已生成方案至少相差 N 条关系">
            <label className="gen-option">
              <span className="gen-option-label">方案数</span>
              <select
                className="input gen-select"
                value={options.count}
                onChange={(e) => setOptions((o) => ({ ...o, count: parseInt(e.target.value, 10) }))}
              >
                <option value={1}>1（默认）</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            {options.count > 1 && (
              <label className={`gen-option ${nInvalid ? 'gen-option--bad' : ''}`}>
                <span className="gen-option-label">最少差异 N</span>
                <input
                  className="input gen-n-input"
                  type="number"
                  min={1}
                  max={diffUpperBound || undefined}
                  step={2}
                  value={options.minDifferenceText}
                  onChange={(e) => setOptions((o) => ({ ...o, minDifferenceText: e.target.value }))}
                />
                <span className="gen-option-hint">
                  条（对称差，偶数；上界 {diffUpperBound}）
                </span>
              </label>
            )}
          </div>
          <button
            className="btn btn-generate"
            onClick={generate}
            disabled={data.papers.length === 0 || solving || !!nInvalid}
            title={nInvalid ? nHint : undefined}
          >
            {solving ? '⏳ 本地求解中…' : '▶ 生成分派'}
          </button>
        </div>
        {options.count > 1 && nHint && <div className="gen-options-error">⚠ {nHint}</div>}
      </header>

      <nav className="tabs">
        <button className={tab === 'papers' ? 'tab active' : 'tab'} onClick={() => setTab('papers')}>
          稿件
        </button>
        <button className={tab === 'reviewers' ? 'tab active' : 'tab'} onClick={() => setTab('reviewers')}>
          评审人 / 利益冲突
        </button>
        <button className={tab === 'result' ? 'tab active' : 'tab'} onClick={() => setTab('result')}>
          分配结果
          {stale && <span className="stale-dot" title="数据已变更，结果可能过期">●</span>}
        </button>
        <button className={tab === 'stress' ? 'tab active' : 'tab'} onClick={() => setTab('stress')}>
          缺席压力测试
          {stressStale && <span className="stale-dot" title="录入数据已变化，压力测试结果已过期">●</span>}
        </button>
        {solveMillis !== null && <span className="solve-time">本地求解耗时 {solveMillis} ms</span>}
      </nav>

      <main className="content">
        {tab === 'papers' && (
          <PapersPanel
            papers={data.papers}
            reviewers={data.reviewers}
            preAssignments={data.preAssignments}
            onChange={setPapers}
            onAddPreAssignment={addPreAssignment}
            onRemovePreAssignment={removePreAssignment}
            conflictCountOf={conflictCountOf}
          />
        )}
        {tab === 'reviewers' && <ReviewersPanel papers={data.papers} reviewers={data.reviewers} onChange={setReviewers} />}
        {tab === 'result' &&
          (solving ? (
            <section className="result-empty">
              <p>⏳ 正在浏览器本地进行整数规划求解，请稍候…</p>
            </section>
          ) : (
            <ResultPanel
              data={data}
              result={result}
              stale={stale}
              onExport={exportResult}
              onApplySwap={applySwap}
              activeIndex={activePlanIndex}
              onActiveIndexChange={setActivePlanIndex}
            />
          ))}
        {tab === 'stress' && (
          <StressPanel
            data={data}
            baselineFeasible={baselineFeasible}
            baselineReasons={baselineReasons}
            report={stressReport}
            stale={stressStale}
            running={stressRunning}
            onRun={runStress}
            onExport={exportStress}
          />
        )}
      </main>

      <footer className="app-footer">
        所有计算均在浏览器内完成（javascript-lp-solver）；录入数据自动保存于 localStorage，可随时关闭页面。
      </footer>
    </div>
  )
}
