// mc.mjs — the AI Master of Ceremonies. One interface, three calls:
//   generateDeck(context)  — the whole night's prompts, once, at game start
//   liveQuip(event)        — an event-triggered line, 2.5s budget
//   closingRoast(log)      — one generation from the full public log
//
// Three backends, in order of friction (mode picked in the lobby's AI-host
// setup — nobody has to type a key to play):
//   'community' — a free public text endpoint (text.pollinations.ai),
//                 zero setup, one tap. Best-effort quality and uptime.
//   'proxy'     — the site owner's own tiny relay-less HTTP worker (see
//                 proxy/worker.js) holding ONE low-cost Anthropic key
//                 server-side. Enabled automatically when the site ships
//                 an mc.json with {"proxyUrl": ...}.
//   'byok'      — advanced: the host's own Anthropic key, direct browser
//                 calls, stored only in this phone's localStorage.
//
// The static deck and quip templates remain permanently as the fallback:
// any failure, timeout, or policy_ok:false silently falls back. The game
// must never stall on a model.
//
// HARD PRIVACY RULE (tested in test/sim.mjs): the input builders below take
// only the PUBLIC game state — names, choices, scores, counters, style
// labels, prompts, and deliberately-exposed secrets. They have no access
// to grant plaintext and are therefore provably incapable of leaking an
// unrevealed secret to ANY backend. That is what makes the zero-setup
// public backend acceptable: nothing private ever leaves the table.

const MODEL = 'claude-haiku-4-5'      // low-cost tier; quips cost fractions of a cent
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const COMMUNITY_API = 'https://text.pollinations.ai/openai'
const KEY_LS = 'ntg:mc'

// ------------------------------------------------------------- settings

export const mcSettings = () => {
  try { return JSON.parse(localStorage.getItem(KEY_LS) || 'null') || {} } catch { return {} }
}
export const saveMcSettings = (s) => localStorage.setItem(KEY_LS, JSON.stringify(s))

let siteCfg
/** Optional site-level config (mc.json next to index.html): {proxyUrl}. */
export async function siteConfig() {
  if (siteCfg === undefined) {
    try {
      const r = await fetch(new URL('./mc.json', import.meta.url))
      siteCfg = r.ok ? await r.json() : null
    } catch { siteCfg = null }
  }
  return siteCfg
}

export function mcMode() {
  const s = mcSettings()
  if (!s.mode || s.mode === 'off') return 'off'
  if (s.mode === 'byok' && !s.apiKey) return 'off'
  return s.mode
}
export const mcEnabled = () => mcMode() !== 'off'

let policyText = null
async function policy() {
  if (!policyText) policyText = await fetch(new URL('./mc-policy.md', import.meta.url)).then(r => r.text())
  return policyText
}

// injectable for tests
export const _net = { fetch: (...a) => globalThis.fetch(...a) }

// ------------------------------------------------------------- schemas

const CAND = {
  type: 'object',
  properties: { text: { type: 'string' }, policy_ok: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['text', 'policy_ok', 'reason'],
  additionalProperties: false,
}
export const SCHEMAS = {
  deck: {
    schema: {
      type: 'object',
      properties: {
        rounds: {
          type: 'array',
          items: {
            type: 'object',
            properties: { round: { type: 'integer' }, candidates: { type: 'array', items: CAND } },
            required: ['round', 'candidates'],
            additionalProperties: false,
          },
        },
      },
      required: ['rounds'],
      additionalProperties: false,
    },
    maxTokens: 8000,
  },
  quip: { schema: CAND, maxTokens: 300 },
  roast: {
    schema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'string' } },
        policy_ok: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['cards', 'policy_ok', 'reason'],
      additionalProperties: false,
    },
    maxTokens: 1500,
  },
}

/** Pull the first JSON object out of possibly-chatty model text. */
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

// ------------------------------------------------------------- backends

async function callAnthropic(kind, user, timeoutMs) {
  const key = mcSettings().apiKey
  if (!key) throw new Error('no api key configured')
  const { schema, maxTokens } = SCHEMAS[kind]
  const res = await _net.fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: await policy(),
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`model call failed: ${res.status}`)
  const msg = await res.json()
  if (msg.stop_reason === 'refusal') throw new Error('model declined')
  return extractJson((msg.content || []).find(b => b.type === 'text')?.text)
}

async function callProxy(kind, user, timeoutMs) {
  const cfg = await siteConfig()
  if (!cfg?.proxyUrl) throw new Error('no proxy configured')
  const res = await _net.fetch(cfg.proxyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, user }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`proxy call failed: ${res.status}`)
  return extractJson(await res.text())
}

