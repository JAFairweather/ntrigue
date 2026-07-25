// test/net.mjs — transport against the strict dev relay: the wire shapes
// and failure modes that bit a live table (issue #25). Covers the primal
// "filter is not an object" reproduction, the corrected multi-filter REQ,
// and publish retry through a transiently silent relay.
//
//   node test/net.mjs

import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { generateSecretKey, finalizeEvent } from '../vendor/nostr-tools.js'
import { Net, KIND_APP, sendAction, now } from '../net.mjs'
import { startDevRelay } from './devrelay.mjs'

const PORT = 7799
const relay = startDevRelay(PORT)
const URL_ = `ws://localhost:${PORT}`
const sk = generateSecretKey()

// ---- 1. the primal reproduction: a filters ARRAY jammed into the REQ as a
// single "filter" draws the exact NOTICE we saw live from relay.primal.net
{
  const ws = new WebSocket(URL_)
  const notice = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'bad', [{ kinds: [KIND_APP] }]])))
    ws.on('message', (m) => { const [v, text] = JSON.parse(m); if (v === 'NOTICE') resolve(text) })
    setTimeout(() => reject(new Error('strict relay must NOTICE-reject an array filter')), 3000)
  })
  assert.match(notice, /filter is not an object/)
  ws.close()
}

// ---- 2. Net.subscribe sends real object filters: a two-filter subscription
// survives the strict relay and BOTH filters deliver live events
{
  const net = new Net([URL_])
  const got = []
  const unsub = net.subscribe(
    [{ kinds: [KIND_APP], '#t': ['nettest'] }, { kinds: [KIND_APP], '#t': ['other'] }],
    (e) => got.push(e))
  await new Promise(r => setTimeout(r, 400))
  await sendAction(net, sk, 'nettest', 'a1', { type: 'ping' })
  await sendAction(net, sk, 'other', 'b1', { type: 'ping' })
  await new Promise(r => setTimeout(r, 600))
  assert.equal(got.length, 2, 'both filters of one subscription deliver through a strict relay')
  unsub()
  net.close()
}

// ---- 3. publish resilience: a transient silent beat is retried through;
// a dead room fails loudly WITH per-relay detail
{
  const net = new Net([URL_])
  const ev = (suffix) => finalizeEvent({
    kind: KIND_APP, created_at: now(),
    tags: [['d', `ntg:retry:${suffix}`], ['t', 'retry']], content: '{}',
  }, sk)

  relay.dropOks = 1                                     // one silent beat…
  const res = await net.publish(ev('transient'), { retries: 2, ackTimeout: 500 })
  assert.equal(res.acks, 1, '…and the retry lands the push anyway')
  assert.ok(res.detail.some(d => d.includes('ok')), 'per-relay detail on success')
  assert.equal(relay.dropOks, 0)

  relay.dropOks = 99                                    // relay gone quiet for good
  await assert.rejects(
    net.publish(ev('dead'), { retries: 1, ackTimeout: 300 }),
    (e) => /no relay accepted/.test(e.message) &&
           Array.isArray(e.detail) && /timeout/.test(e.detail[0]),
    'a dead push fails with per-relay detail, not a bare count')
  relay.dropOks = 0
  net.close()
}

relay.close()
console.log('net ok — strict relay rejects the wrapped-array filter (the primal bug),')
console.log('        Net subscriptions send real object filters and both deliver,')
console.log('        publish retries through a silent beat and fails loudly with detail.')
process.exit(0)
