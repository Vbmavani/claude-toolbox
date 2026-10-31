import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Report } from '../types'
import { parseResponses, renderTable, tally, totalUsd, usd } from './tally'
import type { ResponseUsage, Scope } from './tally'

type Engine = EngineInterface

const PANE = 'api-cost'
const REFRESH_MS = 60_000
const report = atom({ plugin: 'api-cost', key: 'report' } as const, null, {
  shape: 'report-1',
})

// A 71 MB transcript comes out of this at about 1 MB, under a second, because
// tool results and content are dropped before the text reaches the module.
const USAGE_ROWS = `
LC_ALL=C grep -F '"usage":{' "$1" | LC_ALL=C grep -F '"type":"assistant"' |
LC_ALL=C sed -E 's/^.*"message":\\{"model":"([^"]*)","id":"(msg_[^"]*)".*"stop_reason"(.*)$/{"message":{"model":"\\1","id":"\\2","role":"assistant","stop_reason"\\3/' |
tail -n +"$2"
`
const TRANSCRIPT = `ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null`
const AGENTS = `find "$1" -name 'agent-*.jsonl' 2>/dev/null`
const DESKTOP_SESSIONS = `
base="$HOME/Library/Application Support/Claude/claude-code-sessions"
[ -d "$base" ] && LC_ALL=C grep -rlF "$1" "$base"
`

const lines = (text: string) => text.split('\n').filter(Boolean)

async function sh($: Engine, script: string, ...args: string[]) {
  const { stdout } = await $.process.run(['sh', '-c', script, 'sh', ...args])

  return stdout
}

// A transcript only grows, so a size and time seen before is not read again.
const cache = new Map<string, { stamp: string; responses: ResponseUsage[] }>()

async function responsesIn($: Engine, path: string) {
  const { size, mtimeMs } = await $.fs.stat(path)
  const stamp = `${size}:${mtimeMs}`
  const hit = cache.get(path)
  if (hit?.stamp === stamp) return hit.responses

  let text = ''
  let lineCount = 0
  for (;;) {
    const { stdout, isStdoutTruncated } = await $.process.run([
      'sh', '-c', USAGE_ROWS, 'sh', path, String(lineCount + 1),
    ])
    if (!isStdoutTruncated) {
      text += stdout
      break
    }
    // Keep whole lines and ask for the rest past them.
    const whole = stdout.slice(0, stdout.lastIndexOf('\n') + 1)
    text += whole
    lineCount += lines(whole).length
  }

  const responses = parseResponses(text)
  cache.set(path, { stamp, responses })

  return responses
}

async function agentName($: Engine, path: string) {
  try {
    const meta = JSON.parse(
      await $.fs.read(path.replace(/\.jsonl$/, '.meta.json')),
    )

    return meta.description || meta.agentType || 'Subagent'
  } catch {
    return 'Subagent'
  }
}

// The session's own transcript and those of the subagents it ran.
async function scopesOf(
  $: Engine,
  id: string,
  kind: 'main' | 'sub-session',
  name: string,
): Promise<Scope[]> {
  const [path] = lines(await sh($, TRANSCRIPT, id))
  if (!path) return []

  const scopes: Scope[] = [
    { kind, name, responses: await responsesIn($, path) },
  ]
  const folder = `${path.replace(/\.jsonl$/, '')}/subagents`
  for (const agent of lines(await sh($, AGENTS, folder))) {
    const label = await agentName($, agent)
    scopes.push({
      kind: kind === 'main' ? 'agent' : 'sub-session',
      name: kind === 'main' ? label : `${name} › ${label}`,
      responses: await responsesIn($, agent),
    })
  }

  return scopes
}

type DesktopSession = {
  sessionId?: string
  cliSessionId?: string
  title?: string
  priorCliSessionIds?: string[]
}

async function desktopSessions($: Engine, needle: string) {
  const found: DesktopSession[] = []
  for (const path of lines(await sh($, DESKTOP_SESSIONS, needle))) {
    try {
      found.push(JSON.parse(await $.fs.read(path)))
    } catch {}
  }

  return found
}

// Sessions the desktop app started from this one, and from those. The CLI has no
// such link, so a terminal session has none.
async function subSessionScopes($: Engine, cliId: string) {
  const scopes: Scope[] = []
  const [self] = await desktopSessions($, `"cliSessionId":"${cliId}"`)
  const queue = self?.sessionId ? [self.sessionId] : []
  const visited = new Set(queue)

  while (queue.length) {
    const parent = queue.shift()
    const needle = `"spawnedFrom":{"sessionId":"${parent}"`
    for (const child of await desktopSessions($, needle)) {
      if (!child.sessionId || visited.has(child.sessionId)) continue
      visited.add(child.sessionId)
      queue.push(child.sessionId)
      const ids = [...(child.priorCliSessionIds ?? []), child.cliSessionId]
      for (const id of ids) {
        if (id) {
          scopes.push(
            ...(await scopesOf($, id, 'sub-session', child.title ?? id)),
          )
        }
      }
    }
  }

  return scopes
}

let isRefreshing = false

async function refresh($: Engine) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const id = await $.session.id()
    const rows = tally([
      ...(await scopesOf($, id, 'main', 'Main session')),
      ...(await subSessionScopes($, id)),
    ])
    const { cost } = await $.session.usage()
    const next: Report = {
      rows,
      scannedAt: await $.clock.now(),
      ledgerUsd: cost?.usd,
    }
    await update($, report, () => next)
    $.ui.status(rows.length ? `API cost ${usd(totalUsd(rows))}` : undefined)
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'api-cost',
      description: 'Show what this session would have cost at Claude API prices',
    })
    const started = await next(e)
    void $.ui.open({ id: PANE, title: 'API cost' })
    void refresh($)
    // Background agents and sub-sessions spend while no turn of this one ends.
    $.clock.every(REFRESH_MS, () => refresh($))

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('command.run', { command: 'api-cost' }, async $ => {
    await refresh($)
    void $.ui.open({ id: PANE, title: 'API cost' })
    const current = await read($, report)

    return { text: current ? renderTable(current) : 'No cost figures yet.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, report)

    return (
      <Box flexDirection="column">
        {current ? (
          <Markdown text={renderTable(current)} />
        ) : (
          <Text dimColor>Reading this session's transcript…</Text>
        )}
      </Box>
    )
  })
}
