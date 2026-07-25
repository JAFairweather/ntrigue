// test/sim.mjs — a full scripted 4-player game, exercised end-to-end:
// the reducer drives every phase, secrets travel as real kind-30440 scopes,
// trades as real gift-wrapped kind-440 grants, all over the in-memory relay.
// Finishes with the adversarial check: the relay operator must never see a
// secret that wasn't deliberately made public.
//
//   node test/sim.mjs

import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { generateSecretKey, getPublicKey, bytesToHex } from '../vendor/nostr-tools.js'
import { publishScope, grant, receiveGrants, latestGrants, fetchScope, newScopeKey } from '../nipxx.mjs'
import { initialState, reduce, commitHash, pairingsFor, roomCode, ARCHETYPES, flavorRounds, FLAVORS, heatFor } from '../state.mjs'
import { buildDeckInput, buildPublicLog, buildQuipInput, buildRoastInput, toDeckShape, extractJson } from '../mc.mjs'
import { Relay } from './relay.mjs'

const content = {
  deck: JSON.parse(await readFile(new URL('../deck.json', import.meta.url))),
  quips: JSON.parse(await readFile(new URL('../quips.json', import.meta.url))),
}

const relay = new Relay()

// ---- the table: James+Sarah are a couple (seats 1,2), Priya+Marco (3,4)
const P = ['James', 'Sarah', 'Priya', 'Marco'].map(name => {
  const sk = generateSecretKey()
  return { name, sk, pub: getPublicKey(sk), scopes: {}, collected: {} }
})
const [james, sarah, priya, marco] = P
const byPub = Object.fromEntries(P.map(p => [p.pub, p]))
const secretText = (p, r) => `ultra-private-${p.name}-round${r}`

// ---- host driver: fold an action, assert it applied
let state = initialState({ gid: 'testgame', host: james.pub, relays: [] })
const apply = (act, expectChange = true) => {
  const next = reduce(state, act, content)
  if (expectChange) assert.notEqual(next, state, `action should apply: ${JSON.stringify(act)}`)
  state = next
}
const host = (type) => apply({ type, pub: james.pub })

// room code: derived, stable, 4 letters, no ambiguous glyphs
assert.match(state.code, /^[A-HJKMNP-Z]{4}$/)
assert.equal(state.code, roomCode('testgame'))

// ---- a stage (TV) joins with a throwaway identity — v1, read-only
const stageSk = generateSecretKey()
const stagePub = getPublicKey(stageSk)
apply({ type: 'stage_join', pub: stagePub, ts: 1000 })
assert.equal(state.stage, true)
apply({ type: 'stage_ping', pub: sarah.pub, ts: 2000 }, false)       // only the stage pings
apply({ type: 'stage_ping', pub: stagePub, ts: 2000 })
assert.equal(state.stageSeen, 2000)
apply({ type: 'stage_gone', pub: sarah.pub }, false)                 // only the host declares it gone
apply({ type: 'stage_gone', pub: james.pub })                        // yank the stage —
assert.equal(state.stage, false)                                     // nothing breaks
apply({ type: 'stage_join', pub: stagePub, ts: 3000 })               // and it can come back
assert.equal(state.stage, true)
apply({ type: 'sound', pub: james.pub, on: true })
assert.equal(state.sound, true)

// ---- lobby
for (const p of P) apply({ type: 'join', pub: p.pub, name: p.name })
apply({ type: 'join', pub: marco.pub, name: 'Marco' }, false)        // dup join ignored
apply({ type: 'order', pub: james.pub, order: P.map(p => p.pub) })
apply({ type: 'start', pub: sarah.pub }, false)                      // only host starts

