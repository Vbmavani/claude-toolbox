// Claude API list prices in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing
export const PRICES_AS_OF = '2026-10-30'

export type Price = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

const price = (
  input: number,
  write5m: number,
  write1h: number,
  read: number,
  output: number,
): Price => ({ input, write5m, write1h, read, output })

const FABLE_5_1 = price(10, 12.5, 20, 0.25, 50)
const FABLE_5 = price(10, 12.5, 20, 1, 50)
const OPUS_5_5 = price(4, 5, 8, 0.2, 20)
const OPUS_5 = price(5, 6.25, 10, 0.5, 25)
const OPUS_4_1 = price(15, 18.75, 30, 1.5, 75)
const SONNET_5_5 = price(2, 2.5, 4, 0.1, 10)
const SONNET_5 = price(2, 2.5, 4, 0.2, 10)
const SONNET_4 = price(3, 3.75, 6, 0.3, 15)
const HAIKU_5_5 = price(0.1, 0.125, 0.2, 0.01, 0.5)
const HAIKU_5_5_LONG = price(0.5, 0.625, 1, 0.05, 2.5)
const HAIKU_4_5 = price(1, 1.25, 2, 0.1, 5)
const HAIKU_3_5 = price(0.8, 1, 1.6, 0.08, 4)

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': OPUS_5_5,
  'claude-opus-5': OPUS_5,
  'claude-opus-4-8': OPUS_5,
  'claude-opus-4-7': OPUS_5,
  'claude-opus-4-6': OPUS_5,
  'claude-opus-4-5': OPUS_5,
  'claude-opus-4-1': OPUS_4_1,
  'claude-opus-4': OPUS_4_1,
  'claude-sonnet-5-5': SONNET_5_5,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': HAIKU_5_5,
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-3-5-haiku': HAIKU_3_5,
}

const HAIKU_5_5_LONG_PROMPT = 100_000
const WEB_SEARCH_USD = 10 / 1000
const FAST_MULTIPLIER = 2
const US_ONLY_MULTIPLIER = 1.1

const IDS = Object.keys(PRICES).sort((a, b) => b.length - a.length)

// Maps a dated, region-prefixed or `[1m]` id to its price-table id. The id must
// end where a suffix starts, so a future claude-opus-4-9 is unknown rather than
// priced as claude-opus-4.
export function modelKey(model: string): string | undefined {
  const lower = model.toLowerCase()

  return IDS.find(id => {
    const at = lower.indexOf(id)
    if (at < 0) return false
    const rest = lower.slice(at + id.length)

    return rest === '' || /^(-\d{8}|-v\d|@|\[|:)/.test(rest)
  })
}

export type Tokens = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

export type Terms = {
  speed?: string
  geo?: string
  webSearches?: number
}

export function promptTokens(t: Tokens): number {
  return t.input + t.write5m + t.write1h + t.read
}

// One request's cost, or null when the model has no known price.
export function requestUsd(
  model: string,
  tokens: Tokens,
  terms: Terms = {},
): number | null {
  const key = modelKey(model)
  if (!key) return null

  const isLong =
    key === 'claude-haiku-5-5' && promptTokens(tokens) > HAIKU_5_5_LONG_PROMPT
  const p = isLong ? HAIKU_5_5_LONG : (PRICES[key] as Price)
  const perMillion =
    tokens.input * p.input +
    tokens.write5m * p.write5m +
    tokens.write1h * p.write1h +
    tokens.read * p.read +
    tokens.output * p.output
  const speed = terms.speed === 'fast' ? FAST_MULTIPLIER : 1
  const geo = terms.geo === 'us' ? US_ONLY_MULTIPLIER : 1

  return (
    (perMillion / 1_000_000) * speed * geo +
    (terms.webSearches ?? 0) * WEB_SEARCH_USD
  )
}
