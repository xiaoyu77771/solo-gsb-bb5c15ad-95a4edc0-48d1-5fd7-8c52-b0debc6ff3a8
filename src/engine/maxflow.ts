/**
 * Dinic 最大流 —— 用于硬约束（冲突 / 容量 / 人数 / 机构去重）可行性检验与不可行原因定位。
 *
 * 网络结构（含机构去重硬约束）:
 *   source -> 论文节点  (容量 = 该稿件需要的评审数)
 *   论文节点 -> （论文,机构）槽节点 (容量 1，每个非空机构一个槽，槽仅在该机构存在与该稿无冲突的成员时创建)
 *   槽节点 -> 评审人节点 (容量 1，仅在无利益冲突时连边)
 *   论文节点 -> 评审人节点 (容量 1，仅机构为空的评审人走此直连边)
 *   评审人节点 -> sink (容量 = 该评审人容量)
 *
 * 机构槽按“每篇稿件”展开：槽只汇集该稿件流向某机构的 1 个单位流量，再分流给该机构中
 * 与该稿无冲突的一位评审人，故同一稿件至多从每个机构取一人，同时不限制该机构评审人在
 * 其他稿件上再被选用；机构为空的评审人各自走论文→评审人直连边，
 * 因而“空机构仅代表本人，不与其他空值合并”。
 *
 * 最大流 = 总需求 当且仅当存在满足全部硬约束的分配方案。
 */

interface DinicEdge {
  to: number
  rev: number
  cap: number
}

class Dinic {
  private g: DinicEdge[][]
  private level: Int32Array
  private iter: Int32Array

  constructor(n: number) {
    this.g = Array.from({ length: n }, () => [])
    this.level = new Int32Array(n).fill(-1)
    this.iter = new Int32Array(n)
  }

  addEdge(from: number, to: number, cap: number): void {
    this.g[from].push({ to, rev: this.g[to].length, cap })
    this.g[to].push({ to: from, rev: this.g[from].length - 1, cap: 0 })
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1)
    this.level[s] = 0
    const queue: number[] = [s]
    let head = 0
    while (head < queue.length) {
      const v = queue[head++]
      for (const e of this.g[v]) {
        if (e.cap > 0 && this.level[e.to] < 0) {
          this.level[e.to] = this.level[v] + 1
          queue.push(e.to)
        }
      }
    }
    return this.level[t] >= 0
  }

  private dfs(v: number, t: number, f: number): number {
    if (v === t) return f
    for (let i = this.iter[v]; i < this.g[v].length; i++) {
      this.iter[v] = i
      const e = this.g[v][i]
      if (e.cap > 0 && this.level[v] < this.level[e.to]) {
        const d = this.dfs(e.to, t, Math.min(f, e.cap))
        if (d > 0) {
          e.cap -= d
          this.g[e.to][e.rev].cap += d
          return d
        }
      }
    }
    return 0
  }

  maxFlow(s: number, t: number): number {
    let flow = 0
    const INF = Number.MAX_SAFE_INTEGER
    while (this.bfs(s, t)) {
      this.iter.fill(0)
      let f: number
      while ((f = this.dfs(s, t, INF)) > 0) flow += f
    }
    return flow
  }

  /** 最大流跑完后，从 s 沿残量 > 0 的边可达的节点集合（用于最小割诊断） */
  reachableFrom(s: number): Set<number> {
    const seen = new Set<number>([s])
    const stack = [s]
    while (stack.length) {
      const v = stack.pop()!
      for (const e of this.g[v]) {
        if (e.cap > 0 && !seen.has(e.to)) {
          seen.add(e.to)
          stack.push(e.to)
        }
      }
    }
    return seen
  }
}