// ---- warm-up round (round 0): the full loop on a fork of the lobby state —
// mild pool, R1 pairing pattern, points visibly land, then the debrief wipes
{
  let s = reduce(state, { type: 'start', pub: james.pub, practice: true }, content)
  assert.notEqual(s, state)
  assert.equal(s.round, 0)
  assert.equal(s.practice, true)
  assert.equal(s.phase, 'prompt')
  assert.ok(content.deck.practice.some(p => p.id === s.promptId), 'warm-up draws from the mild pool')
  const step = (act) => { const n = reduce(s, act, content); assert.notEqual(n, s, `warm-up: ${JSON.stringify(act)}`); s = n }
  assert.equal(reduce(s, { type: 'bowl', pub: james.pub, round: 0 }, content), s, 'no bowls in the warm-up')
  for (const p of P) step({ type: 'answered', pub: p.pub, round: 0 })
  assert.equal(s.phase, 'pairing')
  assert.deepEqual(s.pairs, pairingsFor(s.players, 1), 'warm-up uses round 1 pattern')
  step({ type: 'advance', pub: james.pub })
  assert.equal(s.phase, 'deal', 'the table-talk window opens before the dilemma, warm-up included')
  step({ type: 'advance', pub: james.pub })
  const wchoice = { [james.pub]: 'SHARE', [priya.pub]: 'HOLD', [sarah.pub]: 'SHARE', [marco.pub]: 'SHARE' }
  for (const p of P) step({ type: 'commit', pub: p.pub, round: 0, hash: commitHash(wchoice[p.pub], 'n0') })
  for (const p of P) step({ type: 'reveal', pub: p.pub, round: 0, choice: wchoice[p.pub], nonce: 'n0' })
  assert.equal(s.phase, 'outcome')
  assert.equal(s.scores[priya.pub], 5, 'warm-up scores land so people see the numbers')
  assert.equal(s.daggers[priya.pub], 1)
  step({ type: 'advance', pub: james.pub })                          // second outcome card
  step({ type: 'advance', pub: james.pub })
  assert.equal(s.phase, 'debrief', 'warm-up ends in a debrief, not a scoreboard')
  step({ type: 'advance', pub: james.pub })
  assert.equal(s.phase, 'prompt')
  assert.equal(s.round, 1)
  assert.equal(s.practice, false)
  assert.deepEqual(s.scores, {}, 'debrief wipes scores')
  assert.deepEqual(s.daggers, {})
  assert.deepEqual(s.collected, {}, 'warm-up secrets are not finale ammunition')
  assert.deepEqual(s.counters, {}, 'style counters reset too')
  assert.ok(flavorRounds(content, 'mild').find(r => r.round === 1).prompts.some(p => p.id === s.promptId))
}

// ---- flavor picker: each heat draws from its own pool; bad values fall
// back to mild; the default (no flavor in the act) is mild
for (const fl of FLAVORS) {
  const s = reduce(state, { type: 'start', pub: james.pub, flavor: fl }, content)
  assert.equal(s.flavor, fl)
  assert.ok(flavorRounds(content, fl).find(r => r.round === 1).prompts.some(p => p.id === s.promptId),
    `flavor ${fl} draws from its own round-1 pool`)
}
assert.equal(reduce(state, { type: 'start', pub: james.pub, flavor: 'nuclear' }, content).flavor, 'mild')

// the bowl is a host toggle, on by default
assert.equal(reduce(state, { type: 'start', pub: james.pub }, content).bowlOn, true)
assert.equal(reduce(state, { type: 'start', pub: james.pub, bowl: false }, content).bowlOn, false)

// ---- heat: the arc climbs on its own; "turn it up" shifts what's left, capped
{
  const s = reduce(state, { type: 'start', pub: james.pub, flavor: 'arc' }, content)
  assert.equal(s.flavor, 'arc')
  assert.ok(flavorRounds(content, 'mild').find(r => r.round === 1).prompts.some(p => p.id === s.promptId),
    'the arc starts innocent')
  assert.equal(heatFor('arc', 3, 0), 'spicy')
  assert.equal(heatFor('arc', 4, 0), 'scorching')
  assert.equal(heatFor('arc', 2, 1), 'spicy')            // a bump moves the early rounds up
  assert.equal(heatFor('mild', 2, 1), 'spicy')
  assert.equal(heatFor('scorching', 1, 2), 'scorching')  // capped at the top
}

host('start')
assert.equal(state.phase, 'prompt')
assert.equal(state.round, 1)
assert.equal(state.flavor, 'mild')                                   // the very-playable default

