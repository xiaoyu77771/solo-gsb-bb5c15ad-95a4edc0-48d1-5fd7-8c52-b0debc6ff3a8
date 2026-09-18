import { useMemo, useState } from 'react'
import type { Paper, PreAssignment, Reviewer } from '../types'
import { createId } from '../storage'
import { TagInput } from './TagInput'
import { derivePreAssignments } from '../engine/preassign'
import type { AppData } from '../types'

interface PapersPanelProps {
  papers: Paper[]
  reviewers: Reviewer[]
  preAssignments: PreAssignment[]
  onChange: (papers: Paper[]) => void
  onAddPreAssignment: (paperId: string, reviewerId: string) => void
  onRemovePreAssignment: (id: string) => void
  conflictCountOf: (paperId: string) => number
}

const issueLabel: Record<string, string> = {
  'paper-missing': '稿件已不存在',
  'reviewer-missing': '评审人已不存在',
  conflict: '存在利益冲突',
  'organization-duplicate': '同稿件机构重复',
  'paper-overflow': '超过该稿件名额',
  'reviewer-overload': '超过评审人容量'
}

export function PapersPanel({
  papers,
  reviewers,
  preAssignments,
  onChange,
  onAddPreAssignment,
  onRemovePreAssignment,
  conflictCountOf
}: PapersPanelProps) {  const update = (id: string, patch: Partial<Paper>) =>
    onChange(papers.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  // 删除稿件不级联删除预指派关系：关系保留下来并在下方“失效关系”区显式提示，用户可逐条移除
  const remove = (id: string) => onChange(papers.filter((p) => p.id !== id))
  const add = () =>
    onChange([
      ...papers,
      { id: createId('paper'), title: `稿件 ${papers.length + 1}`, reviewsRequired: 2, tags: [] }
    ])

  // 派生预指派状态（有效 / 失效）。失效关系不会被静默丢弃。
  const derived = useMemo(
    () => derivePreAssignments({ papers, reviewers, preAssignments } as AppData),
    [papers, reviewers, preAssignments]
  )
  const invalid = derived.filter((d) => !d.valid)
  const validCount = derived.length - invalid.length
  const invalidCount = invalid.length

  return (
    <section>
      <div className="panel-head">
        <h2>
          稿件（{papers.length}）
          {derived.length > 0 && (
            <span className="preassign-head-count">
              · 预指派 {validCount} 条有效
              {invalidCount > 0 && <span className="preassign-head-count--bad">／{invalidCount} 条待处理</span>}
            </span>
          )}
        </h2>
        <button className="btn btn-primary" onClick={add}>
          ＋ 添加稿件
        </button>
      </div>

      {papers.length === 0 && <p className="empty-hint">还没有稿件，点击右上角「添加稿件」开始录入。</p>}

      <div className="card-list">
        {papers.map((p) => (
          <PaperCard
            key={p.id}
            paper={p}
            reviewers={reviewers}
            preAssignments={preAssignments}
            onUpdate={update}
            onRemove={remove}
            onAdd={onAddPreAssignment}
            onRemovePre={onRemovePreAssignment}
            conflictCount={conflictCountOf(p.id)}
          />
        ))}
      </div>

      {invalid.length > 0 && (
        <InvalidPreAssignmentSection invalid={invalid} onRemove={onRemovePreAssignment} />
      )}
    </section>
  )
}

function PaperCard({
  paper,
  reviewers,
  preAssignments,
  onUpdate,
  onRemove,
  onAdd,
  onRemovePre,
  conflictCount
}: {
  paper: Paper
  reviewers: Reviewer[]
  preAssignments: PreAssignment[]
  onUpdate: (id: string, patch: Partial<Paper>) => void
  onRemove: (id: string) => void
  onAdd: (paperId: string, reviewerId: string) => void
  onRemovePre: (id: string) => void
  conflictCount: number
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const own = preAssignments.filter((pa) => pa.paperId === paper.id)
  const reviewerById = new Map(reviewers.map((r) => [r.id, r]))
  const assignedReviewerIds = new Set(own.map((pa) => pa.reviewerId))
  const full = own.length >= paper.reviewsRequired

  // 该稿件预指派中已占用的非空机构：再指定同机构者会被“每篇每机构至多一人”硬约束整体拒绝
  const usedOrgKeys = new Set(
    own
      .map((pa) => (reviewerById.get(pa.reviewerId)?.organization ?? '').trim())
      .filter((org) => org.length > 0)
  )

  // 标记本条预指派在当前数据下是否有效（冲突 / 超容量 / 同机构等），供卡片内联提示
  const statusOf = (pa: PreAssignment): { ok: boolean; label?: string } => {
    const rv = reviewerById.get(pa.reviewerId)
    if (!rv) return { ok: false, label: '评审人已不存在' }
    if (rv.conflictPaperIds.includes(paper.id)) return { ok: false, label: '利益冲突' }
    const org = (rv.organization ?? '').trim()
    if (org) {
      const sameOrg = own.filter(
        (x) => x.id !== pa.id && (reviewerById.get(x.reviewerId)?.organization ?? '').trim() === org
      )
      if (sameOrg.length > 0) return { ok: false, label: `同机构「${org}」重复` }
    }
    const reviewerOwn = preAssignments.filter((x) => x.reviewerId === rv.id)
    if (reviewerOwn.length > rv.capacity) return { ok: false, label: `该评审人预占 ${reviewerOwn.length} 超容量 ${rv.capacity}` }
    if (own.length > paper.reviewsRequired) return { ok: false, label: `超名额（需 ${paper.reviewsRequired}）` }
    return { ok: true }
  }

  const available = reviewers
    .filter((r) => !assignedReviewerIds.has(r.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))

  return (
    <div className="card">
      <div className="card-row">
        <input
          className="input title-input"
          value={paper.title}
          placeholder="稿件标题 / 编号"
          onChange={(e) => onUpdate(paper.id, { title: e.target.value })}
        />
        <label className="num-field">
          需求评审数
          <input
            type="number"
            min={1}
            max={20}
            value={paper.reviewsRequired}
            onChange={(e) => onUpdate(paper.id, { reviewsRequired: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
        <button className="btn btn-ghost danger" onClick={() => onRemove(paper.id)}>
          删除
        </button>
      </div>
      <div className="card-row tags-row">
        <span className="field-label">主题标签</span>
        <TagInput tags={paper.tags} onChange={(tags) => onUpdate(paper.id, { tags })} placeholder="如：机器学习、NLP" />
      </div>

      {/* ---- 预指派：0 至所需人数位必须参加评审的评审人（硬约束） ---- */}
      <div className="preassign-box">
        <div className="preassign-head-row">
          <span className="preassign-title">📌 预指派评审人</span>
          <span className="muted">
            {own.length}/{paper.reviewsRequired} 位 · 生成分派时作为硬约束保证入选
          </span>
          {!full && (
            <button className="btn btn-preassign" onClick={() => setPickerOpen((v) => !v)}>
              {pickerOpen ? '收起选择' : '＋ 指定评审人'}
            </button>
          )}
        </div>

        {own.length === 0 && <p className="empty-hint preassign-empty">暂无预指派（可选）。分派算法将自由选择评审人。</p>}

        {own.length > 0 && (
          <div className="preassign-chips">
            {own.map((pa) => {
              const rv = reviewerById.get(pa.reviewerId)
              const st = statusOf(pa)
              return (
                <span key={pa.id} className={`preassign-chip ${st.ok ? '' : 'preassign-chip--bad'}`} title={st.label}>
                  <span className="preassign-chip-name">
                    {rv?.name ?? `已删除评审人（${pa.reviewerId}）`}
                    {rv && (rv.organization ?? '').trim() && <em className="preassign-chip-org">· {(rv.organization ?? '').trim()}</em>}
                  </span>
                  {!st.ok && <em className="preassign-chip-warn">⚠ {st.label}</em>}
                  <button
                    type="button"
                    className="preassign-chip-x"
                    aria-label={`移除预指派 ${rv?.name ?? pa.reviewerId}`}
                    onClick={() => onRemovePre(pa.id)}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {full && own.length > paper.reviewsRequired && (
          <div className="preassign-inline-warn">⚠ 当前预指派 {own.length} 位，已超过该稿件所需 {paper.reviewsRequired} 位，请移除多余关系。</div>
        )}

        {pickerOpen && !full && (
          <div className="preassign-picker">
            {available.length === 0 ? (
              <p className="empty-hint">已没有更多评审人可选；可先到「评审人 / 利益冲突」页添加。</p>
            ) : (
              <div className="conflict-options">
                {available.map((r) => {
                  const conflicting = r.conflictPaperIds.includes(paper.id)
                  const reviewerOwnCount = preAssignments.filter((pa) => pa.reviewerId === r.id).length
                  const overloaded = reviewerOwnCount >= r.capacity
                  const org = (r.organization ?? '').trim()
                  const sameOrgOnPaper = org.length > 0 && usedOrgKeys.has(org)
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={`conflict-option preassign-option ${sameOrgOnPaper ? 'preassign-option--bad' : ''}`}
                      onClick={() => {
                        onAdd(paper.id, r.id)
                        if (own.length + 1 >= paper.reviewsRequired) setPickerOpen(false)
                      }}
                    >
                      <span className="preassign-plus">＋</span>
                      <span>{r.name}</span>
                      {org && <em className="preassign-org-tag" title="机构（同一稿件每机构至多一人）">🏛 {org}</em>}
                      <span className="muted">
                        预占 {reviewerOwnCount}/{r.capacity}
                      </span>
                      {conflicting && <em className="tag-overlap-hint preassign-conflict-hint">与该稿有利益冲突</em>}
                      {!conflicting && overloaded && <em className="tag-overlap-hint preassign-conflict-hint">预占将超容量</em>}
                      {!conflicting && sameOrgOnPaper && (
                        <em className="tag-overlap-hint preassign-conflict-hint">该机构已在本稿预指派（将拒绝生成）</em>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {conflictCount > 0 && (
        <div className="conflict-note">⚠ {conflictCount} 位评审人已声明与该稿件存在利益冲突</div>
      )}
    </div>
  )
}

function InvalidPreAssignmentSection({
  invalid,
  onRemove
}: {
  invalid: ReturnType<typeof derivePreAssignments>
  onRemove: (id: string) => void
}) {
  return (
    <div className="invalid-pre-box">
      <h3 className="subhead invalid-pre-title">
        ⚠ 待处理的失效预指派关系（{invalid.length}）
      </h3>
      <p className="muted invalid-pre-desc">
        以下关系因稿件或评审人被删除、新增利益冲突、名额或容量调整而不再可满足。它们<strong>不会被自动删除</strong>，
        已保留在此处；只要存在待处理关系，「生成分派」就会整体中止（不会生成部分结果）。请逐条移除，或恢复相应数据后关系将重新生效。
      </p>
      <div className="card-list">
        {invalid.map((d) => (
          <div className="card invalid-pre-card" key={d.raw.id}>
            <div className="invalid-pre-row">
              <span className="paper-title">{d.paper ? `《${d.paper.title}》` : `（稿件已删除：${d.raw.paperId}）`}</span>
              <span className="invalid-pre-arrow">→</span>
              <span className="paper-title">{d.reviewer ? d.reviewer.name : `（评审人已删除：${d.raw.reviewerId}）`}</span>
              <span className="stress-chip stress-chip--red">{d.issue ? issueLabel[d.issue.reason] : '失效'}</span>
              <button className="btn btn-ghost danger invalid-pre-remove" onClick={() => onRemove(d.raw.id)}>
                移除该关系
              </button>
            </div>
            {d.issue && <p className="reason-message invalid-pre-message">{d.issue.message}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
