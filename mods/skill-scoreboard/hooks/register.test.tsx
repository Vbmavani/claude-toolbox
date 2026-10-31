import { expect, test } from 'claude-code/testing'

const stored = new Map<string, unknown>()

const engine = (on: any) => {
  stored.clear()
  on('command.register', () => ({ value: { command: 'skill-scores' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 30) }))
  on('session.id', () => ({ value: 'one' }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.read', () => ({ value: JSON.stringify({ tdd: { count: 2, sessions: 2, last: '2026-10-01' } }) }))
  on('fs.list', () => ({ value: [{ name: 'tdd' }, { name: 'humanizer' }] }))
  on('store.keys', () => ({ value: [...stored.keys()] }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: stored.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('skill.prompt', (_: unknown, e: { text: string }) => ({ text: e.text }))
}

const fire = ($: any, skill: string) =>
  $.skill.prompt({ skill, text: 'x', frontmatter: {} })

test('a firing adds to the history and counts one session', async ($, on) => {
  engine(on)
  await fire($, 'tdd')
  await fire($, 'tdd')

  expect(stored.get('skill/tdd')).toMatchObject({ count: 2, sessions: 1, last: '2026-10-30' })
})

test('a skill that fired leaves the never-fired list', async ($, on) => {
  engine(on)
  await fire($, 'plugin:humanizer')

  const text = (await $.command.run({ command: 'skill-scores' })).text
  expect(text).toContain('Fired this session: plugin:humanizer.')
  expect(text).toContain('Installed but never fired (0)')
})