// pairing schedule sanity for 4 players
assert.deepEqual(pairingsFor(state.players, 1), [[james.pub, priya.pub], [sarah.pub, marco.pub]])
assert.deepEqual(pairingsFor(state.players, 2), [[james.pub, sarah.pub], [priya.pub, marco.pub]])
assert.deepEqual(pairingsFor(state.players, 3), [[james.pub, marco.pub], [sarah.pub, priya.pub]])
assert.deepEqual(pairingsFor(state.players, 4), pairingsFor(state.players, 2))
for (const n of [3, 5, 6]) {                                          // other counts: sane rounds
  const fake = Array.from({ length: n }, (_, i) => ({ pub: `p${i}`, seat: i + 1 }))
  for (let r = 1; r <= 4; r++) {
    const pairs = pairingsFor(fake, r)
    const flat = pairs.flat()
    assert.equal(new Set(flat).size, flat.length, `no dup in n=${n} r=${r}`)
    assert.equal(flat.length, n - (n % 2 === 0 ? 0 : 1))
  }
}

// ---- choices per round: covers trade, betrayal, stalemate; James collects
// nothing all night (auto-vault + sucker), Marco ends villain with 2 🗡.
const script = {
  1: { [james.pub]: 'SHARE', [priya.pub]: 'HOLD', [sarah.pub]: 'SHARE', [marco.pub]: 'SHARE' },
  2: { [james.pub]: 'HOLD', [sarah.pub]: 'HOLD', [priya.pub]: 'SHARE', [marco.pub]: 'SHARE' },
  3: { [james.pub]: 'SHARE', [marco.pub]: 'HOLD', [sarah.pub]: 'SHARE', [priya.pub]: 'SHARE' },
  4: { [james.pub]: 'SHARE', [sarah.pub]: 'HOLD', [priya.pub]: 'SHARE', [marco.pub]: 'HOLD' },
}

