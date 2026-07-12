// state.mjs — Ntrigue game state: schema, reducer, pairing, scoring.
//
// The whole game is a pure reducer: the host client folds player action
// events into this state and publishes the result; every phone renders
// whatever the latest state says. Deterministic (seeded RNG, no clocks)
// so a full game can be driven and asserted in a node test.
//
// Schema carries a version field (v) — the v1 seam. Deck and quips are
// passed in as `content` rather than imported — the loading-indirection
// seam for the v1 AI MC.

import { sha256, bytesToHex } from './vendor/nostr-tools.js'

export const SCHEMA_VERSION = 2

export const PHASES = ['lobby', 'prompt', 'pairing', 'dilemma', 'outcome', 'debrief', 'scoreboard', 'finale_intro', 'finale', 'final']
export const ROUNDS = 4
// Round 0 is the optional warm-up: the full answer→match→choose→outcome loop
// with a mild prompt, everything visibly scored — then wiped at the debrief.

export const PAYOFF = { trade: 3, betrayWin: 5, betrayLose: 1, hold: 1 }
export const FINALE = { extortPrice: 3, revealBonus: 2, burnBonus: 1, vaultBonus: 2 }

// Deck flavors: the host picks the night's heat in the lobby. 'mild' is the
// default — the very-playable first game. Generated (AI) and legacy decks
// carry a top-level rounds array and bypass flavors entirely.
export const FLAVORS = ['mild', 'spicy', 'scorching']
export function flavorRounds(content, flavor) {
  if (content.deck.rounds) return content.deck.rounds
  const fl = content.deck.flavors
  return (fl.find(f => f.id === flavor) || fl[0]).rounds
}

// Stage (TV) client: heartbeat cadence and how stale a stage may go before
// the host declares it gone and phones re-expand.
export const STAGE_PING_SECS = 20
export const STAGE_STALE_SECS = 65

