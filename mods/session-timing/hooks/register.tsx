import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, Register } from 'claude-code'

import { parseTurns, renderReport } from './timing'
import type { Agent } from './timing'
import type { Snapshot } from '../types'

const COMMAND = 'session-timing'
const PANE = 'session-timing'
const TITLE = 'Session timing'
const MAX_READ = 4_000_000
// Transcript folders are named by the engine, so find the file by session id.
const FIND_TRANSCRIPT =
  'ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -n 1'

const EMPTY: Snapshot = { text: '', isSummary: false }
const snapshot = atom({ plugin: 'session-timing', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-1',
})

// Keeps the newest part of a transcript too large for one read.
async function readTail($: Dollar, path: string): Promise<{ text: string; isCut: boolean }> {
  const { size } = await $.fs.stat(path)
  if (size <= MAX_READ) return { text: String(await $.fs.read(path)), isCut: false }
  const { stdout } = await $.process.run(['tail', '-c', String(MAX_READ), path])
  return { text: stdout.slice(stdout.indexOf('\n') + 1), isCut: true }
}

async function buildReport($: Dollar, isSummary: boolean): Promise<string> {
  const id = await $.session.id()
  const found = await $.process.run(['/bin/sh', '-c', FIND_TRANSCRIPT, 'sh', id])
  const path = found.stdout.trim()
  if (!path) return `No transcript found for session ${id}.`

  const main = await readTail($, path)
  const turns = parseTurns(main.text)

  const folder = `${path.replace(/\.jsonl$/, '')}/subagents`
  const agents: Agent[] = []
  const entries = await $.fs.list(folder).catch(() => [])
  for (const entry of entries) {
    if (!/^agent-.*\.jsonl$/.test(entry.name)) continue
    const file = `${folder}/${entry.name}`
    const meta = await $.fs
      .read(file.replace(/\.jsonl$/, '.meta.json'))
      .then(text => JSON.parse(String(text)))
      .catch(() => ({}))
    const body = await readTail($, file)
    agents.push({
      name: String(meta.description ?? entry.name).replace(/[\\|]/g, '\\$&'),
      type: String(meta.agentType ?? 'unknown'),
      turns: parseTurns(body.text),
    })
  }
  agents.sort((a, b) => (a.turns[0]?.start ?? 0) - (b.turns[0]?.start ?? 0))

  return renderReport(turns, agents, {
    summaryOnly: isSummary,
    note: main.isCut ? 'This transcript is over 4 MB, so only its newest part is timed.' : undefined,
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open a side pane showing when each step of this session started and how long it took',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const isSummary = e.args.trim() === 'summary'
    const text = await buildReport($, isSummary)
    await update($, snapshot, () => ({ text, isSummary }))
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })

    // Without a pane to hold it, the report still reaches the person.
    return { text: isPlaced ? 'Session timing is open in the side pane.' : text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const { text, isSummary } = await read($, snapshot)
    const refresh = async () => {
      const fresh = await buildReport($, isSummary)
      await update($, snapshot, one => ({ ...one, text: fresh }))
    }

    return (
      <Box flexDirection="column">
        <Button key="refresh" label="Refresh" onPress={() => void refresh()} />
        {text ? (
          <Markdown text={text} />
        ) : (
          <Text dimColor>Run /session-timing to load this session.</Text>
        )}
      </Box>
    )
  })
}
