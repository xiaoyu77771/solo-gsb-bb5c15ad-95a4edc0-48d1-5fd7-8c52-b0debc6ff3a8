import type { AppData, Paper, PreAssignment, Reviewer } from './types'

const STORAGE_KEY = 'blind-review-desk:data:v1'

/**
 * 兼容旧数据：preAssignments、reviewers[].organization 与 papers[].requiredTopicTags 都是后加字段，
 * 旧版本 localStorage 中没有这些键。不升级存储 key、不迁移文件，读取时补全即可；
 * 缺少机构字段的评审人按空机构加载（空值仅代表本人，不与其他空值合并）；
 * 缺少必覆盖主题的稿件按空数组加载（即无必覆盖主题，规则不生效）；
 * 失效（引用已删除）的关系也原样保留，由录入界面显式提示、用户逐条移除。
 */
function migrate(raw: unknown): AppData | null {
  if (!raw || typeof raw !== 'object') return null
  const parsed = raw as Partial<AppData>
  if (!Array.isArray(parsed.papers) || !Array.isArray(parsed.reviewers)) return null
  const preAssignments: PreAssignment[] = []
  if (Array.isArray(parsed.preAssignments)) {
    // 容忍历史脏数据：过滤结构非法项，并对同（稿件，评审人）关系去重，保留首次出现的一条
    const seen = new Set<string>()
    for (const pa of parsed.preAssignments as PreAssignment[]) {
      if (!pa || typeof pa.id !== 'string' || typeof pa.paperId !== 'string' || typeof pa.reviewerId !== 'string') continue
      const key = `${pa.paperId}|${pa.reviewerId}`
      if (seen.has(key)) continue
      seen.add(key)
      preAssignments.push(pa)
    }
  }
  // 旧本地数据评审人可能缺少机构字段：按空值加载，求解时再做去空白归一化
  const reviewers: Reviewer[] = (parsed.reviewers as Reviewer[]).map((r) =>
    r && typeof r === 'object' ? { ...r, organization: typeof r.organization === 'string' ? r.organization : '' } : r
  )
  // 旧本地数据稿件可能缺少“必覆盖主题”字段：默认空数组（无必覆盖主题）；
  // 容忍脏数据（非数组/含非字符串项），候选与残留剪除在求解归一化阶段完成
  const papers = (parsed.papers as Paper[]).map((p) =>
    p && typeof p === 'object'
      ? {
          ...p,
          requiredTopicTags: Array.isArray(p.requiredTopicTags)
            ? p.requiredTopicTags.filter((t): t is string => typeof t === 'string')
            : []
        }
      : p
  )
  return {
    papers,
    reviewers,
    preAssignments
  }
}

export function loadData(): AppData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return migrate(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveData(data: AppData): void {
  try {
    // 始终写入完整结构（旧数据加载后 preAssignments 已补全），保持对旧版本字段的超集兼容
    const payload: AppData = { papers: data.papers, reviewers: data.reviewers, preAssignments: data.preAssignments ?? [] }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (err) {
    console.warn('localStorage 持久化失败：', err)
  }
}

export function createId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}