let preFinaleFork = null
const redrawRound = 2                                                 // exercise redraw once
for (let r = 1; r <= 4; r++) {
  assert.equal(state.phase, 'prompt')
  const pool = flavorRounds(content, state.flavor)[r - 1].prompts.map(p => p.id)
  assert.ok(pool.includes(state.promptId), 'prompt drawn from round pool')
  assert.equal(state.promptText,
    flavorRounds(content, state.flavor)[r - 1].prompts.find(p => p.id === state.promptId).text,
    'drawn prompt text travels in public state (MC deck indirection)')
  if (r === redrawRound) {
    const before = state.promptId
    host('redraw')
    assert.notEqual(state.promptId, before)
    apply({ type: 'redraw', pub: james.pub }, false)                  // once per round
  }

  // R1: James drops his confession in the bowl — opt-in, once, players only
  if (r === 1) {
    apply({ type: 'bowl', pub: james.pub, round: 1 })
    apply({ type: 'bowl', pub: james.pub, round: 1 }, false)          // once
    apply({ type: 'bowl', pub: stagePub, round: 1 }, false)           // players only
  }

  // everyone answers: real encrypted scope + public "answered" action
  for (const p of P) {
    const scopeId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
    const scopeKey = newScopeKey()
    await publishScope(relay, p.sk, {
      scopeId, generation: 1, scopeKey,
      payload: { text: secretText(p, r), round: r, prompt: state.promptId },
    })
    p.scopes[r] = { scopeId, scopeKey }
    apply({ type: 'answered', pub: p.pub, round: r })
  }
  assert.equal(state.phase, 'pairing', 'auto-advance when all answered')
  assert.ok(state.quip.length > 0)
  host('advance')
  assert.equal(state.phase, 'deal', 'a table-talk window opens between pairing and the dilemma')

  // the deal window: commits are impossible, promises are public and one-shot
  if (r === 1) {
    apply({ type: 'commit', pub: james.pub, round: r, hash: commitHash('SHARE', 'early') }, false)
    apply({ type: 'promise', pub: priya.pub, round: r })         // R1: Priya promises… then holds
    apply({ type: 'promise', pub: sarah.pub, round: r })         // Sarah promises and keeps it
    apply({ type: 'promise', pub: priya.pub, round: r }, false)  // one promise per player
    apply({ type: 'promise', pub: stagePub, round: r }, false)   // spectators can't promise
    assert.deepEqual(Object.keys(state.promises).sort(), [priya.pub, sarah.pub].sort())
  }
  host('advance')
  assert.equal(state.phase, 'dilemma')
  apply({ type: 'promise', pub: marco.pub, round: r }, false)    // window's closed

  // commit, then reveal — with one cheat attempt
  const nonces = {}
  for (const p of P) {
    nonces[p.pub] = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    apply({ type: 'commit', pub: p.pub, round: r, hash: commitHash(script[r][p.pub], nonces[p.pub]) })
  }
  const cheatChoice = script[r][james.pub] === 'SHARE' ? 'HOLD' : 'SHARE'
  apply({ type: 'reveal', pub: james.pub, round: r, choice: cheatChoice, nonce: nonces[james.pub] }, false)
  for (const p of P)
    apply({ type: 'reveal', pub: p.pub, round: r, choice: script[r][p.pub], nonce: nonces[p.pub] })
  assert.equal(state.phase, 'outcome', 'auto-resolve when all revealed')
  if (r === 1) {
    assert.deepEqual(state.outcomes[0].broken, [priya.pub], 'a promise followed by a HOLD is called out')
    assert.equal(state.outcomes[1].broken, undefined, 'a kept promise passes without comment')
  }
  if (r === 2) assert.deepEqual(state.promises, {}, 'promises reset each round')

  // sharers deliver: real gift-wrapped grants to counterparts
  for (const [a, b] of state.pairs) {
    for (const [me, other] of [[a, b], [b, a]]) {
      if (script[r][me] !== 'SHARE') continue
      const s = byPub[me].scopes[r]
      await grant(relay, byPub[me].sk, other, {
        scopeId: s.scopeId, generation: 1, scopeKey: s.scopeKey, scopeName: `r${r}`,
      })
    }
  }
  // receivers read privately, exactly what the owner wrote
  for (const p of P) {
    const grants = latestGrants(await receiveGrants(relay, p.sk))
    for (const g of grants) {
      const res = await fetchScope(relay, g)
      assert.equal(res.status, 'ok')
      p.collected[`${g.publisher}:${res.data.round}`] = res.data.text
      assert.equal(res.data.text, secretText(byPub[g.publisher], res.data.round))
    }
  }

  host('advance')                                                     // outcome pair 2
  assert.equal(state.phase, 'outcome')
  host('advance')
  if (r === 1) {
    // the table read: James's entry is the only one in the bowl, so it's drawn;
    // his phone surfaces the words, the table guesses, courage gets paid
    assert.equal(state.phase, 'table_read')
    assert.equal(state.tableRead.by, james.pub)
    apply({ type: 'whodunit', pub: sarah.pub, owner: james.pub }, false)  // no words yet
    apply({ type: 'bowl_text', pub: sarah.pub, text: 'imposter' }, false) // drawn author only
    apply({ type: 'bowl_text', pub: james.pub, text: secretText(james, 1) })
    assert.equal(state.tableRead.text, secretText(james, 1))
    apply({ type: 'whodunit', pub: james.pub, owner: sarah.pub }, false)  // author can't guess
    apply({ type: 'whodunit', pub: sarah.pub, owner: james.pub })         // right: +1
    apply({ type: 'whodunit', pub: sarah.pub, owner: marco.pub }, false)  // one guess each
    apply({ type: 'whodunit', pub: priya.pub, owner: marco.pub })         // wrong
    apply({ type: 'whodunit', pub: marco.pub, owner: sarah.pub })         // wrong → auto-reveal
    assert.equal(state.tableRead.revealed, true)
    assert.deepEqual(state.exposed[0],
      { owner: james.pub, round: 1, text: secretText(james, 1), by: james.pub, how: 'bowl' },
      'a bowled confession is deliberately, consentedly public')
    assert.ok(state.quip.includes('James'), 'the reveal quip names the author')
    host('advance')
  }
  assert.equal(state.phase, 'scoreboard')
  assert.ok(P.every(p => state.styles[p.pub]), 'everyone always has a style label')
  if (r === 1) {
    // the cold MC remembers: the only named fact so far is Priya's broken
    // promise, so the scoreboard callback must point at her
    assert.ok(state.callback.includes('Priya'), `callback names the promise-breaker: "${state.callback}"`)
    assert.ok(state.callback.includes('1'), 'and the round it happened')
  }
  if (r === 4) assert.ok(P.some(p => state.callback.includes(p.name)),
    `late callbacks still name a player: "${state.callback}"`)
  if (r === 1) {
    // fork: the table turns it up at the scoreboard — host-only, and the
    // next round draws from the hotter pool
    const hot = reduce(state, { type: 'heat_up', pub: james.pub }, content)
    assert.notEqual(hot, state)
    assert.equal(hot.heatBump, 1)
    assert.ok(hot.quip.length > 0)
    assert.equal(reduce(state, { type: 'heat_up', pub: sarah.pub }, content), state, 'host only')
    const next = reduce(hot, { type: 'advance', pub: james.pub }, content)
    assert.ok(flavorRounds(content, 'spicy').find(x => x.round === 2).prompts.some(p => p.id === next.promptId),
      'a bumped night draws the next round from the spicy pool')
  }
  if (r === 3) assert.equal(state.scores[marco.pub], 16, 'round 3 pays double (3+3+5×2)')
  if (r === 4) preFinaleFork = state                   // for the determinism check below
  host('advance')
}

