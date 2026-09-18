import { useState, type KeyboardEvent } from 'react'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  accent?: 'blue' | 'green'
}

/** 回车 / 逗号添加标签，点击 × 删除 */
export function TagInput({ tags, onChange, placeholder, accent = 'blue' }: TagInputProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim().replace(/,$/, '').trim()
    if (!v) return
    if (!tags.some((t) => t.toLowerCase() === v.toLowerCase())) onChange([...tags, v])
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className={`tag-input tag-input--${accent}`}>
      {tags.map((t) => (
        <span className="tag-chip" key={t}>
          {t}
          <button
            type="button"
            aria-label={`删除标签 ${t}`}
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={placeholder ?? '输入后回车添加'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  )
}
