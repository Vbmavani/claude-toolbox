import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, Register } from 'claude-code'

import type { Board, Row, Score } from '../types'

const PANE = 'skill-scoreboard'
const PREFIX = 'skill/'
const EMPTY: Board = { rows: [], neverFired: [], firedNow: [] }
const board = atom({ plugin: 'skill-scoreboard', key: 'board' } as const, EMPTY, {
  shape: 'board-1',
})

const merge = (seed: Partial<Score> | undefined, live: Score | undefined): Score => ({
  count: (seed?.count ?? 0) + (live?.count ?? 0),
  sessions: (seed?.sessions ?? 0) + (live?.sessions ?? 0),
  last: live?.last ?? seed?.last ?? '',
})

const loadSeed = async ($: Dollar) => {
  try {
    const text = await $.fs.read(`${$.plugin.root}/data/history.json`)

    return JSON.parse(String(text)) as Record<string, Partial<Score>>
  } catch {
    return {}
  }
}

const loadInstalled = async ($: Dollar) => {
  try {
    const home = await $.env.get('HOME')
    const entries = await $.fs.list(`${home}/.claude/skills`)

    return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'synced')
  } catch {
    return []
  }
}

const refresh = async ($: Dollar) => {
  const seed = await loadSeed($)
  const keys = (await $.store.keys()).filter(key => key.startsWith(PREFIX))
  const live: Record<string, Score> = {}
  for (const key of keys) {
    live[key.slice(PREFIX.length)] = (await $.store.get(key)) as Score
  }
  const names = [...new Set([...Object.keys(seed), ...Object.keys(live)])]
  const rows: Row[] = names
    .map(skill => ({ skill, ...merge(seed[skill], live[skill]) }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
  const installed = await loadInstalled($)
  const neverFired = installed.filter(
    name => !names.some(skill => skill === name || skill.endsWith(`:${name}`)),
  )
  await update($, board, (b): Board => ({ ...b, rows, neverFired }))
}

const report = (b: Board) =>
  [
    `Fired this session: ${b.firedNow.join(', ') || 'none'}.`,
    'Top skills (fires, sessions, last):',
    ...b.rows.slice(0, 10).map(r => `  ${r.count}  ${r.sessions}  ${r.last}  ${r.skill}`),
    `${b.rows.length} skills have fired. Installed but never fired (${b.neverFired.length}): ${b.neverFired.join(', ') || 'none'}.`,
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-scores',
      description: 'Open the skill scoreboard and print the top skills',
    })
    await refresh($)
    void $.ui.open({ id: PANE, title: 'Skill scoreboard' })

    return next(e)
  })

  on('command.run', { command: 'skill-scores' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Skill scoreboard' })

    return { text: report(await read($, board)) }
  })

  on('skill.prompt', async ($, e, next) => {
    const key = `${PREFIX}${e.skill}`
    const session = await $.session.id()
    const old = (await $.store.get(key)) as Score | undefined
    const score: Score = {
      count: (old?.count ?? 0) + 1,
      sessions: (old?.sessions ?? 0) + (old?.lastSession === session ? 0 : 1),
      last: new Date(await $.clock.now()).toISOString().slice(0, 10),
      lastSession: session,
    }
    await $.store.set(key, score)
    await update($, board, (b): Board => ({ ...b, firedNow: [...b.firedNow, e.skill] }))
    await refresh($)
    $.ui.toast(`Skill fired: ${e.skill}`)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const b = await read($, board)

    return (
      <Box flexDirection="column">
        <Text bold>This session ({b.firedNow.length})</Text>
        {b.firedNow.length === 0 && <Text dimColor>No skill has fired yet.</Text>}
        {[...new Set(b.firedNow)].slice(-5).map(skill => (
          <Text>{skill}</Text>
        ))}
        <Text> </Text>
        <Text bold>All sessions ({b.rows.length} skills)</Text>
        {b.rows.slice(0, 12).map(row => (
          <Text>
            {String(row.count).padStart(3)}  {row.skill}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Installed, never fired ({b.neverFired.length})</Text>
        {b.neverFired.slice(0, 12).map(name => (
          <Text dimColor>{name}</Text>
        ))}
      </Box>
    )
  })
}
