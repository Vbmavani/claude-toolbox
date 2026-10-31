export type Score = {
  count: number
  sessions: number
  last: string
  lastSession?: string
}

export type Row = Score & { skill: string }

export type Board = {
  rows: Row[]
  neverFired: string[]
  firedNow: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'skill-scoreboard': { board: Shaped<Board> }
  }
}