// collected sets are public knowledge, derived from announced outcomes
assert.equal((state.collected[james.pub] || []).length, 0)
assert.equal(state.collected[sarah.pub].length, 3)
assert.equal(state.collected[priya.pub].length, 3)
assert.equal(state.collected[marco.pub].length, 4)
// private stashes match the public ledger
assert.equal(Object.keys(james.collected).length, 0)
assert.equal(Object.keys(marco.collected).length, 4)

// scores after 4 rounds, stakes ×1/×1/×2/×3: J 1+1+2+3 +2 bowl = 9,
// S 3+1+6+15 +1 right guess = 26, P 5+3+6+3 = 17, M 3+3+10+15 = 31 (2 🗡)
assert.deepEqual(P.map(p => state.scores[p.pub]), [9, 26, 17, 31])
assert.equal(state.daggers[marco.pub], 2)
assert.equal(state.suffered[james.pub], 3)

// ---- finale: reverse score order, tie → higher seat first
assert.equal(state.phase, 'finale_intro')
// the finale intro gets its own callback — deterministic: replaying the same
// advance narrates the same way
assert.ok(P.some(p => state.callback.includes(p.name)), `finale intro callback: "${state.callback}"`)
{
  const again = reduce(preFinaleFork, { type: 'advance', pub: james.pub }, content)
  assert.equal(again.callback, state.callback, 'same game, same memory')
}
host('advance')
assert.equal(state.phase, 'finale')
assert.deepEqual(state.finale.order, [james.pub, priya.pub, sarah.pub, marco.pub])

// turn 1 — James holds nothing: auto-vault (+2), non-humiliating pass
assert.equal(state.finale.step, 'result')
assert.equal(state.scores[james.pub], 11)
host('advance')

// turn 2 — Priya extorts James with his round-1 secret; he refuses; she
// reveals. She still holds two more, so the hand isn't over: she vaults out.
apply({ type: 'finale_choice', pub: priya.pub, action: 'extort', owner: james.pub, round: 1 })
assert.equal(state.finale.step, 'extort')
apply({ type: 'extort_response', pub: sarah.pub, turn: 1, pay: true }, false)  // only the target
apply({ type: 'extort_response', pub: james.pub, turn: 1, pay: false })
assert.equal(state.finale.step, 'decide')
apply({ type: 'blackmail_decision', pub: priya.pub, turn: 1, reveal: true, text: priya.collected[`${james.pub}:1`] })
assert.equal(state.scores[priya.pub], 19)
assert.equal(state.exposed[0].text, secretText(james, 1))
host('advance')
assert.equal(state.phase, 'finale')
assert.equal(state.finale.turn, 1, 'unspent ammunition keeps the hand alive')
assert.equal(state.finale.step, 'choose')
apply({ type: 'finale_choice', pub: priya.pub, action: 'extort', owner: james.pub, round: 1 }, false) // spent is spent
apply({ type: 'finale_choice', pub: priya.pub, action: 'vault' })              // the vault closes the hand
assert.equal(state.scores[priya.pub], 21)
host('advance')

// turn 3 — Sarah extorts Marco with his round-1 secret; he pays; she banks
// the rest in the vault
apply({ type: 'finale_choice', pub: sarah.pub, action: 'extort', owner: marco.pub, round: 1 })
apply({ type: 'extort_response', pub: marco.pub, turn: 2, pay: true })
assert.equal(state.scores[sarah.pub], 29)
assert.equal(state.scores[marco.pub], 28)
host('advance')
apply({ type: 'finale_choice', pub: sarah.pub, action: 'vault' })
assert.equal(state.scores[sarah.pub], 31)
host('advance')

