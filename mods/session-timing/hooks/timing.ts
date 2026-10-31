// Pure timing logic: transcript text in, Markdown tables out.

export type Step = {
  kind: 'Model' | 'Tool'
  name: string
  detail: string
  start: number
  end: number | null
}
export type Turn = {
  start: number
  label: string
  source: 'You' | 'Background'
  promptId: string | undefined
  steps: Step[]
}
export type Agent = { name: string; type: string; turns: Turn[] }

const MERGE_EMPTY_TURN_MS = 60_000

const lastSegment = (name: string): string =>
  name.startsWith('mcp__') ? name.split('__').at(-1) ?? name : name

const oneLine = (text: unknown, max = 60): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const baseName = (path: string): string => path.split('/').at(-1) ?? path

function toolDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const file = input.file_path ?? input.path
  if (typeof file === 'string') return baseName(file)
  const pick =
    input.description ?? input.skill ?? input.query ?? input.url ?? input.action ?? input.command
  return oneLine(pick)
}

function promptLabel(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(b => (b?.type === 'text' ? b.text : '')).join('\n')
        : ''
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''
    return oneLine(`${command[1]} ${args}`)
  }
  const plain = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, ' ')
  return oneLine(plain) || '(no text)'
}

export function parseTurns(text: string): Turn[] {
  const turns: Turn[] = []
  const requests = new Map<string, Step>()
  const tools = new Map<string, Step>()
  let turn: Turn | undefined
  let previous: number | undefined

  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue
    // A compaction summary carries the time it was started, out of order.
    if (row.isCompactSummary) continue
    const at = Date.parse(row.timestamp)
    if (Number.isNaN(at)) continue
    const content = row.message?.content
    const blocks: any[] = Array.isArray(content) ? content : []

    if (row.type === 'user') {
      const results = blocks.filter(b => b?.type === 'tool_result')
      for (const result of results) {
        const step = tools.get(result.tool_use_id)
        if (step) step.end = at
      }
      const isNewPrompt =
        results.length === 0 && (!turn || (row.promptId && row.promptId !== turn.promptId))
      if (isNewPrompt) {
        const empty = turn && turn.steps.length === 0 ? turn : undefined
        const merges = empty !== undefined && at - empty.start < MERGE_EMPTY_TURN_MS
        if (empty) turns.pop()
        turn = {
          start: merges ? empty.start : at,
          label: merges ? empty.label : promptLabel(content),
          source: (merges ? empty.source === 'Background' : row.isMeta === true)
            ? 'Background'
            : 'You',
          promptId: row.promptId,
          steps: [],
        }
        turns.push(turn)
      }
      previous = at
      continue
    }

    if (!turn) {
      turn = { start: at, label: '(no prompt)', source: 'Background', promptId: undefined, steps: [] }
      turns.push(turn)
    }
    const key = row.requestId ?? row.uuid
    let model = requests.get(key)
    if (!model) {
      model = {
        kind: 'Model',
        name: oneLine(row.message?.model ?? 'model'),
        detail: '',
        start: previous ?? at,
        end: at,
      }
      requests.set(key, model)
      turn.steps.push(model)
    }
    model.end = at
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue
      const step: Step = {
        kind: 'Tool',
        name: lastSegment(block.name),
        detail: toolDetail(block.input),
        start: at,
        end: null,
      }
      tools.set(block.id, step)
      turn.steps.push(step)
    }
    previous = at
  }
  if (turn && turn.steps.length === 0) turns.pop()
  for (const one of turns) one.steps.sort((a, b) => a.start - b.start)
  return turns
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${pad(whole % 60)}s`
  return `${Math.floor(whole / 3600)}h ${pad(Math.floor(whole / 60) % 60)}m`
}

function clock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function dated(ms: number): string {
  const d = new Date(ms)
  const month = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getMonth()]
  return `${month} ${d.getDate()} ${clock(ms)}`
}

const took = (step: Step): string =>
  step.end === null ? 'running or no result' : formatDuration(step.end - step.start)

const stepEnd = (turn: Turn): number =>
  Math.max(turn.start, ...turn.steps.map(s => s.end ?? s.start))

const table = (head: string[], rows: string[][]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')

export function renderReport(
  turns: Turn[],
  agents: Agent[],
  options: { summaryOnly?: boolean; note?: string } = {},
): string {
  if (turns.length === 0) return 'No timed steps in this session yet.'
  const start = turns[0]!.start
  const end = Math.max(...turns.map(stepEnd))
  const active = turns.reduce((sum, t) => sum + stepEnd(t) - t.start, 0)
  const out: string[] = []

  out.push(
    `**Session timing**\n\n` +
      table(
        ['Measure', 'Value'],
        [
          ['Started', dated(start)],
          ['Last activity', dated(end)],
          ['Start to last activity', formatDuration(end - start)],
          ['Active in turns', formatDuration(active)],
          ['Idle between turns', formatDuration(Math.max(0, end - start - active))],
          ['Turns', String(turns.length)],
          ['Subagents', String(agents.length)],
        ],
      ),
  )

  out.push(
    `**Turns**\n\n` +
      table(
        ['#', 'Started', 'Took', 'Steps', 'From', 'Prompt'],
        turns.map((t, i) => [
          String(i + 1),
          dated(t.start),
          formatDuration(stepEnd(t) - t.start),
          String(t.steps.length),
          t.source,
          t.label,
        ]),
      ),
  )

  const totals = new Map<string, { count: number; total: number; longest: number }>()
  const steps = [...turns, ...agents.flatMap(a => a.turns)].flatMap(t => t.steps)
  for (const step of steps) {
    if (step.end === null) continue
    const key = step.kind === 'Model' ? 'Model calls' : step.name
    const entry = totals.get(key) ?? { count: 0, total: 0, longest: 0 }
    const length = step.end - step.start
    totals.set(key, {
      count: entry.count + 1,
      total: entry.total + length,
      longest: Math.max(entry.longest, length),
    })
  }
  out.push(
    `**Where the time went, including subagents**\n\n` +
      table(
        ['Step type', 'Count', 'Total', 'Longest'],
        [...totals]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([name, t]) => [
            name,
            String(t.count),
            formatDuration(t.total),
            formatDuration(t.longest),
          ]),
      ),
  )

  if (agents.length > 0) {
    out.push(
      `**Subagents**\n\n` +
        table(
          ['#', 'Started', 'Took', 'Steps', 'Type', 'Name'],
          agents.map((a, i) => {
            const first = a.turns[0]?.start ?? 0
            const last = Math.max(first, ...a.turns.map(stepEnd))
            return [
              String(i + 1),
              first ? dated(first) : 'unknown',
              formatDuration(last - first),
              String(a.turns.reduce((n, t) => n + t.steps.length, 0)),
              a.type,
              a.name,
            ]
          }),
        ),
    )
  }

  if (!options.summaryOnly) {
    const row = (owner: string, step: Step, n: number): string[] => [
      owner,
      String(n),
      clock(step.start),
      took(step),
      step.kind,
      step.name,
      step.detail,
    ]
    const head = ['Turn', 'Step', 'Started', 'Took', 'Kind', 'Name', 'Detail']
    out.push(
      `**Every step in the main session**\n\n` +
        table(
          head,
          turns.flatMap((t, i) => t.steps.map((s, n) => row(String(i + 1), s, n + 1))),
        ),
    )
    agents.forEach((agent, i) => {
      out.push(
        `**Every step in subagent ${i + 1}: ${agent.name}**\n\n` +
          table(
            head,
            agent.turns.flatMap((t, ti) => t.steps.map((s, n) => row(String(ti + 1), s, n + 1))),
          ),
      )
    })
  }

  out.push(
    'Model steps run from the previous event to the end of the reply. Parallel tool calls overlap, so totals can exceed elapsed time. A background subagent\'s launch shows as a short Agent tool call; its real time is in the Subagents table.',
  )
  if (options.note) out.push(options.note)
  return out.join('\n\n')
}