export interface FeasibilityInput {
  /** 每篇稿件需求 */
  demands: number[]
  /** 每位评审人容量 */
  capacities: number[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突，可分配 */
  eligible: boolean[][]
  /**
   * 每位评审人所属机构（应已去除首尾空白）。
   * 相同非空机构名归为同一机构，同一稿件对每个机构至多取 1 人；
   * 空串各自独立成组，不与其他空值合并。缺省（旧调用方）时视为全部独立、无机构约束。
   */
  organizations?: string[]
  /**
   * 机构去重的额外封禁：blockedOrgsByPaper[i] 中的机构名在稿件 i 上不再提供任何名额，
   * 用于把“已由预指派占住该机构名额”的情形从残量网中扣除。缺省表示无封禁。
   */
  blockedOrgsByPaper?: Set<string>[]
}

export interface FeasibilityResult {
  feasible: boolean
  totalRequired: number
  /** 网络最大流值（满足的名额数） */
  flow: number
  /** 最大流跑完后源点在残量网中可达的论文（局部索引）—— 不可行时即 Hall 缺陷稿件集合的核心 */
  sourceReachablePapers: number[]
}

export function checkFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { demands, capacities, eligible } = input
  const P = demands.length
  const R = capacities.length

  const orgsRaw = input.organizations ?? capacities.map(() => '')
  // 非空机构全局编号；空机构不编号（论文直连评审人，仅代表本人）
  const distinctOrgs: string[] = []
  const orgIndexByKey = new Map<string, number>()
  const orgOfReviewer: (string | null)[] = []
  for (let j = 0; j < R; j++) {
    const key = (orgsRaw[j] ?? '').trim()
    if (!key) {
      orgOfReviewer.push(null)
      continue
    }
    let oi = orgIndexByKey.get(key)
    if (oi === undefined) {
      oi = distinctOrgs.length
      orgIndexByKey.set(key, oi)
      distinctOrgs.push(key)
    }
    orgOfReviewer.push(key)
  }
  const membersByOrg = distinctOrgs.map(() => [] as number[])
  orgOfReviewer.forEach((key, j) => {
    if (key !== null) membersByOrg[orgIndexByKey.get(key)!].push(j)
  })
  const O = distinctOrgs.length

  // 节点：S | 论文(P) | 机构槽(P*O，按稿件展开) | 评审人(R) | T
  const S = 0
  const paperNode = (i: number) => 1 + i
  const orgSlotNode = (i: number, oi: number) => 1 + P + i * O + oi
  const reviewerNode = (j: number) => 1 + P + P * O + j
  const T = 1 + P + P * O + R
  const dinic = new Dinic(T + 1)

  for (let i = 0; i < P; i++) dinic.addEdge(S, paperNode(i), demands[i])

  for (let i = 0; i < P; i++) {
    const blocked = input.blockedOrgsByPaper?.[i]
    for (let oi = 0; oi < O; oi++) {
      const key = distinctOrgs[oi]
      // 预指派已占住该稿件上该机构的唯一名额：残量网中封禁该机构槽
      if (blocked?.has(key)) continue
      const members = membersByOrg[oi].filter((j) => eligible[i][j])
      if (members.length === 0) continue
      // 论文 → 该（稿件,机构）槽，容量 1：同一稿件至多从每个机构取一人
      dinic.addEdge(paperNode(i), orgSlotNode(i, oi), 1)
      // 机构槽 → 该机构中与本稿无冲突的每位评审人，容量 1
      for (const j of members) dinic.addEdge(orgSlotNode(i, oi), reviewerNode(j), 1)
    }
    // 空机构：论文 → 评审人直连（容量 1），不经机构层、不与其他空值合并
    for (let j = 0; j < R; j++) {
      if (orgOfReviewer[j] === null && eligible[i][j]) {
        dinic.addEdge(paperNode(i), reviewerNode(j), 1)
      }
    }
  }

  for (let j = 0; j < R; j++) dinic.addEdge(reviewerNode(j), T, Math.max(0, capacities[j]))

  const totalRequired = demands.reduce((a, b) => a + b, 0)
  const flow = dinic.maxFlow(S, T)
  const reachable = dinic.reachableFrom(S)

