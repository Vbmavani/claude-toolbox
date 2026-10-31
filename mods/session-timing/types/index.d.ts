export type Snapshot = { text: string; isSummary: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-timing': { snapshot: Shaped<Snapshot> }
  }
}
