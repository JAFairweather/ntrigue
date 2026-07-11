// test/relay.mjs — the protocol repo's ~40-line in-memory relay, imports
// pointed at the vendored bundle. Enough NIP-01 for the whole game: storage,
// filter queries, addressable replacement.

import { matchFilter, verifyEvent } from '../vendor/nostr-tools.js'

const isAddressable = (kind) => kind >= 30000 && kind < 40000
const isReplaceable = (kind) => kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
const dTag = (event) => event.tags.find(t => t[0] === 'd')?.[1] ?? ''

const replaceKey = (e) =>
  isAddressable(e.kind) ? `${e.kind}:${e.pubkey}:${dTag(e)}`
  : isReplaceable(e.kind) ? `${e.kind}:${e.pubkey}`
  : null

export class Relay {
  events = []

  publish(event) {
    if (!verifyEvent(event)) throw new Error('invalid signature')
    const key = replaceKey(event)
    if (key) this.events = this.events.filter(e => replaceKey(e) !== key)
    this.events.push(event)
  }

  query(filter) {
    return this.events
      .filter(e => matchFilter(filter, e))
      .sort((a, b) => b.created_at - a.created_at)
  }

  /** What an adversarial relay operator actually learns. */
  observerView() {
    return this.events.map(e => ({
      kind: e.kind,
      pubkey: e.pubkey.slice(0, 8) + '…',
      d: dTag(e) || undefined,
      bytes: e.content.length,
    }))
  }
}
