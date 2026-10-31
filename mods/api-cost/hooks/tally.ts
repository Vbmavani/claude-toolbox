import type { Report, Row, ScopeKind } from '../types'
import { PRICES_AS_OF, requestUsd, type Tokens } from './pricing'

// One API response, as the last transcript row holding its id reports it.
export type ResponseUsage = {
  id: string
  parts: { model: string; tokens: Tokens }[]
  speed?: string
  geo?: string
  webSearches: number
}

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

type RawResponse = RawUsage & {
  speed?: string
  inference_geo?: string
  server_tool_use?: { web_search_requests?: number }
  iterations?: (RawUsage & { model?: string })[]
}

function tokensOf(u: RawUsage): Tokens {
  const written = u.cache_creation_input_tokens ?? 0
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0

  return {
    input: u.input_tokens ?? 0,
    write5m: u.cache_creation?.ephemeral_5m_input_tokens ?? written - write1h,
    write1h,
    read: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  }
}

// Streaming writes one row per content block, all with one message id, and only
// the last holds the final output count, so a later row replaces an earlier one.
export function parseResponses(jsonl: string): ResponseUsage[] {
  const byId = new Map<string, ResponseUsage>()

  for (const line of jsonl.split('\n')) {
    if (!line) continue
    let message
    try {
      message = JSON.parse(line).message
    } catch {
      continue
    }
    if (message?.role !== 'assistant' || !message.id || !message.usage) continue
    if (message.model === '<synthetic>') continue

    const usage: RawResponse = message.usage
    // Iterations carry what the top-level figures leave out: compaction, and an
    // advisor billed at its own model's rates.
    const parts = usage.iterations?.length
      ? usage.iterations.map(i => ({
          model: i.model ?? message.model,
          tokens: tokensOf(i),
        }))
      : [{ model: message.model, tokens: tokensOf(usage) }]

    byId.set(message.id, {
      id: message.id,
      parts,
      speed: usage.speed,
      geo: usage.inference_geo,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    })
  }

  return [...byId.values()]
}

export type Scope = {
  kind: ScopeKind
  name: string
  responses: ResponseUsage[]
}

// A forked sub-session's transcript opens with the parent's rows: `seen` keeps
// each response in the first scope that reported it, so pass the main one first.
export function tally(scopes: Scope[]): Row[] {
  const seen = new Set<string>()
  const rows: Row[] = []

  for (const { kind, name, responses } of scopes) {
    const byModel = new Map<string, Row>()

    for (const response of responses) {
      if (seen.has(response.id)) continue
      seen.add(response.id)

      response.parts.forEach(({ model, tokens }, index) => {
        const row = byModel.get(model) ?? {
          kind,
          scope: name,
          model,
          calls: 0,
          input: 0,
          cacheWrite: 0,
          cacheRead: 0,
          output: 0,
          webSearches: 0,
          usd: 0,
        }
        // Searches are the response's, so they are counted once.
        const webSearches = index === 0 ? response.webSearches : 0
        const usd = requestUsd(model, tokens, {
          speed: response.speed,
          geo: response.geo,
          webSearches,
        })

        row.calls += 1
        row.input += tokens.input
        row.cacheWrite += tokens.write5m + tokens.write1h
        row.cacheRead += tokens.read
        row.output += tokens.output
        row.webSearches += webSearches
        row.usd = usd === null || row.usd === null ? null : row.usd + usd
        byModel.set(model, row)
      })
    }

    rows.push(...byModel.values())
  }

  return rows
}

const KIND_ORDER: ScopeKind[] = ['main', 'agent', 'sub-session']
const KIND_LABEL: Record<ScopeKind, string> = {
  main: 'This session',
  agent: 'Subagents',
  'sub-session': 'Sub-sessions',
}

export function totalUsd(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + (row.usd ?? 0), 0)
}

export function usd(value: number): string {
  if (value === 0) return '$0.00'

  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function count(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`

  return String(value)
}

function cell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/[\\|]/g, '\\$&')

  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

export function renderTable(report: Report): string {
  const { rows } = report
  if (rows.length === 0) return 'No model calls in this session yet.'

  const sorted = [...rows].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (b.usd ?? 0) - (a.usd ?? 0),
  )
  const sum = (pick: (row: Row) => number) =>
    rows.reduce((total, row) => total + pick(row), 0)
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const groups = KIND_ORDER.flatMap(kind => {
    const group = rows.filter(row => row.kind === kind)

    return group.length ? [`${KIND_LABEL[kind]} ${usd(totalUsd(group))}`] : []
  })
  const unpriced = [
    ...new Set(rows.filter(row => row.usd === null).map(row => row.model)),
  ]
  const searches = sum(row => row.webSearches)

  return [
    `**${usd(totalUsd(rows))} at Claude API prices**: ${groups.join(' · ')}`,
    '',
    line(['Scope', 'Model', 'Calls', 'Input', 'Cache write', 'Cache read', 'Output', 'Cost']),
    '| :- | :- | -: | -: | -: | -: | -: | -: |',
    ...sorted.map(row =>
      line([
        cell(row.scope),
        shortModel(row.model),
        String(row.calls),
        count(row.input),
        count(row.cacheWrite),
        count(row.cacheRead),
        count(row.output),
        row.usd === null ? 'no price' : usd(row.usd),
      ]),
    ),
    line([
      '**Total**',
      '',
      `**${sum(row => row.calls)}**`,
      `**${count(sum(row => row.input))}**`,
      `**${count(sum(row => row.cacheWrite))}**`,
      `**${count(sum(row => row.cacheRead))}**`,
      `**${count(sum(row => row.output))}**`,
      `**${usd(totalUsd(rows))}**`,
    ]),
    '',
    [
      `List prices as of ${PRICES_AS_OF}.`,
      searches ? `Includes ${searches} web searches at $10 per 1,000.` : '',
      unpriced.length
        ? `Left out of the total, no known price: ${unpriced.join(', ')}.`
        : '',
      report.ledgerUsd === undefined
        ? ''
        : `Claude Code's own ledger for this process: ${usd(report.ledgerUsd)}.`,
    ]
      .filter(Boolean)
      .join(' '),
  ].join('\n')
}