// turn 4 — Marco burns Priya's round-4 secret, then shuts the vault himself
apply({ type: 'finale_choice', pub: marco.pub, action: 'burn', owner: james.pub, round: 2 }, false) // not held
apply({ type: 'finale_choice', pub: marco.pub, action: 'burn', owner: priya.pub, round: 4, text: marco.collected[`${priya.pub}:4`] })
assert.equal(state.scores[marco.pub], 29)
host('advance')
apply({ type: 'finale_choice', pub: marco.pub, action: 'burn', owner: priya.pub, round: 4 }, false)  // spent is spent
apply({ type: 'finale_choice', pub: marco.pub, action: 'vault' })
host('advance')

// ---- the reckoning
assert.equal(state.phase, 'final')
assert.deepEqual(P.map(p => state.scores[p.pub]), [11, 31, 21, 31])
assert.equal(state.ending.villain, 'Marco')
assert.equal(state.ending.vd, 2)
assert.equal(state.ending.sucker, 'James')
assert.equal(state.ending.sn, 3)
assert.ok(state.quip.includes('Marco') && state.quip.includes('James'))

// ---- awards + recap: templated from what actually happened, no AI needed
const award = (k) => state.ending.awards.find(a => a.k === k)
assert.equal(award('openBook').name, 'James', 'most shares (3, ties resolve to first earned)')
assert.equal(award('vault').name, 'Sarah', 'most holds (2, ties resolve to first earned)')
assert.equal(award('snake').name, 'Priya', 'promised in the deal window, then held')
assert.equal(award('bold').name, 'James', 'fed the bowl')
// the story: warm-up wiped, then betrayals, the broken promise, the bowl,
// and the finale's knives — in order
const ts = state.story.map(e => e.t)
assert.deepEqual(ts, ['promiseBroken', 'betrayal', 'bowl', 'betrayal', 'betrayal', 'betrayal', 'exposed', 'paid', 'burn'])
assert.deepEqual(state.story[1], { t: 'betrayal', winner: 'Priya', loser: 'James', r: 1, m: 1 })
assert.equal(state.story[5].m, 3, 'the money round is remembered at its stakes')

// ---- style profiles evolved correctly against this scripted log:
// James was betrayed thrice (The Mark, earned R3, outlasting his R1 Open
// Book), Sarah's extortion got paid (The Enforcer, earned at the finale),
// Priya hit 75% shares at the last evaluation (The Open Book, newest-earned
// over her R3 Diplomat), Marco burned one (The Anarchist — newest-earned
// over his Shark daggers and Wildcard flip).
assert.equal(state.styles[james.pub], ARCHETYPES.mark)
assert.equal(state.styles[sarah.pub], ARCHETYPES.enforcer)
assert.equal(state.styles[priya.pub], ARCHETYPES.openBook)
assert.equal(state.styles[marco.pub], ARCHETYPES.anarchist)
// Diplomat and Wildcard were nonetheless earned along the way
assert.ok(state.styleHist[priya.pub][ARCHETYPES.diplomat] > 0)
assert.ok(state.styleHist[marco.pub][ARCHETYPES.wildcard] > 0)
assert.ok(state.styleHist[marco.pub][ARCHETYPES.shark] > 0)

// ---- stage privacy by construction: its key received ZERO grants all night
assert.equal((await receiveGrants(relay, stageSk)).length, 0,
  'the stage key must never be granted anything')
// and the public state it renders contains no unexposed secret
const stateJson = JSON.stringify(state)
for (const p of P) for (let r = 1; r <= 4; r++) {
  const text = secretText(p, r)
  if (!state.exposed.some(x => x.text === text))
    assert.ok(!stateJson.includes(text), `state must not leak: ${text}`)
}

// ---- adversarial check: what does the relay operator learn?
// Store the final public state on the relay the way the host would, then
// assert no unexposed secret plaintext appears anywhere in stored content.
const { finalizeEvent } = await import('../vendor/nostr-tools.js')
relay.publish(finalizeEvent({
  kind: 30078, created_at: Math.floor(Date.now() / 1000),
  tags: [['d', 'ntg:testgame:state'], ['t', 'testgame']],
  content: JSON.stringify(state),
}, james.sk))

