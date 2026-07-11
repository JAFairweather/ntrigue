// mc.mjs — the AI Master of Ceremonies. One interface, three calls:
//   generateDeck(context)  — the whole night's prompts, once, at game start
//   liveQuip(event)        — an event-triggered line, 2.5s budget
//   closingRoast(log)      — one generation from the full public log
//
// Every call runs from the HOST phone only, with a bring-your-own Anthropic
// API key held in this phone's localStorage — it never appears in game
// state and never leaves this device except to api.anthropic.com. The
// static deck and quip templates remain permanently as the fallback path:
// any failure, timeout, or policy_ok:false silently falls back. The game
// must never stall on a model.
//
// HARD PRIVACY RULE (tested in test/mc.mjs): the input builders below take
// only the PUBLIC game state — names, choices, scores, counters, style
// labels, prompts, and deliberately-exposed secrets. They have no access
// to grant plaintext and are therefore provably incapable of leaking an
// unrevealed secret into a model prompt.

const MODEL = 'claude-opus-4-8'
const API = 'https://api.anthropic.com/v1/messages'
const KEY_LS = 'ntg:mc'

export const mcSettings = () => {
  try { return JSON.parse(localStorage.getItem(KEY_LS) || 'null') || {} } catch { return {} }
}
export const saveMcSettings = (s) => localStorage.setItem(KEY_LS, JSON.stringify(s))
export const mcEnabled = () => !!mcSettings().apiKey

let policyText = null
async function policy() {
  if (!policyText) policyText = await fetch(new URL('./mc-policy.md', import.meta.url)).then(r => r.text())
  return policyText
}

// injectable for tests
export const _net = { fetch: (...a) => globalThis.fetch(...a) }

async function callModel({ user, schema, maxTokens, timeoutMs, effort = 'high', thinking = false }) {
  const key = mcSettings().apiKey
  if (!key) throw new Error('no api key configured')
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: await policy(),
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  }
  if (thinking) body.thinking = { type: 'adaptive' }
  const res = await _net.fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`model call failed: ${res.status}`)
  const msg = await res.json()
  if (msg.stop_reason === 'refusal') throw new Error('model declined')
  const text = (msg.content || []).find(b => b.type === 'text')?.text
  return JSON.parse(text)
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

// ------------------------------------------------------------- schemas

const CAND = {
  type: 'object',
  properties: { text: { type: 'string' }, policy_ok: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['text', 'policy_ok', 'reason'],
  additionalProperties: false,
}
const DECK_SCHEMA = {
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
}
const QUIP_SCHEMA = CAND
const ROAST_SCHEMA = {
  type: 'object',
  properties: {
    cards: { type: 'array', items: { type: 'string' } },
    policy_ok: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['cards', 'policy_ok', 'reason'],
  additionalProperties: false,
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
    const gen = await callModel({
      user: buildDeckInput(context),
      schema: DECK_SCHEMA,
      maxTokens: 8000,
      timeoutMs: 90_000,
      effort: 'high',
      thinking: true,
    })
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
    const out = await callModel({
      user: buildQuipInput(state, eventKey, slots),
      schema: QUIP_SCHEMA,
      maxTokens: 300,
      timeoutMs: 2500,
      effort: 'low',
    })
    return out.policy_ok && out.text?.trim() ? out.text.trim() : null
  } catch { return null }
}

/** Closing roast, card by card. Returns string[] or null. */
export async function closingRoast(state) {
  try {
    const out = await callModel({
      user: buildRoastInput(state),
      schema: ROAST_SCHEMA,
      maxTokens: 1500,
      timeoutMs: 20_000,
      effort: 'high',
    })
    if (!out.policy_ok) return null
    const cards = (out.cards || []).map(c => c.trim()).filter(Boolean).slice(0, 4)
    return cards.length ? cards : null
  } catch { return null }
}
