import { expect, test } from 'claude-code/testing'

import { parseTurns } from './timing'

const rows = [
  { type: 'user', timestamp: '2026-10-31T13:00:00.000Z', promptId: 'p1', message: { content: 'hello there' } },
  { type: 'assistant', timestamp: '2026-10-31T13:00:02.000Z', requestId: 'r1', message: { model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'List files' } }] } },
  { type: 'user', timestamp: '2026-10-31T13:00:07.000Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
  { type: 'assistant', timestamp: '2026-10-31T13:00:08.000Z', requestId: 'r2', message: { model: 'm', content: [{ type: 'text', text: 'done' }] } },
].map(r => JSON.stringify(r)).join('\n')

const FOUND = {
  exitCode: 0,
  stdout: '/x/abc.jsonl\n',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

const PANE = {
  plugin: 'session-timing',
  component: 'Pane',
  requestId: 'session-timing',
  props: {
    title: 'Session timing',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the command draws the tables in the pane and opens it only then', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'session-timing' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc' }))
  on('process.run', () => ({ value: FOUND }))
  on('fs.stat', () => ({ value: { kind: 'file', size: rows.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: rows }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => {
    opens += 1
    return { value: { isPlaced: true } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens).toBe(0)

  const result = await $.command.run({ command: 'session-timing', args: '' } as never)
  expect(opens).toBe(1)
  expect(result.text).toBe('Session timing is open in the side pane.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const body = await ui.find({ type: 'Markdown' })
  expect(body?.text).toContain('hello there')
  expect(body?.text).toContain('| Bash | List files |')
  expect(body?.text).toContain('| 5.0s | Tool')
  expect(body?.text).toContain('Every step in the main session')
  await ui.unmount()
})

test('with no pane placed, the command answers with the report', async ($, on) => {
  on('session.id', () => ({ value: 'abc' }))
  on('process.run', () => ({ value: FOUND }))
  on('fs.stat', () => ({ value: { kind: 'file', size: rows.length, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: rows }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no room' } }))

  const result = await $.command.run({ command: 'session-timing', args: 'summary' } as never)

  expect(result.text).toContain('hello there')
  expect(result.text).not.toContain('Every step in the main session')
})

test('a compaction summary does not stretch the next model call', () => {
  const text = [
    { type: 'user', timestamp: '2026-10-31T16:41:46.000Z', promptId: 'p1', message: { content: 'go' } },
    { type: 'user', timestamp: '2026-10-31T16:16:34.000Z', promptId: 'p1', isCompactSummary: true, message: { content: 'summary' } },
    { type: 'assistant', timestamp: '2026-10-31T16:41:47.000Z', requestId: 'r1', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } },
  ].map(r => JSON.stringify(r)).join('\n')

  const step = parseTurns(text)[0]!.steps[0]!

  expect(step.end! - step.start).toBe(1000)
})