const everything = relay.events.map(e => e.content).join('\n')
const exposedTexts = state.exposed.map(x => x.text)
for (const p of P) for (let r = 1; r <= 4; r++) {
  const text = secretText(p, r)
  if (exposedTexts.includes(text)) {
    assert.ok(everything.includes(text), `deliberately public: ${text}`)
  } else {
    assert.ok(!everything.includes(text), `relay must never see: ${text}`)
  }
}
assert.equal(exposedTexts.length, 3)          // bowl read + blackmail reveal + burn
const kinds = new Set(relay.events.map(e => e.kind))
assert.deepEqual([...kinds].sort((a, b) => a - b), [1059, 30078, 30440])

// ---- AI MC privacy: the input builders take only the public state, so no
// model prompt can ever contain an unexposed secret. Prove it on this game.
const mcInputs = [
  buildQuipInput(state, 'betrayal', { winner: 'Marco', loser: 'James' }),
  buildRoastInput(state),
  buildDeckInput({ groupContext: 'two couples', spice: 2, avoid: 'health', playerNames: P.map(p => p.name) }),
  JSON.stringify(buildPublicLog(state)),
].join('\n')
for (const p of P) for (let r = 1; r <= 4; r++) {
  const text = secretText(p, r)
  if (state.exposed.some(x => x.text === text))
    assert.ok(mcInputs.includes(text), 'exposed secrets ARE fair game for the MC')
  else assert.ok(!mcInputs.includes(text), `MC input must never contain: ${text}`)
}

// ---- MC deck shaping: self-check failures drop; thin rounds fall back
const gen = {
  rounds: [
    { round: 1, candidates: [
      { text: 'Gen A?', policy_ok: true, reason: 'ok' },
      { text: 'Gen B?', policy_ok: true, reason: 'ok' },
      { text: 'Too mean?', policy_ok: false, reason: 'targets appearance' },
    ]},
    { round: 2, candidates: [{ text: 'Only one?', policy_ok: true, reason: 'ok' }] },
  ],
}
const staticSpicy = { rounds: flavorRounds(content, 'spicy') }
const shaped = toDeckShape(gen, staticSpicy)
assert.deepEqual(shaped.rounds[0].prompts.map(p => p.text), ['Gen A?', 'Gen B?'])
assert.equal(shaped.rounds[0].prompts[0].id, 100)                    // stable ids
assert.equal(shaped.rounds[1], staticSpicy.rounds[1])                // <2 ok → static
assert.equal(shaped.rounds[2], staticSpicy.rounds[2])                // missing → static

// ---- lenient JSON extraction (the keyless public backend is chatty)
assert.deepEqual(extractJson('Sure! Here you go:\n{"text":"A line.","policy_ok":true,"reason":"ok"}\nEnjoy!'),
  { text: 'A line.', policy_ok: true, reason: 'ok' })
assert.deepEqual(extractJson('{"choices":[{"message":{"content":"hi"}}]}').choices[0].message.content, 'hi')
assert.equal(extractJson('no json here'), null)
assert.equal(extractJson('{broken'), null)
assert.equal(extractJson(undefined), null)

// ---- MC quip/roast upgrades apply through the reducer, host-only, stale-safe
{
  let s2 = state
  s2 = reduce(s2, { type: 'mc_roast', pub: james.pub, cards: ['Card one.', 'Card two.'] }, content)
  assert.deepEqual(s2.roast, ['Card one.', 'Card two.'])
  assert.equal(reduce(s2, { type: 'mc_roast', pub: james.pub, cards: ['Again'] }, content), s2)   // once
  assert.equal(reduce(state, { type: 'mc_roast', pub: sarah.pub, cards: ['Nope'] }, content), state) // host-only
  assert.equal(reduce(state, { type: 'mc_quip', pub: james.pub, slot: 'quip', phase: 'scoreboard', text: 'stale' }, content), state)
}

console.log('sim ok — full game, scores exact, villain/sucker right,')
console.log('        relay saw ciphertext + wraps + public state only;')
console.log('        MC inputs provably free of unexposed secrets;')
console.log(`        ${relay.events.length} events, 3 deliberate exposures (bowl · blackmail · burn), 14 secrets stayed secret.`)
