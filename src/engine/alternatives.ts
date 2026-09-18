/**
 * 备选方案（alternative plans）支持：方案间“稿件—评审人关系”差异度量。
 *
 * 一条“稿件—评审人关系”即最终分派中的一个 `(paperId, reviewerId)` 对。
 * 两个方案的差异条数按**对称差**计算：
 *
 *   diff(A, B) = |edges(A) \\ edges(B)| + |edges(B) \\ edges(A)|
 *
 * 由于每个可行方案的分派条数相同（各稿需求之和），两集合等大，对称差恒为偶数：
 * 2 × 仅属于其中一个方案的关系条数。用户输入奇数 N（如 3）时等价于 N+1（4），
 * 即“至少 N 条不同”按不少于 N 的最小可实现偶数处理。
 */
import type { AssignmentSuccess } from '../types'

/** 提取一份方案的关系集合（paperId ␟ reviewerId） */
export function assignmentEdges(result: AssignmentSuccess): Set<string> {
  const edges = new Set<string>()
  for (const a of result.assignments) edges.add(`${a.paperId}␟${a.reviewerId}`)
  return edges
}

/** 两个方案的关系对称差条数（恒为偶数：两方案分派总数相等） */
export function symmetricDifference(a: AssignmentSuccess, b: AssignmentSuccess): number {
  return symmetricDifferenceOfEdges(assignmentEdges(a), assignmentEdges(b))
}

/** 关系集合之间的对称差条数（供批量生成后用下标集合复核） */
export function symmetricDifferenceOfEdges(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const k of a) if (!b.has(k)) n++
  for (const k of b) if (!a.has(k)) n++
  return n
}

/** 仅属于其中一个方案的关系条数（= 对称差 / 2） */
export function oneSidedDifference(a: AssignmentSuccess, b: AssignmentSuccess): number {
  return symmetricDifference(a, b) >> 1
}

/**
 * 备选方案的最大可实现对称差上界：预指派（forced）关系在每个可行方案中都相同，
 * 只有 totalRequired − 预指派数 条自由关系可以不同；两边完全错开时对称差为 2 × 自由数。
 */
export function maxPossibleDifference(result: AssignmentSuccess): number {
  const preassigned = result.objective.preassignedCount ?? 0
  return 2 * Math.max(0, result.objective.totalRequired - preassigned)
}

/**
 * 校验备选模式参数。返回规范化后的最小差异 N（奇数升为下一偶数）；
 * 参数本身不合法（数量不在 1～3、N 非正整数）或 N 超过当前数据上界时，返回错误信息。
 */
export function validateBatchOptions(args: {
  requestedCount: number
  minDifferenceInput: number
  /** 仅用于计算上界：任取一个可行方案即可 */
  reference: AssignmentSuccess
}): { ok: true; minDifference: number } | { ok: false; message: string } {
  const { requestedCount, minDifferenceInput, reference } = args
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 3) {
    return { ok: false, message: '方案数量必须是 1～3 之间的整数。' }
  }
  if (requestedCount === 1) return { ok: true, minDifference: 0 }
  if (!Number.isInteger(minDifferenceInput) || minDifferenceInput < 1) {
    return { ok: false, message: '最小差异条数 N 必须是不小于 1 的整数。' }
  }
  const upper = maxPossibleDifference(reference)
  if (minDifferenceInput > upper) {
    const preassigned = reference.objective.preassignedCount ?? 0
    return {
      ok: false,
      message:
        `最小差异 N=${minDifferenceInput} 超出当前数据可实现的上界 ${upper}` +
        `（共 ${reference.objective.totalRequired} 条分派，其中 ${preassigned} 条预指派在所有方案中必须相同，` +
        `最多只有 ${Math.max(0, reference.objective.totalRequired - preassigned)} 条自由关系可变；` +
        `差异按“关系增删条数”计，完全错开为 2 倍自由关系数）。请调小 N 或减少预指派。`
    }
  }
  return { ok: true, minDifference: minDifferenceInput }
}
