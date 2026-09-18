import { useState } from 'react'
import type { Paper, Reviewer } from '../types'
import { createId } from '../storage'
import { TagInput } from './TagInput'

interface ReviewersPanelProps {
  papers: Paper[]
  reviewers: Reviewer[]
  onChange: (reviewers: Reviewer[]) => void
}

export function ReviewersPanel({ papers, reviewers, onChange }: ReviewersPanelProps) {
  const [openConflicts, setOpenConflicts] = useState<string | null>(null)

  const update = (id: string, patch: Partial<Reviewer>) =>
    onChange(reviewers.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const remove = (id: string) => onChange(reviewers.filter((r) => r.id !== id))
  const add = () =>
    onChange([
      ...reviewers,
      {
        id: createId('rev'),
        name: `评审人 ${reviewers.length + 1}`,
        organization: '',
        tags: [],
        capacity: 2,
        conflictPaperIds: []
      }
    ])

  const toggleConflict = (r: Reviewer, paperId: string) => {
    const has = r.conflictPaperIds.includes(paperId)
    update(r.id, {
      conflictPaperIds: has
        ? r.conflictPaperIds.filter((id) => id !== paperId)
        : [...r.conflictPaperIds, paperId]
    })
  }

  return (
    <section>
      <div className="panel-head">
        <h2>评审人（{reviewers.length}）</h2>
        <button className="btn btn-primary" onClick={add}>
          ＋ 添加评审人
        </button>
      </div>

      {reviewers.length === 0 && <p className="empty-hint">还没有评审人，点击右上角「添加评审人」开始录入。</p>}

      <div className="card-list">
        {reviewers.map((r) => (
          <div className="card" key={r.id}>
            <div className="card-row">
              <input
                className="input title-input"
                value={r.name}
                placeholder="评审人姓名 / 编号"
                onChange={(e) => update(r.id, { name: e.target.value })}
              />
              <label className="org-field" title="机构值去除首尾空白后完全相同者视为同一机构；留空表示无机构（仅代表本人，不与其他空值合并）">
                机构
                <input
                  className="input org-input"
                  value={r.organization ?? ''}
                  placeholder="如：清华大学（可留空）"
                  onChange={(e) => update(r.id, { organization: e.target.value })}
                />
              </label>
              <label className="num-field">
                容量（最多审稿）
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={r.capacity}
                  onChange={(e) => update(r.id, { capacity: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <button
                className={`btn ${r.conflictPaperIds.length > 0 ? 'btn-warn' : 'btn-ghost'}`}
                onClick={() => setOpenConflicts(openConflicts === r.id ? null : r.id)}
              >
                ⚖ 利益冲突（{r.conflictPaperIds.length}）
              </button>
              <button className="btn btn-ghost danger" onClick={() => remove(r.id)}>
                删除
              </button>
            </div>
            <div className="card-row tags-row">
              <span className="field-label">擅长标签</span>
              <TagInput
                tags={r.tags}
                accent="green"
                onChange={(tags) => update(r.id, { tags })}
                placeholder="如：机器学习、安全"
              />
            </div>

            {openConflicts === r.id && (
              <div className="conflict-box">
                <p className="conflict-box-title">勾选该评审人需要回避（利益冲突）的稿件：</p>
                {papers.length === 0 ? (
                  <p className="empty-hint">暂无稿件可选。</p>
                ) : (
                  <div className="conflict-options">
                    {papers.map((p) => (
                      <label key={p.id} className="conflict-option">
                        <input
                          type="checkbox"
                          checked={r.conflictPaperIds.includes(p.id)}
                          onChange={() => toggleConflict(r, p.id)}
                        />
                        <span>{p.title || p.id}</span>
                        {r.tags.some((t) => p.tags.some((pt) => pt.toLowerCase() === t.toLowerCase())) && (
                          <em className="tag-overlap-hint">主题相关</em>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
