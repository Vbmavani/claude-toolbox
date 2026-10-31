export type ScopeKind = 'main' | 'agent' | 'sub-session'

export type Row = {
  kind: ScopeKind
  scope: string
  model: string
  calls: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  webSearches: number
  // null when the model has no known price.
  usd: number | null
}

export type Report = {
  rows: Row[]
  scannedAt: number
  // What Claude Code's own ledger says for this process, when it has one.
  ledgerUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'api-cost': { report: Shaped<Report | null> }
  }
}
