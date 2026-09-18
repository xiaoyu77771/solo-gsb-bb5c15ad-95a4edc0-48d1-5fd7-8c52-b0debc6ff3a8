declare module 'javascript-lp-solver' {
  export interface SolveResult {
    feasible?: boolean
    result?: number
    bounded?: boolean
    [variable: string]: number | boolean | undefined
  }

  export interface Model {
    optimize: string
    opType: 'max' | 'min'
    constraints: Record<string, Record<string, number> & { min?: number; max?: number; equal?: number }>
    variables: Record<string, Record<string, number>>
    binaries?: Record<string, number>
    ints?: Record<string, number>
  }

  interface Solver {
    Solve(model: Model): SolveResult
  }
  const solver: Solver
  export default solver
}
