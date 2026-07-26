// test/engine.mjs — a full 4-player night played entirely through the
// headless move API (issue #31): one Engine hosts, three more join, and
// the game runs lobby → final over the strict dev relay with no DOM and
// no bespoke harness. Secrets travel the real pipeline (sealed scopes,
// gift-wrapped grants), so this is the supported way to play-test.
//
//   node test/engine.mjs

import assert from 'node:assert/strict'
import { Engine } from '../engine.mjs'
import { startDevRelay } from './devrelay.mjs'

const PORT = 7798
const relay = startDevRelay(PORT)
const RELAYS = [`ws://localhost:${PORT}`]

// ---- seats: the host is also a player; couples shape to pin the schedule
const host = await Engine.createTable({ relays: RELAYS })
await host.connect()
const guests = []
for (const name of ['Sarah', 'Priya', 'Marco']) {
  const g = Engine.fromLink(host.joinLink())
  await g.connect()
  guests.push(g)
}
const [sarah, priya, marco] = guests
const all = [host, ...guests]
const named = { James: host, Sarah: sarah, Priya: priya, Marco: marco }

await host.sitDown('James')
for (const [name, e] of Object.entries(named)) if (e !== host) await e.sitDown(name)
await host.waitFor(s => s.players.length === 4)
await host.order(all.map(e => e.pub))                 // seats 1-4 in fixture order
await host.start({ practice: false, shape: 'couples', bowl: true })

// ---- four rounds through the public API: R1 has a bowl read, R3 a betrayal
const script = {
  1: { James: 'SHARE', Sarah: 'SHARE', Priya: 'HOLD', Marco: 'SHARE' },
  2: { James: 'SHARE', Sarah: 'SHARE', Priya: 'SHARE', Marco: 'SHARE' },
  3: { James: 'SHARE', Sarah: 'SHARE', Priya: 'SHARE', Marco: 'HOLD' },
  4: { James: 'SHARE', Sarah: 'SHARE', Priya: 'SHARE', Marco: 'SHARE' },
}
for (let r = 1; r <= 4; r++) {
  await host.waitFor(s => s.phase === 'prompt' && s.round === r)
  for (const [name, e] of Object.entries(named)) {   // James first: he bowls
    await e.waitFor(s => s.phase === 'prompt' && s.round === r)
    await e.lockSecret(`${name} secret r${r}`)
    if (r === 1 && e === host) await host.bowl()     // while the table's still writing
  }
  await host.waitFor(s => s.phase === 'pairing')
  await host.advance()                                 // → deal
  if (r === 3) {                                       // a promise he won't keep —
    await named.Marco.promise()                        // and the host waits to SEE it
    await host.waitFor(s => s.promises[named.Marco.pub])
  }
  await host.advance()                                 // → dilemma
  if (r === 1) {
    // early hand-over (playtest feedback): James SHAREs into Priya's HOLD.
    // The moment HIS reveal is public his engine grants — so Priya holds
    // his words while the round is still undecided (Marco hasn't moved).
    for (const name of ['James', 'Sarah', 'Priya']) {
      await named[name].waitFor(s => s.phase === 'dilemma')
      await named[name].choose(script[1][name])
    }
    await host.waitFor(s => s.choices[host.pub] === 'SHARE')
    for (let i = 0; i < 60 && !priya.collected[`${host.pub}:1`]; i++)
      await new Promise(res => setTimeout(res, 250))
    assert.equal(host.state.phase, 'dilemma', 'the round is still open…')
    assert.equal(priya.collected[`${host.pub}:1`], 'James secret r1',
      '…but the shared secret already crossed — no waiting on "Opening…"')
    await named.Marco.waitFor(s => s.phase === 'dilemma')
    await named.Marco.choose(script[1].Marco)
  } else {
    for (const [name, e] of Object.entries(named)) {
      await e.waitFor(s => s.phase === 'dilemma')
      await e.choose(script[r][name])
    }
  }
  await host.waitFor(s => s.phase === 'outcome')
  if (r === 2) {
    // timer honesty: a burst of reactions shoves the strictly-increasing
    // event-id counter well past the wall clock; the NEXT card's phaseAt
    // must still be wall time (first playtest: timers grew every round)
    for (let i = 0; i < 8; i++) for (const g of guests) await g.react('😱')
    await host.waitFor(s => (s.reactions?.counts?.['😱'] || 0) >= 24)
  }
  if (r === 3) assert.ok(host.state.outcomes.some(o => o.broken?.length), 'the broken promise is marked')
  await host.advance()                                 // outcome pair 2
  await host.advance()                                 // → table read (R1) or scoreboard
  if (r === 1) {
    // James's bowled entry is the only one: his engine surfaces the text on
    // its own; the other three guess through the API
    await host.waitFor(s => s.phase === 'table_read' && s.tableRead.text === 'James secret r1')
    for (const g of guests) await g.whodunit(host.pub) // everyone right: +1 each
    await host.waitFor(s => s.tableRead.revealed)
    await host.advance()
  }
  await host.waitFor(s => s.phase === 'scoreboard')
  if (r === 2) {
    const drift = host.state.phaseAt - Date.now() / 1000
    assert.ok(Math.abs(drift) < 4, `phaseAt is wall time, not the event counter (drift ${drift.toFixed(1)}s)`)
  }
  await host.advance()
}

// trades delivered over the real pipeline: Sarah (James's R1-R4 partner in
// rounds 2 & 4) holds his words privately
await host.waitFor(s => s.phase === 'finale_intro')
// grant delivery is async and off-state (collected isn't state) — poll it
for (let i = 0; i < 60 && !sarah.collected[`${host.pub}:2`]; i++)
  await new Promise(r => setTimeout(r, 250))
assert.equal(sarah.collected[`${host.pub}:2`], 'James secret r2', 'the trade really delivered')

// ---- finale via the API: everyone vaults except Marco, who burns then vaults
await host.advance()
for (let guard = 0; guard < 12 && host.state.phase === 'finale'; guard++) {
  const s = host.state
  const f = s.finale
  if (f.step === 'choose') {
    const actor = all.find(e => e.pub === f.order[f.turn])
    const held = s.collected[actor.pub] || []
    if (actor === marco && !f.used.length && held.length) {
      const t = held[0]
      await actor.finaleMove('burn', { owner: t.owner, round: t.round })
    } else await actor.finaleMove('vault')
    await host.waitFor(x => x.finale?.step === 'result' || x.phase === 'final')
  }
  if (host.state.phase === 'finale' && host.state.finale.step === 'result') await host.advance()
}

await host.waitFor(s => s.phase === 'final')
const final = host.state
assert.ok(final.ending.awards.length >= 2, 'awards minted from real events')
assert.equal(final.ending.awards.find(a => a.k === 'bold')?.name, 'James', 'the bowl was his')
assert.equal(final.ending.awards.find(a => a.k === 'snake')?.name, 'Marco', 'promised, then held')
assert.ok(final.story.some(e => e.t === 'betrayal' && e.winner === 'Marco'), 'the story remembers R3')

// every phone converged on the same final state
for (const e of guests) {
  await e.waitFor(s => s.phase === 'final')
  assert.deepEqual(e.state.scores, final.scores, 'all seats agree on the reckoning')
}

for (const e of all) e.close()
relay.close()
console.log('engine ok — a full night, lobby → final, played headless through')
console.log('        the supported move API: bowl read, broken promise, betrayal,')
console.log('        real sealed-scope trades, finale burns, awards and recap.')
process.exit(0)