// Room codes: 4 glyphs from an ambiguity-free alphabet, derived from the
// game id so every client computes the same code with no extra state.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'
export function roomCode(gid) {
  const h = sha256(new TextEncoder().encode(`code:${gid}`))
  return [...h.slice(0, 4)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

export function initialState({ gid, host, relays }) {
  return {
    v: SCHEMA_VERSION,
    gid, host, relays,
    code: roomCode(gid),        // 4-letter alias for the TV / code join
    stage: false,               // a display (TV) client is present
    stagePub: null, stageSeen: 0,
    sound: false,               // stage stingers; toggled from the host phone
    counters: {},               // pub -> {sh,ho,mu,exw,rf,bu,va,fo,s1,n1,s2,n2}
    styles: {},                 // pub -> archetype label (evaluated each scoreboard)
    styleHist: {}, styleSeq: 0, // newest-earned tie resolution
    styleChange: null,          // {name, from, to} — the stage's beat
    phase: 'lobby',
    phaseAt: 0,                 // set by host on each publish (unix seconds)
    round: 0,
    practice: false,            // true during the warm-up round (round 0)
    flavor: 'mild',             // deck heat, picked by the host at start
    players: [],                // [{pub, name, seat}] — seat assigned at start
    promptId: null,
    promptText: null,           // the drawn prompt's text — carries generated
                                // prompts to players without publishing the deck
    roast: null,                // AI MC closing roast cards (string[]) or null
    usedPrompts: [],
    redrawsLeft: 0,
    draws: 0,                   // rng counter, keeps draws deterministic
    pairs: [],                  // [[pubA, pubB], ...]; unpaired pub sits out
    answered: {},               // pub -> true      (this round)
    commits: {},                // pub -> sha256 hex (this round)
    choices: {},                // pub -> 'SHARE'|'HOLD' (verified, this round)
    outcomes: [],               // this round's pair outcomes (see resolveRound)
    outcomeStep: 0,
    scores: {}, daggers: {}, suffered: {},
    collected: {},              // pub -> [{owner, round}] — public knowledge
    finale: null,
    exposed: [],                // [{owner, round, text, by, how}] — can't un-tell
    quip: '',                   // current card's host line
    ending: null,               // {villain, sucker, vd, sn}
  }
}

// ------------------------------------------------------------ deterministic rng

const seed32 = (str) => {
  const h = sha256(new TextEncoder().encode(str))
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
}
const pick = (arr, seedStr) => arr[seed32(seedStr) % arr.length]

export const commitHash = (choice, nonce) =>
  bytesToHex(sha256(new TextEncoder().encode(`${choice}:${nonce}`)))

// ------------------------------------------------------------ quips

export function quip(content, key, slots = {}, seedStr = '') {
  const variants = content.quips.quips[key] || ['']
  let line = pick(variants, `q:${key}:${seedStr}`)
  for (const [k, v] of Object.entries(slots)) line = line.split(`{${k}}`).join(v)
  return line
}

// ------------------------------------------------------------ pairing

// Seats are 1-indexed. Couples are (1,2) and (3,4) per the spec's lobby order.
// 4 players: R1 cross-couple, R2 partners, R3 the other cross, R4 repeats R2
// (the money round). Other counts use a circle-method round-robin with the
// partners round forced when the count is even.
export function pairingsFor(players, round) {
  const seats = [...players].sort((a, b) => a.seat - b.seat).map(p => p.pub)
  const n = seats.length
  if (n === 4) {
    const [p1, p2, p3, p4] = seats
    return [
      [[p1, p3], [p2, p4]],   // R1 cross
      [[p1, p2], [p3, p4]],   // R2 partners
      [[p1, p4], [p2, p3]],   // R3 other cross
      [[p1, p2], [p3, p4]],   // R4 rematch (default: repeat R2)
    ][round - 1]
  }
  const partners = []
  for (let i = 0; i + 1 < n; i += 2) partners.push([seats[i], seats[i + 1]])
  // circle method; odd counts get a bye (that player sits out the round)
  const ring = n % 2 === 0 ? [...seats] : [...seats, null]
  const m = ring.length
  const circleRound = (r) => {
    const rot = [ring[0], ...ring.slice(1).slice(m - 1 - r % (m - 1)), ...ring.slice(1, m - r % (m - 1))]
    const out = []
    for (let i = 0; i < m / 2; i++) {
      const [x, y] = [rot[i], rot[m - 1 - i]]
      if (x !== null && y !== null) out.push([x, y])
    }
    return out
  }
  const samePairs = (a, b) =>
    JSON.stringify(a.map(p => [...p].sort()).sort()) === JSON.stringify(b.map(p => [...p].sort()).sort())
  if (n % 2 === 0) {
    const others = []
    for (let r = 0; others.length < 2 && r < m; r++) {
      const c = circleRound(r)
      if (!samePairs(c, partners)) others.push(c)
    }
    return [others[0], partners, others[1] || circleRound(2), partners][round - 1]
  }
  return [circleRound(0), circleRound(1), circleRound(2), circleRound(1)][round - 1]
}

export const partnerRound = (round) => round === 2 || round === 4

// ------------------------------------------------------------ helpers

const activePubs = (state) => state.pairs.flat()
const nameOf = (state, pub) => state.players.find(p => p.pub === pub)?.name || '?'
const leader = (state) =>
  [...state.players].sort((a, b) => (state.scores[b.pub] || 0) - (state.scores[a.pub] || 0))[0]

const isHostAct = (t) => ['order', 'start', 'override', 'advance', 'redraw', 'force', 'stage_gone', 'sound', 'mc_quip', 'mc_roast'].includes(t)

const bump = (state, pub, key, n = 1) => {
  const c = state.counters[pub] = state.counters[pub] ||
    { sh: 0, ho: 0, mu: 0, exw: 0, rf: 0, bu: 0, va: 0, fo: 0, s1: 0, n1: 0, s2: 0, n2: 0 }
  c[key] += n
}

// ------------------------------------------------------------ style profiles
//
// Rule-based archetypes from public play counters, evaluated at every
// scoreboard and at game end. Every player always has exactly one label;
// ties resolve to the newest-earned.

export const ARCHETYPES = {
  openBook: 'The Open Book', vault: 'The Vault', shark: 'The Shark',
  mark: 'The Mark', diplomat: 'The Diplomat', anarchist: 'The Anarchist',
  enforcer: 'The Enforcer', wildcard: 'The Wildcard',
}

function triggeredArchetypes(state, pub) {
  const c = state.counters[pub] || {}
  const n = (c.sh || 0) + (c.ho || 0)
  const out = []
  if (n > 0 && c.sh / n >= 0.75) out.push(ARCHETYPES.openBook)
  if (n > 0 && c.ho / n >= 0.75) out.push(ARCHETYPES.vault)
  if ((state.daggers[pub] || 0) >= 2) out.push(ARCHETYPES.shark)
  const maxSuffered = Math.max(0, ...state.players.map(p => state.suffered[p.pub] || 0))
  if (maxSuffered >= 2 && (state.suffered[pub] || 0) === maxSuffered) out.push(ARCHETYPES.mark)
  const maxMu = Math.max(0, ...state.players.map(p => state.counters[p.pub]?.mu || 0))
  if (maxMu >= 1 && (c.mu || 0) === maxMu) out.push(ARCHETYPES.diplomat)
  if ((c.bu || 0) >= 1 || (c.rf || 0) >= 2) out.push(ARCHETYPES.anarchist)
  if ((c.exw || 0) >= 1) out.push(ARCHETYPES.enforcer)
  if (c.n1 > 0 && c.n2 > 0 && (c.s1 / c.n1 >= 0.5) !== (c.s2 / c.n2 >= 0.5))
    out.push(ARCHETYPES.wildcard)
  return out
}

function evalStyles(state, content) {
  state.styleChange = null
  for (const p of state.players) {
    const trig = triggeredArchetypes(state, p.pub)
    const hist = state.styleHist[p.pub] = state.styleHist[p.pub] || {}
    for (const label of trig) if (!hist[label]) hist[label] = ++state.styleSeq
    const c = state.counters[p.pub] || {}
    const n = (c.sh || 0) + (c.ho || 0)
    const label = trig.length
      ? trig.sort((a, b) => hist[b] - hist[a])[0]                 // newest-earned wins
      : (n > 0 && c.sh / n >= 0.5 ? ARCHETYPES.openBook : ARCHETYPES.vault)
    const prev = state.styles[p.pub]
    if (prev && prev !== label && !state.styleChange)
      state.styleChange = { name: p.name, from: prev, to: label,
        quip: quip(content, 'style_change', { name: p.name, from: prev, to: label },
          `${state.gid}:${state.round}:${p.pub.slice(0, 8)}`) }
    state.styles[p.pub] = label
  }
}

function drawPrompt(state, content) {
  // round 0 draws from the mild warm-up pool (fall back to round 1's pool
  // for decks without one, e.g. generated decks)
  const rounds = flavorRounds(content, state.flavor)
  const source = state.round === 0
    ? (content.deck.practice || rounds.find(r => r.round === 1).prompts)
    : rounds.find(r => r.round === state.round).prompts
  const pool = source.filter(p => !state.usedPrompts.includes(p.id))
  const chosen = pool[seed32(`draw:${state.gid}:${state.draws}`) % pool.length]
  state.draws++
  state.promptId = chosen.id
  state.promptText = chosen.text
  state.usedPrompts.push(chosen.id)
}

function startRound(state, content, round) {
  Object.assign(state, {
    phase: 'prompt', round, promptId: null, redrawsLeft: 1,
    pairs: [], answered: {}, commits: {}, choices: {}, outcomes: [], outcomeStep: 0,
  })
  drawPrompt(state, content)
  state.quip = ''
}

function toPairing(state, content) {
  state.phase = 'pairing'
  state.pairs = pairingsFor(state.players, state.round || 1)   // warm-up uses R1's pattern
  const [a, b] = state.pairs[0].map(p => nameOf(state, p))
  state.quip = quip(content, partnerRound(state.round) ? 'pairing_partner' : 'pairing',
    { a, b }, `${state.gid}:${state.round}`)
}

// Resolve all pairs once every active player's choice is known.
function resolveRound(state, content) {
  state.outcomes = state.pairs.map(([a, b], i) => {
    const [ca, cb] = [state.choices[a], state.choices[b]]
    const seedStr = `${state.gid}:${state.round}:${i}`
    const names = { a: nameOf(state, a), b: nameOf(state, b) }
    const add = (pub, n) => { state.scores[pub] = (state.scores[pub] || 0) + n }
    const collect = (holder, owner) => {
      (state.collected[holder] = state.collected[holder] || []).push({ owner, round: state.round })
    }
    for (const [pub, choice] of [[a, ca], [b, cb]]) {
      bump(state, pub, choice === 'SHARE' ? 'sh' : 'ho')
      const half = state.round <= 2 ? ['s1', 'n1'] : ['s2', 'n2']
      bump(state, pub, half[1])
      if (choice === 'SHARE') bump(state, pub, half[0])
    }
    if (ca === 'SHARE' && cb === 'SHARE') {
      add(a, PAYOFF.trade); add(b, PAYOFF.trade)
      collect(a, b); collect(b, a)
      bump(state, a, 'mu'); bump(state, b, 'mu')
      return { a, b, ca, cb, kind: 'trade', quip: quip(content, 'mutual_share', names, seedStr) }
    }
    if (ca === 'HOLD' && cb === 'HOLD') {
      add(a, PAYOFF.hold); add(b, PAYOFF.hold)
      return { a, b, ca, cb, kind: 'stalemate', quip: quip(content, 'mutual_hold', names, seedStr) }
    }
    const [winner, loser] = ca === 'HOLD' ? [a, b] : [b, a]   // holder wins
    add(winner, PAYOFF.betrayWin); add(loser, PAYOFF.betrayLose)
    state.daggers[winner] = (state.daggers[winner] || 0) + 1
    state.suffered[loser] = (state.suffered[loser] || 0) + 1
    collect(winner, loser)
    return {
      a, b, ca, cb, kind: 'betrayal', winner, loser,
      quip: quip(content, 'betrayal',
        { winner: nameOf(state, winner), loser: nameOf(state, loser) }, seedStr),
    }
  })
  state.phase = 'outcome'
  state.outcomeStep = 0
}

function toScoreboard(state, content) {
  state.phase = 'scoreboard'
  state.quip = quip(content, 'scoreboard', { leader: leader(state).name }, `${state.gid}:${state.round}`)
  evalStyles(state, content)
}

function startFinale(state) {
  const order = [...state.players]
    .sort((x, y) => (state.scores[x.pub] || 0) - (state.scores[y.pub] || 0) || y.seat - x.seat)
    .map(p => p.pub)
  state.phase = 'finale'
  state.finale = { order, turn: 0, step: 'choose', action: null }
  beginTurn(state)
}

function beginTurn(state) {
  const f = state.finale
  const actor = f.order[f.turn]
  f.step = 'choose'
  f.action = null
  state.quip = ''
  if (!(state.collected[actor] || []).length) {          // nothing collected →
    f.action = { kind: 'vault', auto: true }             // non-humiliating pass
    state.scores[actor] = (state.scores[actor] || 0) + FINALE.vaultBonus
    bump(state, actor, 'va')
    f.step = 'result'
  }
}

function finishFinaleTurn(state, content) {
  const f = state.finale
  if (f.turn + 1 < f.order.length) { f.turn++; beginTurn(state) }
  else endGame(state, content)
}

function endGame(state, content) {
  const by = (m) => [...state.players].sort((a, b) => (m[b.pub] || 0) - (m[a.pub] || 0))[0]
  const villain = by(state.daggers), sucker = by(state.suffered)
  state.ending = {
    villain: villain.name, vd: state.daggers[villain.pub] || 0,
    sucker: sucker.name, sn: state.suffered[sucker.pub] || 0,
  }
  state.phase = 'final'
  state.quip = quip(content, 'closing', state.ending, state.gid)
  evalStyles(state, content)
}

// ------------------------------------------------------------ the reducer

// act: {type, pub, ...payload}. `pub` is the verified author of the action
// event. Returns a NEW state when the action applies, or the SAME reference
// when ignored — the host driver publishes only on change.
export function reduce(prev, act, content) {
  if (isHostAct(act.type) && act.pub !== prev.host) return prev
  const state = structuredClone(prev)
  const f = () => state.finale
  const actor = () => f().order[f().turn]

  switch (act.type) {
    case 'join': {
      if (state.phase !== 'lobby') return prev
      const name = String(act.name || '').trim().slice(0, 12)
      if (!name) return prev
      const existing = state.players.find(p => p.pub === act.pub)
      if (existing) { if (existing.name === name) return prev; existing.name = name; return state }
      if (state.players.length >= 6) return prev
      state.players.push({ pub: act.pub, name, seat: state.players.length + 1 })
      return state
    }
    case 'order': {                                    // host reorders seats in lobby
      if (state.phase !== 'lobby') return prev
      const pubs = act.order.filter(p => state.players.some(q => q.pub === p))
      if (pubs.length !== state.players.length) return prev
      state.players.forEach(p => { p.seat = pubs.indexOf(p.pub) + 1 })
      return state
    }
    case 'start':
      if (state.phase !== 'lobby' || state.players.length < 3) return prev
      state.flavor = FLAVORS.includes(act.flavor) ? act.flavor : 'mild'
      if (act.practice) { state.practice = true; startRound(state, content, 0) }
      else startRound(state, content, 1)
      return state

    case 'answered': {
      if (state.phase !== 'prompt' || act.round !== state.round) return prev
      if (!state.players.some(p => p.pub === act.pub) || state.answered[act.pub]) return prev
      state.answered[act.pub] = true
      if (state.players.every(p => state.answered[p.pub])) toPairing(state, content)
      return state
    }
    case 'override':                                   // host: advance without stragglers
      if (state.phase !== 'prompt') return prev
      toPairing(state, content)
      return state
    case 'redraw':
      if (state.phase !== 'prompt' || state.redrawsLeft < 1) return prev
      state.redrawsLeft--
      drawPrompt(state, content)
      return state

    case 'commit': {
      if (state.phase !== 'dilemma' || act.round !== state.round) return prev
      if (!activePubs(state).includes(act.pub) || state.commits[act.pub]) return prev
      state.commits[act.pub] = act.hash
      return state
    }
    case 'reveal': {
      if (state.phase !== 'dilemma' || act.round !== state.round) return prev
      if (!activePubs(state).includes(act.pub) || state.choices[act.pub]) return prev
      if (!['SHARE', 'HOLD'].includes(act.choice)) return prev
      // Verify against the commitment when one exists; lenient if missing —
      // it's a party game, and the host `force` path needs the same door.
      if (state.commits[act.pub] && commitHash(act.choice, act.nonce) !== state.commits[act.pub]) return prev
      state.choices[act.pub] = act.choice
      if (activePubs(state).every(p => state.choices[p])) resolveRound(state, content)
      return state
    }
    case 'force':                                      // host: unstick a stalled dilemma
      if (state.phase !== 'dilemma') return prev
      for (const p of activePubs(state)) if (!state.choices[p]) state.choices[p] = 'HOLD'
      resolveRound(state, content)
      return state

    case 'finale_choice': {
      if (state.phase !== 'finale' || f().step !== 'choose' || act.pub !== actor()) return prev
      const mine = state.collected[act.pub] || []
      const owns = (o, r) => mine.some(c => c.owner === o && c.round === r)
      const add = (n) => { state.scores[act.pub] = (state.scores[act.pub] || 0) + n }
      if (act.action === 'vault') {
        add(FINALE.vaultBonus)
        bump(state, act.pub, 'va')
        f().action = { kind: 'vault' }
        f().step = 'result'
        state.quip = quip(content, 'vault', { actor: nameOf(state, act.pub) }, `${state.gid}:f${f().turn}`)
      } else if (act.action === 'burn') {
        if (!owns(act.owner, act.round)) return prev
        add(FINALE.burnBonus)
        bump(state, act.pub, 'bu')
        state.exposed.push({ owner: act.owner, round: act.round, text: String(act.text || ''), by: act.pub, how: 'burn' })
        f().action = { kind: 'burn', owner: act.owner, round: act.round }
        f().step = 'result'
        state.quip = quip(content, 'burn',
          { actor: nameOf(state, act.pub), owner: nameOf(state, act.owner) }, `${state.gid}:f${f().turn}`)
      } else if (act.action === 'extort') {
        if (!owns(act.owner, act.round)) return prev
        f().action = { kind: 'extort', owner: act.owner, round: act.round }
        f().step = 'extort'
        state.quip = quip(content, 'extort_open',
          { blackmailer: nameOf(state, act.pub), target: nameOf(state, act.owner) }, `${state.gid}:f${f().turn}`)
      } else return prev
      return state
    }
    case 'extort_response': {
      if (state.phase !== 'finale' || f().step !== 'extort') return prev
      if (act.pub !== f().action.owner || act.turn !== f().turn) return prev
      if (act.pay) {
        state.scores[act.pub] = (state.scores[act.pub] || 0) - FINALE.extortPrice
        state.scores[actor()] = (state.scores[actor()] || 0) + FINALE.extortPrice
        bump(state, actor(), 'exw')
        f().action.paid = true
        f().step = 'result'
        state.quip = quip(content, 'pay',
          { target: nameOf(state, act.pub), blackmailer: nameOf(state, actor()) }, `${state.gid}:f${f().turn}`)
      } else {
        bump(state, act.pub, 'rf')
        f().action.refused = true
        f().step = 'decide'
      }
      return state
    }
    case 'blackmail_decision': {
      if (state.phase !== 'finale' || f().step !== 'decide') return prev
      if (act.pub !== actor() || act.turn !== f().turn) return prev
      if (act.reveal) {
        state.scores[act.pub] = (state.scores[act.pub] || 0) + FINALE.revealBonus
        state.exposed.push({
          owner: f().action.owner, round: f().action.round,
          text: String(act.text || ''), by: act.pub, how: 'blackmail',
        })
        f().action.revealed = true
        state.quip = quip(content, 'reveal_intro',
          { owner: nameOf(state, f().action.owner) }, `${state.gid}:f${f().turn}`)
      } else {
        bump(state, act.pub, 'fo')
        f().action.folded = true
        state.quip = quip(content, 'fold',
          { blackmailer: nameOf(state, act.pub) }, `${state.gid}:f${f().turn}`)
      }
      f().step = 'result'
      return state
    }

    case 'advance':                                    // host: next card
      switch (state.phase) {
        case 'pairing': state.phase = 'dilemma'; return state
        case 'outcome':
          if (state.outcomeStep + 1 < state.outcomes.length) { state.outcomeStep++; return state }
          if (state.round === 0) { state.phase = 'debrief'; state.quip = ''; return state }
          toScoreboard(state, content)
          return state
        case 'debrief':                                // warm-up over: wipe everything it touched
          Object.assign(state, {
            practice: false, scores: {}, daggers: {}, suffered: {}, collected: {},
            counters: {}, styles: {}, styleHist: {}, styleSeq: 0, styleChange: null,
          })
          startRound(state, content, 1)
          return state
        case 'scoreboard':
          if (state.round < ROUNDS) startRound(state, content, state.round + 1)
          else state.phase = 'finale_intro'
          return state
        case 'finale_intro': startFinale(state); return state
        case 'finale':
          if (f().step !== 'result') return prev
          finishFinaleTurn(state, content)
          return state
        default: return prev
      }
    // ---- stage (TV) presence: join is open to any client; only the joined
    // stage may ping; only the host may declare it gone or toggle sound.
    case 'stage_join':
      if (state.stagePub && state.stagePub !== act.pub) return prev   // one stage
      state.stage = true
      state.stagePub = act.pub
      state.stageSeen = act.ts || 0
      return state
    case 'stage_ping': {
      if (act.pub !== state.stagePub) return prev
      const ts = act.ts || 0
      if (ts <= state.stageSeen) return prev
      state.stageSeen = ts
      return state
    }
    case 'stage_gone':
      if (!state.stage && !state.stagePub) return prev
      state.stage = false
      state.stagePub = null
      return state
    case 'sound':
      if (state.sound === !!act.on) return prev
      state.sound = !!act.on
      return state

    // ---- AI MC upgrades (host-only). Prewritten content already shipped;
    // these swap in a generated line when it arrives inside its budget.
    case 'mc_quip': {
      const text = String(act.text || '').slice(0, 300)
      if (!text) return prev
      if (act.slot === 'outcome') {
        const o = state.outcomes[act.step]
        if (state.phase !== 'outcome' || !o || state.outcomeStep !== act.step) return prev
        o.quip = text
        return state
      }
      if (act.phase !== state.phase) return prev       // stale — the card moved on
      state.quip = text
      return state
    }
    case 'mc_roast': {
      if (state.phase !== 'final' || state.roast) return prev
      const cards = (act.cards || []).map(c => String(c).slice(0, 400)).filter(Boolean).slice(0, 4)
      if (!cards.length) return prev
      state.roast = cards
      return state
    }
    default:
      return prev
  }
}
