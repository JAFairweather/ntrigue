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
import { initialState, reduce, commitHash, pairingsFor } from '../state.mjs'
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

// ---- lobby
for (const p of P) apply({ type: 'join', pub: p.pub, name: p.name })
apply({ type: 'join', pub: marco.pub, name: 'Marco' }, false)        // dup join ignored
apply({ type: 'order', pub: james.pub, order: P.map(p => p.pub) })
apply({ type: 'start', pub: sarah.pub }, false)                      // only host starts
host('start')
assert.equal(state.phase, 'prompt')
assert.equal(state.round, 1)

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

const redrawRound = 2                                                 // exercise redraw once
for (let r = 1; r <= 4; r++) {
  assert.equal(state.phase, 'prompt')
  const pool = content.deck.rounds[r - 1].prompts.map(p => p.id)
  assert.ok(pool.includes(state.promptId), 'prompt drawn from round pool')
  if (r === redrawRound) {
    const before = state.promptId
    host('redraw')
    assert.notEqual(state.promptId, before)
    apply({ type: 'redraw', pub: james.pub }, false)                  // once per round
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
  assert.equal(state.phase, 'dilemma')

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
  assert.equal(state.phase, 'scoreboard')
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

// scores after 4 rounds: J 4 (betrayed 3x), S 12, P 12, M 16 (2 🗡)
assert.deepEqual(P.map(p => state.scores[p.pub]), [4, 12, 12, 16])
assert.equal(state.daggers[marco.pub], 2)
assert.equal(state.suffered[james.pub], 3)

// ---- finale: reverse score order, tie → higher seat first
assert.equal(state.phase, 'finale_intro')
host('advance')
assert.equal(state.phase, 'finale')
assert.deepEqual(state.finale.order, [james.pub, priya.pub, sarah.pub, marco.pub])

// turn 1 — James holds nothing: auto-vault (+2), non-humiliating pass
assert.equal(state.finale.step, 'result')
assert.equal(state.scores[james.pub], 6)
host('advance')

// turn 2 — Priya extorts James with his round-1 secret; he refuses; she reveals
apply({ type: 'finale_choice', pub: priya.pub, action: 'extort', owner: james.pub, round: 1 })
assert.equal(state.finale.step, 'extort')
apply({ type: 'extort_response', pub: sarah.pub, turn: 1, pay: true }, false)  // only the target
apply({ type: 'extort_response', pub: james.pub, turn: 1, pay: false })
assert.equal(state.finale.step, 'decide')
apply({ type: 'blackmail_decision', pub: priya.pub, turn: 1, reveal: true, text: priya.collected[`${james.pub}:1`] })
assert.equal(state.scores[priya.pub], 14)
assert.equal(state.exposed[0].text, secretText(james, 1))
host('advance')

// turn 3 — Sarah extorts Marco with his round-1 secret; he pays
apply({ type: 'finale_choice', pub: sarah.pub, action: 'extort', owner: marco.pub, round: 1 })
apply({ type: 'extort_response', pub: marco.pub, turn: 2, pay: true })
assert.equal(state.scores[sarah.pub], 15)
assert.equal(state.scores[marco.pub], 13)
host('advance')

// turn 4 — Marco burns Priya's round-4 secret, straight to the room
apply({ type: 'finale_choice', pub: marco.pub, action: 'burn', owner: james.pub, round: 2 }, false) // not held
apply({ type: 'finale_choice', pub: marco.pub, action: 'burn', owner: priya.pub, round: 4, text: marco.collected[`${priya.pub}:4`] })
assert.equal(state.scores[marco.pub], 14)
host('advance')

// ---- the reckoning
assert.equal(state.phase, 'final')
assert.deepEqual(P.map(p => state.scores[p.pub]), [6, 15, 14, 14])
assert.equal(state.ending.villain, 'Marco')
assert.equal(state.ending.vd, 2)
assert.equal(state.ending.sucker, 'James')
assert.equal(state.ending.sn, 3)
assert.ok(state.quip.includes('Marco') && state.quip.includes('James'))

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
assert.equal(exposedTexts.length, 2)
const kinds = new Set(relay.events.map(e => e.kind))
assert.deepEqual([...kinds].sort((a, b) => a - b), [1059, 30078, 30440])

console.log('sim ok — full game, scores exact, villain/sucker right,')
console.log('        relay saw ciphertext + wraps + public state only;')
console.log(`        ${relay.events.length} events, 2 deliberate reveals, 14 secrets stayed secret.`)
