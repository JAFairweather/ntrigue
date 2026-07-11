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

export const SCHEMA_VERSION = 1

export const PHASES = ['lobby', 'prompt', 'pairing', 'dilemma', 'outcome', 'scoreboard', 'finale_intro', 'finale', 'final']
export const ROUNDS = 4

export const PAYOFF = { trade: 3, betrayWin: 5, betrayLose: 1, hold: 1 }
export const FINALE = { extortPrice: 3, revealBonus: 2, burnBonus: 1, vaultBonus: 2 }

export function initialState({ gid, host, relays }) {
  return {
    v: SCHEMA_VERSION,
    gid, host, relays,
    stage: false,               // v1 seam: a display client is present
    phase: 'lobby',
    phaseAt: 0,                 // set by host on each publish (unix seconds)
    round: 0,
    players: [],                // [{pub, name, seat}] — seat assigned at start
    promptId: null,
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

const isHostAct = (t) => ['order', 'start', 'override', 'advance', 'redraw', 'force', 'stagehere'].includes(t)

function drawPrompt(state, content) {
  const pool = content.deck.rounds.find(r => r.round === state.round).prompts
    .filter(p => !state.usedPrompts.includes(p.id))
  const chosen = pool[seed32(`draw:${state.gid}:${state.draws}`) % pool.length]
  state.draws++
  state.promptId = chosen.id
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
  state.pairs = pairingsFor(state.players, state.round)
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
    if (ca === 'SHARE' && cb === 'SHARE') {
      add(a, PAYOFF.trade); add(b, PAYOFF.trade)
      collect(a, b); collect(b, a)
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
      startRound(state, content, 1)
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
        f().action = { kind: 'vault' }
        f().step = 'result'
        state.quip = quip(content, 'vault', { actor: nameOf(state, act.pub) }, `${state.gid}:f${f().turn}`)
      } else if (act.action === 'burn') {
        if (!owns(act.owner, act.round)) return prev
        add(FINALE.burnBonus)
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
        f().action.paid = true
        f().step = 'result'
        state.quip = quip(content, 'pay',
          { target: nameOf(state, act.pub), blackmailer: nameOf(state, actor()) }, `${state.gid}:f${f().turn}`)
      } else {
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
          toScoreboard(state, content)
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
    case 'stagehere':                                  // v1 seam — no-op in v0
      state.stage = !!act.on
      return state
    default:
      return prev
  }
}