  const sourceReachablePapers: number[] = []
  for (const v of reachable) {
    if (v >= 1 && v < 1 + P) sourceReachablePapers.push(v - 1)
  }

  return {
    feasible: flow >= totalRequired,
    totalRequired,
    flow,
    sourceReachablePapers
  }
}

/**
 * 机构视角的“可承担名额上界”：在给定稿件子集 Z 上，
 * 每位评审人至多承担 min(自身容量, 在 Z 中无冲突的稿件数)，
 * 且同一机构对同一稿件至多 1 人的限制在机构组内同时生效。
 * 用与 {@link checkFeasibility} 同构的“稿件→（稿件,机构）槽→评审人→汇”网络求精确上界，
 * 供不可行诊断计算 Hall 缺口（不能简单逐人求和，否则会高估同机构可承担量）。
 */
export function orgAwareCapacityForPaperGroup(
  input: FeasibilityInput,
  paperIndices: number[],
  /**
   * 子集内每篇稿件在该上界网络中的源边容量（缺省每篇 1）。
   * 生成分派诊断传残量需求；缺席诊断传完整需求（含已固定的预指派名额）。
   */
  paperSourceDemands?: number[]
): number {
  const { capacities, eligible } = input
  const R = capacities.length

  const orgsRaw = input.organizations ?? capacities.map(() => '')
  const distinctOrgs: string[] = []
  const orgIndexByKey = new Map<string, number>()
  const orgOfReviewer: (string | null)[] = []
  for (let j = 0; j < R; j++) {
    const key = (orgsRaw[j] ?? '').trim()
    if (!key) {
      orgOfReviewer.push(null)
      continue
    }
    let oi = orgIndexByKey.get(key)
    if (oi === undefined) {
      oi = distinctOrgs.length
      orgIndexByKey.set(key, oi)
      distinctOrgs.push(key)
    }
    orgOfReviewer.push(key)
  }
  const membersByOrg = distinctOrgs.map(() => [] as number[])
  orgOfReviewer.forEach((key, j) => {
    if (key !== null) membersByOrg[orgIndexByKey.get(key)!].push(j)
  })
  const O = distinctOrgs.length

  // 节点：S | Z 中稿件(Z) | 机构槽(Z*O) | 评审人(R) | T；每篇源边容量 1
  const Z = paperIndices.length
  const zPos = new Map<number, number>()
  paperIndices.forEach((i, pos) => zPos.set(i, pos))
  const S = 0
  const paperNode = (pos: number) => 1 + pos
  const orgSlotNode = (pos: number, oi: number) => 1 + Z + pos * O + oi
  const reviewerNode = (j: number) => 1 + Z + Z * O + j
  const T = 1 + Z + Z * O + R
  const dinic = new Dinic(T + 1)

  for (let pos = 0; pos < Z; pos++) {
    const srcCap = paperSourceDemands ? paperSourceDemands[paperIndices[pos]] : 1
    dinic.addEdge(S, paperNode(pos), Math.max(0, srcCap))
  }

  for (let pos = 0; pos < Z; pos++) {
    const i = paperIndices[pos]
    const blocked = input.blockedOrgsByPaper?.[i]
    for (let oi = 0; oi < O; oi++) {
      const key = distinctOrgs[oi]
      if (blocked?.has(key)) continue
      const members = membersByOrg[oi].filter((j) => eligible[i][j])
      if (members.length === 0) continue
      dinic.addEdge(paperNode(pos), orgSlotNode(pos, oi), 1)
      for (const j of members) dinic.addEdge(orgSlotNode(pos, oi), reviewerNode(j), 1)
    }
    for (let j = 0; j < R; j++) {
      if (orgOfReviewer[j] === null && eligible[i][j]) {
        dinic.addEdge(paperNode(pos), reviewerNode(j), 1)
      }
    }
  }
  for (let j = 0; j < R; j++) {
    if (capacities[j] > 0) dinic.addEdge(reviewerNode(j), T, capacities[j])
  }
  return dinic.maxFlow(S, T)
}
