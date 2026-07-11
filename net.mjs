// net.mjs — transport. Same publish/query interface as the protocol repo's
// liverelay.mjs (SimplePool against public relays), plus live subscriptions —
// phones need push, not polling. Browser-native WebSocket; also runs in
// node ≥ 22 for tests.

import { SimplePool, finalizeEvent } from './vendor/nostr-tools.js'

export const KIND_APP = 30078          // NIP-78 app data: game state + actions
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

// Strictly increasing timestamps so rapid republishes of the same addressable
// event never tie on created_at and lose NIP-01 replacement.
let lastTs = 0
export const now = () => (lastTs = Math.max(Math.floor(Date.now() / 1000), lastTs + 1))

export class Net {
  constructor(urls = DEFAULT_RELAYS) {
    this.urls = urls
    this.pool = new SimplePool()
  }

  /** Publish to all relays; resolve when at least one ACKs. Silent relays
   *  count as rejections (8s race), not hangs. */
  async publish(event) {
    const timeout = () => new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), 8000))
    const results = await Promise.allSettled(
      this.pool.publish(this.urls, event).map(p => Promise.race([p, timeout()])))
    const acks = results.filter(r => r.status === 'fulfilled').length
    if (acks === 0) throw new Error(`no relay accepted kind ${event.kind}`)
    return { acks, of: this.urls.length }
  }

  async query(filter) {
    const events = await this.pool.querySync(this.urls, filter, { maxWait: 4000 })
    const seen = new Set()
    return events
      .filter(e => !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => b.created_at - a.created_at)
  }

  /** Live subscription across all relays; returns a closer. */
  subscribe(filters, onevent) {
    const sub = this.pool.subscribeMany(this.urls, filters, {
      onevent: (e) => { try { onevent(e) } catch (err) { console.error(err) } },
    })
    return () => sub.close()
  }

  close() { try { this.pool.close(this.urls) } catch { /* already closed */ } }
}

// ---------------------------------------------------------------- game wire

export const dState = (gid) => `ntg:${gid}:state`

/** Sign + publish one game action as an addressable app-data event.
 *  `dSuffix` makes actions idempotent: re-sends replace, never duplicate. */
export async function sendAction(net, sk, gid, dSuffix, payload) {
  const event = finalizeEvent({
    kind: KIND_APP,
    created_at: now(),
    tags: [['d', `ntg:${gid}:${dSuffix}`], ['t', gid]],
    content: JSON.stringify(payload),
  }, sk)
  return { event, ...(await net.publish(event)) }
}

/** Parse an action event into a reducer act (author taken from the
 *  signature-verified event, never from content). */
export function parseAction(gid, event) {
  const d = event.tags.find(t => t[0] === 'd')?.[1] || ''
  if (!d.startsWith(`ntg:${gid}:`) || d === dState(gid)) return null
  let body
  try { body = JSON.parse(event.content) } catch { return null }
  if (!body || typeof body.type !== 'string') return null
  return { ...body, pub: event.pubkey }
}
