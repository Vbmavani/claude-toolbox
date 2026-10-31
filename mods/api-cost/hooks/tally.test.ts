import { expect, test } from 'claude-code/testing'

import { modelKey, requestUsd } from './pricing'
import { parseResponses, renderTable, tally } from './tally'

const near = (actual: number | null, expected: number) =>
  expect(Math.abs((actual ?? Infinity) - expected) < 1e-9).toBe(true)

const row = (id: string, model: string, usage: object) =>
  JSON.stringify({
    message: { role: 'assistant', id, model, usage },
  })

test('modelKey reads suffixes and refuses a model it does not know', () => {
  expect(modelKey('claude-opus-5-5')).toBe('claude-opus-5-5')
  expect(modelKey('claude-opus-4-20250514')).toBe('claude-opus-4')
  expect(modelKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
    'claude-sonnet-4-5',
  )
  expect(modelKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(modelKey('claude-opus-4-9')).toBeUndefined()
  expect(modelKey('gpt-5')).toBeUndefined()
})

test('requestUsd prices each kind of token', () => {
  const tokens = {
    input: 1_000_000,
    write5m: 1_000_000,
    write1h: 1_000_000,
    read: 1_000_000,
    output: 1_000_000,
  }

  near(requestUsd('claude-opus-5-5', tokens), 4 + 5 + 8 + 0.2 + 20)
  near(requestUsd('claude-fable-5-1', { ...tokens, write1h: 0 }), 10 + 12.5 + 0.25 + 50)
  expect(requestUsd('nope', tokens)).toBeNull()
})

test('requestUsd applies fast mode, US-only and web search', () => {
  const tokens = { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0 }

  near(requestUsd('claude-opus-5-5', tokens, { speed: 'fast' }), 8)
  near(requestUsd('claude-opus-5-5', tokens, { geo: 'us' }), 4.4)
  near(requestUsd('claude-opus-5-5', tokens, { webSearches: 3 }), 4.03)
})

test('Haiku 5.5 pays the long rates past 100K of prompt, cache reads counted', () => {
  const zero = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }

  near(requestUsd('claude-haiku-5-5', { ...zero, read: 100_000, output: 1_000_000 }), 0.001 + 0.5)
  near(requestUsd('claude-haiku-5-5', {
      ...zero,
      input: 1,
      read: 100_000,
      output: 1_000_000,
    }), 0.0000005 + 0.005 + 2.5)
})

test('a streamed response counts once, at its last row', () => {
  const jsonl = [
    row('msg_1', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 8 }),
    row('msg_1', 'claude-opus-5-5', { input_tokens: 2, output_tokens: 186 }),
    row('msg_2', '<synthetic>', { input_tokens: 9, output_tokens: 9 }),
    'not json',
    JSON.stringify({ message: { role: 'user', usage: {} } }),
  ].join('\n')
  const responses = parseResponses(jsonl)

  expect(responses.length).toBe(1)
  expect(responses[0]?.parts[0]?.tokens.output).toBe(186)
})

test('cache writes without a TTL split count as five-minute', () => {
  const [response] = parseResponses(
    row('m', 'claude-opus-5-5', { cache_creation_input_tokens: 40 }),
  )

  expect(response?.parts[0]?.tokens.write5m).toBe(40)
})

test('an advisor iteration is priced at its own model', () => {
  const responses = parseResponses(
    row('m', 'claude-sonnet-5-5', {
      iterations: [
        { input_tokens: 1_000_000 },
        { input_tokens: 1_000_000, model: 'claude-opus-5-5' },
      ],
    }),
  )
  const rows = tally([{ kind: 'main', name: 'Main', responses }])

  expect(rows.map(r => r.usd)).toEqual([2, 4])
})

test('a fork repeats the parent rows and they count in the parent alone', () => {
  const shared = parseResponses(row('m', 'claude-opus-5-5', { input_tokens: 1 }))
  const rows = tally([
    { kind: 'main', name: 'Main', responses: shared },
    { kind: 'sub-session', name: 'Fork', responses: shared },
  ])

  expect(rows.length).toBe(1)
  expect(rows[0]?.kind).toBe('main')
})

test('the table totals what it can price and names what it cannot', () => {
  const responses = parseResponses(
    [
      row('a', 'claude-opus-5-5', { input_tokens: 1_000_000 }),
      row('b', 'mystery-1', { input_tokens: 5 }),
    ].join('\n'),
  )
  const table = renderTable({
    rows: tally([{ kind: 'main', name: 'Main | one', responses }]),
    scannedAt: 0,
  })

  expect(table).toContain('**$4.00 at Claude API prices**')
  expect(table).toContain('no price')
  expect(table).toContain('no known price: mystery-1')
  expect(table).toContain('Main \\| one')
})
