// test/devrelay.mjs — a minimal NIP-01 relay over WebSocket for the browser
// test: EVENT storage with addressable replacement, REQ/EOSE, live fan-out.
// Needs the `ws` package (dev-only; see README). Not part of the game.

import { WebSocketServer } from 'ws'
import { Relay } from './relay.mjs'

export function startDevRelay(port = 7777) {
  const store = new Relay()
  const wss = new WebSocketServer({ port })
  const subs = new Map()            // ws -> Map(subId -> filters)

  wss.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('close', () => subs.delete(ws))
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      const [verb, ...rest] = msg
      if (verb === 'EVENT') {
        const event = rest[0]
        try { store.publish(event) } catch { return ws.send(JSON.stringify(['OK', event.id, false, 'invalid'])) }
        ws.send(JSON.stringify(['OK', event.id, true, '']))
        for (const [sock, m] of subs) for (const [id, filters] of m)
          if (filters.some(f => store.query(f).some(e => e.id === event.id)))
            sock.send(JSON.stringify(['EVENT', id, event]))
      } else if (verb === 'REQ') {
        const [id, ...filters] = rest
        subs.get(ws).set(id, filters)
        const seen = new Set()
        for (const f of filters) for (const e of store.query(f))
          if (!seen.has(e.id) && seen.add(e.id)) ws.send(JSON.stringify(['EVENT', id, e]))
        ws.send(JSON.stringify(['EOSE', id]))
      } else if (verb === 'CLOSE') {
        subs.get(ws)?.delete(rest[0])
      }
    })
  })
  return { store, close: () => wss.close() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDevRelay(Number(process.argv[2]) || 7777)
  console.log('dev room open on ws://localhost:' + (process.argv[2] || 7777))
}