async function callCommunity(kind, user, timeoutMs) {
  const { schema } = SCHEMAS[kind]
  const system = `${await policy()}\n\nRespond with ONLY a JSON object matching this JSON Schema — no prose before or after:\n${JSON.stringify(schema)}`
  const res = await _net.fetch(COMMUNITY_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openai',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`community call failed: ${res.status}`)
  const body = await res.text()
  // OpenAI-compatible envelope when available; bare text otherwise
  const env = extractJson(body)
  const inner = env?.choices?.[0]?.message?.content
  return typeof inner === 'string' ? extractJson(inner) : env
}

async function callMC(kind, user, timeoutMs) {
  const mode = mcMode()
  if (mode === 'byok') return callAnthropic(kind, user, timeoutMs)
  if (mode === 'proxy') return callProxy(kind, user, timeoutMs)
  if (mode === 'community') return callCommunity(kind, user, timeoutMs)
  throw new Error('mc off')
}

// ---------------------------------------------------------- input builders
//
// Pure functions over PUBLIC data only. Exported for the privacy test.

const SPICE = {
  1: 'mild — cozy, funny, nothing anyone would mind their mother hearing',
  2: 'spicy — pointed and a little dangerous, the default dinner-party heat',
  3: 'scorching — as sharp as the hard rules allow; still never cruel',
}

export function buildDeckInput({ groupContext = '', spice = 2, avoid = '', playerNames = [] }) {
  return [
    'Generate the full night of prompts for one game of Ntrigue: 4 rounds,',
    '6 candidate prompts each. Every prompt is a question each player answers',
    'privately about themselves; answers become tradeable secrets.',
    '',
    'The arc is fixed: Round 1 warm-up confessions (mild, funny). Round 2',
    'partners (the couples round — questions about one\'s own partner).',
    'Round 3 the room (honest opinions of the people present). Round 4 high',
    'stakes (bigger confessions).',
    '',
    `Spice level: ${SPICE[spice] || SPICE[2]}.`,
    avoid.trim() ? `Topics to avoid absolutely: ${avoid.trim()}` : 'No extra avoid list.',
    groupContext.trim() ? `About this group: ${groupContext.trim()}` : 'No group context given.',
    playerNames.length ? `First names at the table: ${playerNames.join(', ')}.` : '',
    '',
    'Keep each prompt to one sentence, answerable in a phrase or two, and',
    'juicy enough that the answer is worth trading. Set policy_ok per prompt.',
  ].join('\n')
}

// The public event digest: everything a spectator at the table already
// knows. Takes the reducer state object — which never contains unexposed
// secret text — plus the current prompt text.
export function buildPublicLog(state) {
  const name = (pub) => state.players.find(p => p.pub === pub)?.name || '?'
  return {
    round: state.round,
    players: state.players.map(p => ({
      name: p.name,
      score: state.scores[p.pub] || 0,
      daggers: state.daggers[p.pub] || 0,
      betrayed: state.suffered[p.pub] || 0,
      style: state.styles?.[p.pub] || null,
      counters: state.counters?.[p.pub] || null,
    })),
    outcomes: (state.outcomes || []).map(o => ({
      kind: o.kind,
      a: name(o.a), b: name(o.b),
      winner: o.winner ? name(o.winner) : undefined,
      loser: o.loser ? name(o.loser) : undefined,
    })),
    exposed: (state.exposed || []).map(x => ({
      owner: name(x.owner), by: name(x.by), how: x.how, text: x.text,
    })),
    ending: state.ending || null,
  }
}

export function buildQuipInput(state, eventKey, slots) {
  return [
    `Write ONE line for the host to deliver right now. Event: ${eventKey}.`,
    `People involved: ${JSON.stringify(slots)}.`,
    `Public game log so far: ${JSON.stringify(buildPublicLog(state))}.`,
    'One sentence, two at most. Dry roast-comic. Use first names.',
  ].join('\n')
}

export function buildRoastInput(state) {
  return [
    'The game is over. Write the closing roast from the full public log:',
    JSON.stringify(buildPublicLog(state)),
    '',
    'Cover the villain, the sucker, the boldest bluff, and the fold everyone',
    'will remember — whatever the log actually supports. 150 words max,',
    'split into 2-4 short cards delivered one at a time on the big screen.',
    'Allude to publicly revealed secrets; do not quote them verbatim.',
  ].join('\n')
}

// ------------------------------------------------------------- interface

/** Convert a validated generation into deck.json shape (ids 100r+i, stable
 *  within the game). Candidates that fail the self-check are dropped;
 *  a round with fewer than 2 survivors falls back to the static round. */
export function toDeckShape(gen, staticDeck) {
  const rounds = staticDeck.rounds.map(sr => {
    const g = gen?.rounds?.find(r => r.round === sr.round)
    const ok = (g?.candidates || []).filter(c => c.policy_ok && c.text?.trim())
    if (ok.length < 2) return sr                       // fallback: static round
    return {
      round: sr.round,
      name: sr.name,
      prompts: ok.slice(0, 6).map((c, i) => ({ id: sr.round * 100 + i, text: c.text.trim() })),
    }
  })
  return { version: 1, generated: true, rounds }
}

/** One generation call produces the full night. Generous budget — this
 *  happens once, in the lobby, with a spinner. Returns a deck in
 *  deck.json shape or null (fallback to static). */
export async function generateDeck(context, staticDeck) {
  try {
    const gen = await callMC('deck', buildDeckInput(context), 90_000)
    const deck = toDeckShape(gen, staticDeck)
    return deck.rounds.some(r => !staticDeck.rounds.includes(r)) ? deck : null
  } catch (e) {
    console.warn('deck generation fell back:', e.message)
    return null
  }
}

/** Event-triggered line with a hard 2.5s budget. Returns the line or null
 *  (keep the prewritten template). */
export async function liveQuip(state, eventKey, slots) {
  try {
    const out = await callMC('quip', buildQuipInput(state, eventKey, slots), 2500)
    return out?.policy_ok && out.text?.trim() ? out.text.trim().slice(0, 300) : null
  } catch { return null }
}

/** Closing roast, card by card. Returns string[] or null. */
export async function closingRoast(state) {
  try {
    const out = await callMC('roast', buildRoastInput(state), 20_000)
    if (!out?.policy_ok) return null
    const cards = (out.cards || []).map(c => String(c).trim()).filter(Boolean).slice(0, 4)
    return cards.length ? cards : null
  } catch { return null }
}
