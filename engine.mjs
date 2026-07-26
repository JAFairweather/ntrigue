// engine.mjs — the headless NTRIGUE client: everything app.mjs does except
// pixels. One Engine is one seat at the table (player, host, or both), with
// a documented move API for agents, bots, CI, and hosts that aren't phones.
// Wire-compatible with the browser app — a phone and an Engine can sit at
// the same table — because it reuses the same reducer, transport, and
// idempotent action ids.
//
//   node engine.mjs host [--relay ws://localhost:7777]
//   node engine.mjs bot <CODE|join-link> <Name> [--relay ws://localhost:7777]
//
// The CLI `host` opens a table, prints the code + links, and runs host
// duties (auto-advancing like a patient host). `bot` joins and plays a
// full night at random — the crew's play.mjs, but supported.

import { generateSecretKey, getPublicKey, bytesToHex, hexToBytes } from './vendor/nostr-tools.js'
import { publishScope, grant, receiveGrants, latestGrants, fetchScope, newScopeKey } from './nipxx.mjs'
import { Net, KIND_APP, DEFAULT_RELAYS, dState, sendAction, parseAction, now, codeTag, findGameByCode } from './net.mjs'
import { initialState, reduce, commitHash, unspentOf, SCHEMA_VERSION, DEAL_SECS, STAGE_STALE_SECS } from './state.mjs'

// scope keys live in `local` as base64 so a browser embedder can JSON the
// whole thing straight into localStorage
const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
const unb64 = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0))

// Node loads the deck from disk; a browser embedder passes `content` in
// (the dynamic import keeps this file bundleable for the view someday).
async function defaultContent() {
  const { readFile } = await import('node:fs/promises')
  const [deck, quips] = await Promise.all([
    readFile(new URL('./deck.json', import.meta.url)).then(JSON.parse),
    readFile(new URL('./quips.json', import.meta.url)).then(JSON.parse),
  ])
  return { deck, quips }
}

export class Engine {
  /** Open a new table (this Engine is the host). */
  static async createTable({ relays = DEFAULT_RELAYS, content } = {}) {
    const sk = generateSecretKey()
    const e = new Engine({
      gid: bytesToHex(crypto.getRandomValues(new Uint8Array(4))),
      relays, sk, hostPub: getPublicKey(sk), content,
    })
    e.isHost = true
    return e
  }

  /** Join by a full game link (or its parsed {gid, relays, hostPub}). */
  static fromLink(link, { content } = {}) {
    const h = new URLSearchParams(String(link).split('#')[1] || String(link))
    if (!h.get('g')) throw new Error('not a game link')
    return new Engine({
      gid: h.get('g'),
      relays: (h.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent),
      hostPub: h.get('h'), content,
    })
  }

  /** Join by the 4-letter room code (resolved over the given relays). */
  static async fromCode(code, { relays = DEFAULT_RELAYS, content } = {}) {
    const probe = new Net(relays)
    const found = await findGameByCode(probe, code).catch(() => null)
    probe.close()
    if (!found) throw new Error(`no table with code ${code}`)
    return new Engine({ ...found, relays: found.relays?.length ? found.relays : relays, content })
  }

  constructor({ gid, relays, hostPub, sk, content, local, onLocal, restoreState }) {
    this.gid = gid
    this.relays = relays?.length ? relays : DEFAULT_RELAYS
    this.hostPub = hostPub
    this.sk = sk || generateSecretKey()
    this.pub = getPublicKey(this.sk)
    this.isHost = this.pub === hostPub
    this.content = content || null
    this.state = null
    this.listeners = new Set()
    this.unsubs = []
    // per-game client data — a browser embedder passes its persisted copy in
    // and an onLocal callback that fires after every mutation (to save it)
    this.local = { scopes: {}, pending: {}, granted: {}, pairsByRound: {}, collected: {}, ...(local || {}) }
    this.onLocal = onLocal || null
    this.restoreState = restoreState || null   // host: last published state, rejoin-proof
    this.stalled = false                       // a state push nobody accepted (host)
    this.seenStateTs = 0
    this.dealClosed = ''
    this.probeMisses = 0
    this.busy = { deliver: false, effects: false, collect: false }
  }

  /** Connect: fetch the latest state, arm subscriptions, start host duties. */
  async connect({ tick = true } = {}) {
    this.content = this.content || await defaultContent()
    this.net = new Net(this.relays)
    const [remote] = await this.net.query({
      kinds: [KIND_APP], authors: [this.hostPub], '#d': [dState(this.gid)],
    }).catch(() => [])
    if (remote) this.#applyStateEvent(remote)
    else if (this.isHost)
      this.state = this.restoreState ||
        initialState({ gid: this.gid, host: this.pub, relays: this.relays })
    if (this.isHost) await this.#hostCatchUp()
    this.#subscribeAll()
    if (this.isHost && !remote) await this.#publishState()
    if (tick) this.timer = setInterval(() => this.#tick().catch(() => {}), 1000)
    return this
  }

  #subscribeAll() {
    if (!this.isHost) this.unsubs.push(this.net.subscribe(
      [{ kinds: [KIND_APP], authors: [this.hostPub], '#d': [dState(this.gid)] }],
      (e) => this.#applyStateEvent(e)))
    this.unsubs.push(this.net.subscribe(
      [{ kinds: [1059], '#p': [this.pub] }], () => this.#refreshCollected()))
    if (this.isHost) this.unsubs.push(this.net.subscribe(
      [{ kinds: [KIND_APP], '#t': [this.gid] }], (e) => this.#hostIngest(e)))
  }

  // Sleeping phones leave zombie connections: they look open and deliver
  // nothing. When even the poll goes quiet, tear the pool down and rebuild.
  async rebuildNet() {
    for (const u of this.unsubs.splice(0)) { try { u() } catch { /* gone */ } }
    try { this.net.close() } catch { /* gone */ }
    this.net = new Net(this.relays)
    this.#subscribeAll()
    if (this.isHost) { await this.#hostCatchUp().catch(() => {}); await this.#publishState() }
    await this.wake()
  }

  /** Back from the background: fetch and flush everything owed, right now. */
  async wake() {
    await this.#deliverAnswer().catch(() => {})
    await this.#autoEffects().catch(() => {})
    await this.#refreshCollected().catch(() => {})
  }

  close() {
    clearInterval(this.timer)
    for (const u of this.unsubs.splice(0)) { try { u() } catch { /* gone */ } }
    try { this.net.close() } catch { /* gone */ }
  }

  // ---------------------------------------------------------------- follow

  /** Listeners get (state, prev); prev is undefined for off-state pings
   *  (e.g. a collected secret arriving). */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** Resolve when the state matches. The workhorse for agents and tests. */
  waitFor(pred, { timeout = 20000 } = {}) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error('waitFor timeout')) }, timeout)
      const off = this.onChange((s) => {
        if (!pred(s)) return
        clearTimeout(t); off(); resolve(s)
      })
    })
  }

  joinLink(base = 'https://ntrigue.nave.pub/') {
    return `${base}#g=${this.gid}&r=${this.relays.map(encodeURIComponent).join(',')}&h=${this.hostPub}`
  }

  // ---------------------------------------------------------------- moves

  /** Sit down at the table (lobby only). */
  sitDown(name) { return this.#send(`join:${this.pub}`, { type: 'join', name }) }

  /** Host: start the night. opts: {practice, flavor, bowl, shape}. */
  start(opts = {}) { return this.#send(`host:start:${now()}`, { type: 'start', ...opts }) }

  /** Write and lock this round's confession; delivery retries on its own. */
  lockSecret(text) {
    const s = this.state
    this.local.scopes[s.round] = {
      scopeId: bytesToHex(crypto.getRandomValues(new Uint8Array(8))),
      key: b64(newScopeKey()), text, prompt: s.promptId, published: false,
    }
    this.onLocal?.()
    return this.#deliverAnswer()
  }

  /** Drop a copy of this round's confession in the bowl. */
  bowl() { return this.#send(`bwl:${this.state.round}:${this.pub}`, { type: 'bowl', round: this.state.round }) }

  /** Deal window: flash the non-binding "I'll share". */
  promise() { return this.#send(`prm:${this.state.round}:${this.pub}`, { type: 'promise', round: this.state.round }) }

  /** Commit SHARE or HOLD; the reveal fires itself once both commits exist. */
  choose(choice) {
    const s = this.state
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    this.local.pending[s.round] = { choice, nonce }
    this.onLocal?.()
    return this.#send(`cmt:${s.round}:${this.pub}`,
      { type: 'commit', round: s.round, hash: commitHash(choice, nonce) })
  }

  /** Table read: guess the drawn confession's author. */
  whodunit(ownerPub) {
    return this.#send(`who:${this.state.round}:${this.pub}`,
      { type: 'whodunit', round: this.state.round, owner: ownerPub })
  }

  /** React to the current reveal beat (😱 😂 🐍 🔥). */
  react(emoji) { return this.#send(`rx:${now()}:${this.pub}`, { type: 'react', emoji }) }

  /** Finale: vault | {kind: 'burn'|'extort', owner, round}. */
  finaleMove(kind, target = {}) {
    const f = this.state.finale
    const mv = f.moves?.[this.pub] || 0
    const payload = { type: 'finale_choice', action: kind, ...target }
    if (kind === 'burn') payload.text = this.local.collected[`${target.owner}:${target.round}`] || ''
    return this.#send(`fin:${mv}:${this.pub}`, payload)
  }

  extortResponse(pay) {
    const f = this.state.finale
    return this.#send(`exr:${f.turn}:${f.moves?.[f.order[f.turn]] || 0}:${this.pub}`,
      { type: 'extort_response', turn: f.turn, pay })
  }

  blackmailDecision(reveal) {
    const f = this.state.finale
    const payload = { type: 'blackmail_decision', turn: f.turn, reveal }
    if (reveal) payload.text = this.local.collected[`${f.action.owner}:${f.action.round}`] || ''
    return this.#send(`bmd:${f.turn}:${f.moves?.[this.pub] || 0}:${this.pub}`, payload)
  }

  // host controls — all funnel through the reducer, same as the host bar
  advance() { return this.#send(`host:advance:${now()}`, { type: 'advance' }) }
  override() { return this.#send(`host:override:${now()}`, { type: 'override' }) }
  redraw() { return this.#send(`host:redraw:${now()}`, { type: 'redraw' }) }
  force() { return this.#send(`host:force:${now()}`, { type: 'force' }) }
  heatUp() { return this.#send(`host:heat_up:${now()}`, { type: 'heat_up' }) }
  order(pubs) { return this.#send('order', { type: 'order', order: pubs }) }

  /** My private stash: `${ownerPub}:${round}` -> text, as grants arrive. */
  get collected() { return this.local.collected }

  /** Generic escape hatch: any reducer action, with its idempotent id. */
  send(dSuffix, payload) { return this.#send(dSuffix, payload) }

  /** Host-side local apply, bypassing the wire — robot guests and the AI
   *  MC's quip upgrades drive through here. */
  applyLocal(act) { return this.#hostApply(act) }

  /** Re-pull my incoming grants now (e.g. a reveal card missing its text). */
  refreshCollected() { return this.#refreshCollected() }

  // ---------------------------------------------------------------- plumbing
  // Ported from app.mjs, minus the DOM: the host folds actions through the
  // pure reducer and republishes; players follow the latest state and pay
  // their debts (sealed copies, reveals, trade deliveries) with retries.

  async #send(dSuffix, payload) {
    if (this.isHost) await this.#hostApply({ ...payload, pub: this.pub })
    try { await sendAction(this.net, this.sk, this.gid, dSuffix, payload) }
    catch (e) { if (!this.isHost) throw e }
  }

  #applyStateEvent(event) {
    if (event.pubkey !== this.hostPub || event.created_at < this.seenStateTs) return
    let s
    try { s = JSON.parse(event.content) } catch { return }
    if (!s || s.v !== SCHEMA_VERSION || s.gid !== this.gid) return
    this.seenStateTs = event.created_at
    const prev = this.state
    this.state = s
    this.#onStateChanged(prev)
  }

  #onStateChanged(prev) {
    this.#deliverAnswer().catch(() => {})
    this.#autoEffects().catch(() => {})
    this.#notify(prev)
  }

  #notify(prev) {
    for (const fn of this.listeners) { try { fn(this.state, prev) } catch { /* listener's problem */ } }
  }

  async #hostCatchUp() {
    const events = await this.net.query({ kinds: [KIND_APP], '#t': [this.gid] }).catch(() => [])
    let changed = false
    for (const e of events.sort((a, b) => a.created_at - b.created_at)) {
      if (e.pubkey === this.pub) continue
      const act = parseAction(this.gid, e)
      if (!act) continue
      const next = reduce(this.state, act, this.content)
      if (next === this.state) continue
      this.#stampPhase(this.state, next)
      this.state = next
      changed = true
    }
    if (changed) { this.#onStateChanged(); await this.#publishState() }
  }

  #hostIngest(event) {
    if (event.pubkey === this.pub) return
    const act = parseAction(this.gid, event)
    if (act) this.#hostApply(act)
  }

  async #hostApply(act) {
    const prev = this.state
    const next = reduce(prev, act, this.content)
    if (next === prev) return
    this.#stampPhase(prev, next)
    this.state = next
    this.#onStateChanged(prev)
    await this.#publishState()
  }

  // phaseAt anchors every countdown, so it must be WALL time. net.mjs's
  // now() is strictly increasing per event (NIP-01 replacement needs it)
  // and drifts ahead of the clock under bursts — stamping card time with
  // it made the timers grow longer every round (first-playtest bug).
  #stampPhase(prev, next) {
    if (next.phase !== prev.phase || next.outcomeStep !== prev.outcomeStep ||
        next.finale?.turn !== prev.finale?.turn || next.finale?.step !== prev.finale?.step)
      next.phaseAt = Math.floor(Date.now() / 1000)
  }

  async #publishState() {
    this.local.lastState = this.state          // rejoin-proof: survives a host refresh
    this.onLocal?.()
    // an unconfirmed push flags `stalled` (the view shows it) and the tick
    // keeps re-sending — replacement, never duplication
    try {
      await sendAction(this.net, this.sk, this.gid, 'state', this.state, [codeTag(this.state.code)])
      if (this.stalled) { this.stalled = false; this.#notify() }
    } catch (e) {
      console.error('state push failed', e.detail || e.message)
      if (!this.stalled) { this.stalled = true; this.#notify() }
    }
  }

  async #deliverAnswer() {
    if (this.busy.deliver || !this.state) return
    this.busy.deliver = true
    try {
      for (const [round, scope] of Object.entries(this.local.scopes)) {
        if (scope.published) continue
        try {
          await publishScope(this.net, this.sk, {
            scopeId: scope.scopeId, generation: 1, scopeKey: unb64(scope.key),
            payload: { text: scope.text, round: Number(round), prompt: scope.prompt },
          })
          scope.published = true
          this.onLocal?.()
        } catch { /* retried by the tick */ }
      }
      const s = this.state
      const mine = s.phase === 'prompt' ? this.local.scopes[s.round] : null
      if (mine && mine.prompt === s.promptId && !s.answered[this.pub])
        await this.#send(`ans:${s.round}:${this.pub}`, { type: 'answered', round: s.round })
    } finally { this.busy.deliver = false }
  }

  async #autoEffects() {
    if (this.busy.effects || !this.state) return
    this.busy.effects = true
    try { await this.#autoEffectsInner(this.state) } finally { this.busy.effects = false }
  }

  async #autoEffectsInner(s) {
    const me = this.pub
    const pair = s.pairs?.find(p => p.includes(me))
    if (pair) {
      const other = pair[0] === me ? pair[1] : pair[0]
      if (this.local.pairsByRound[s.round] !== other) {
        this.local.pairsByRound[s.round] = other
        this.onLocal?.()
      }
    }

    // re-send an unconfirmed commit, then auto-reveal once both exist
    if (s.phase === 'dilemma') {
      const other = this.local.pairsByRound[s.round]
      const mine = this.local.pending[s.round]
      if (mine && !s.commits[me])
        await this.#send(`cmt:${s.round}:${me}`,
          { type: 'commit', round: s.round, hash: commitHash(mine.choice, mine.nonce) })
      if (mine && other && s.commits[me] && s.commits[other] && !s.choices[me])
        await this.#send(`rvl:${s.round}:${me}`,
          { type: 'reveal', round: s.round, choice: mine.choice, nonce: mine.nonce })
    }

    // drawn from the bowl: surface my confession to the room
    if (s.phase === 'table_read' && s.tableRead?.by === me && !s.tableRead.text) {
      const text = this.local.scopes[s.round]?.text
      if (text) await this.#send(`bwt:${s.round}:${me}`, { type: 'bowl_text', round: s.round, text })
    }

    // if I shared, deliver my secret to my counterpart — the trade itself.
    // The hand-over goes out the moment MY reveal is public, not when the
    // whole round resolves: a SHARE reaches the counterpart whatever they
    // chose (trade or betrayal), so there's nothing to wait for — and the
    // reader shouldn't sit on "Opening…" while we do (playtest feedback).
    for (const [round, pend] of Object.entries(this.local.pending)) {
      const r = Number(round)
      const done = (s.round === r && s.choices[me] === 'SHARE') ||
        s.round > r || (s.round === r &&
        ['outcome', 'table_read', 'debrief', 'scoreboard', 'finale_intro', 'finale', 'final'].includes(s.phase))
      const scope = this.local.scopes[r]
      const other = this.local.pairsByRound[r]
      if (pend.choice === 'SHARE' && done && scope && scope.published !== false &&
          other && !this.local.granted[r]) {
        await grant(this.net, this.sk, other, {
          scopeId: scope.scopeId, generation: 1, scopeKey: unb64(scope.key),
          scopeName: `r${r}`, relayHint: this.relays[0],
        })
        this.local.granted[r] = true
        this.onLocal?.()
      }
    }
  }

  async #refreshCollected() {
    if (this.busy.collect || !this.net) return
    this.busy.collect = true
    try {
      const grants = latestGrants(await receiveGrants(this.net, this.sk))
      let changed = false
      for (const g of grants) {
        const res = await fetchScope(this.net, g)
        if (res.status === 'ok' && res.data?.round !== undefined &&
            this.local.collected[`${g.publisher}:${res.data.round}`] !== res.data.text) {
          this.local.collected[`${g.publisher}:${res.data.round}`] = res.data.text
          changed = true
        }
      }
      if (changed) { this.onLocal?.(); this.#notify() }
    } finally { this.busy.collect = false }
  }

  async #tick() {
    this.tickN = (this.tickN || 0) + 1
    if (this.tickN % 4 === 0) {
      await this.#deliverAnswer().catch(() => {})
      await this.#autoEffects().catch(() => {})
      await this.#refreshCollected().catch(() => {})
    }
    const s = this.state
    if (!s) return
    // an unconfirmed state push keeps re-sending until a relay takes it
    if (this.isHost && this.stalled && this.tickN % 4 === 2) await this.#publishState()
    // pull what push should have brought — survives dead sockets after
    // sleep; three straight misses on an existing state means the pipes
    // are dead, so rebuild the whole pool
    if (this.tickN % 8 === 0) {
      const [remote] = await this.net.query({
        kinds: [KIND_APP], authors: [this.hostPub], '#d': [dState(this.gid)],
      }).catch(() => [])
      if (remote) {
        this.probeMisses = 0
        if (!this.isHost) this.#applyStateEvent(remote)
      } else if (s.phase !== 'lobby' && ++this.probeMisses >= 3) {
        this.probeMisses = 0
        await this.rebuildNet()
        return
      }
      if (this.isHost) await this.#hostCatchUp().catch(() => {})
    }
    // the deal window closes itself on the host
    if (this.isHost && s.phase === 'deal' &&
        Math.floor(Date.now() / 1000) - (s.phaseAt || 0) >= DEAL_SECS) {
      const key = `${s.round}:${s.phaseAt}`
      if (this.dealClosed !== key) { this.dealClosed = key; await this.advance() }
    }
    // stage watchdog: the TV heartbeats; if it goes quiet the host declares
    // it gone and every phone re-expands on the next state event
    if (this.isHost && s.stage && Math.floor(Date.now() / 1000) - (s.stageSeen || 0) > STAGE_STALE_SECS)
      await this.#send(`host:stage_gone:${now()}`, { type: 'stage_gone' })
  }
}

// ---------------------------------------------------------------- CLI

const cliRelay = (argv) => {
  const i = argv.indexOf('--relay')
  return i >= 0 ? [argv[i + 1]] : DEFAULT_RELAYS
}

async function cliHost(argv) {
  const e = await Engine.createTable({ relays: cliRelay(argv) })
  await e.connect()
  console.log(`table open — code ${e.state.code}`)
  console.log(`join:  ${e.joinLink()}`)
  console.log(`local: http://localhost:8899/index.html#g=${e.gid}&r=${e.relays.map(encodeURIComponent).join(',')}&h=${e.hostPub}`)
  // a patient host: advance whenever the card is done and everyone's moved
  e.onChange((s) => {
    process.stdout.write(`\r[${s.phase}] r${s.round} · ${s.players.length} seated   `)
  })
  setInterval(() => {
    const s = e.state
    if (!s) return
    if (s.phase === 'lobby' && s.players.length >= 3 && !e.started) {
      e.started = true
      e.start({ practice: false })
    }
    if (['pairing', 'outcome', 'table_read', 'debrief', 'scoreboard', 'finale_intro'].includes(s.phase))
      e.advance().catch(() => {})
    if (s.phase === 'finale' && s.finale.step === 'result') e.advance().catch(() => {})
    if (s.phase === 'final') { console.log('\nnight over'); process.exit(0) }
  }, 3000)
}

async function cliBot(argv) {
  const [ref, name = 'Robo'] = argv
  const e = /^[A-Za-z0-9]{4}$/.test(ref)
    ? await Engine.fromCode(ref.toUpperCase(), { relays: cliRelay(argv) })
    : Engine.fromLink(ref)
  await e.connect()
  await e.waitFor(s => s.phase === 'lobby')
  await e.sitDown(name)
  console.log(`${name} sat down at ${e.state.code}`)
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)]
  e.onChange(async (s) => {
    try {
      if (s.phase === 'prompt' && !s.answered[e.pub] && !e.local.scopes[s.round])
        await e.lockSecret(rand([
          'I practice my acceptance speech in the shower.',
          'I have never finished a single jigsaw puzzle.',
          'I wave at boats. Every boat.',
        ]))
      if (s.phase === 'dilemma' && s.pairs.flat().includes(e.pub) && !s.commits[e.pub])
        await e.choose(Math.random() < 0.7 ? 'SHARE' : 'HOLD')
      if (s.phase === 'table_read' && s.tableRead?.text && !s.tableRead.revealed &&
          s.tableRead.by !== e.pub && !s.tableRead.guesses[e.pub])
        await e.whodunit(rand(s.players.filter(p => p.pub !== e.pub)).pub)
      if (s.phase === 'finale') {
        const f = s.finale
        if (f.step === 'choose' && f.order[f.turn] === e.pub) {
          const held = unspentOf(s, e.pub)
          if (held.length && Math.random() < 0.6) {
            const t = rand(held)
            await e.finaleMove(Math.random() < 0.5 ? 'extort' : 'burn', { owner: t.owner, round: t.round })
          } else await e.finaleMove('vault')
        }
        if (f.step === 'extort' && f.action?.owner === e.pub) await e.extortResponse(Math.random() < 0.5)
        if (f.step === 'decide' && f.order[f.turn] === e.pub) await e.blackmailDecision(Math.random() < 0.6)
      }
      if (s.phase === 'final') { console.log(`\n${name} played it out.`); process.exit(0) }
    } catch { /* the tick retries */ }
  })
}

if (typeof process !== 'undefined' && process.argv) {   // Node only — browsers just import
  const [, self, cmd, ...rest] = process.argv
  if (import.meta.url === `file://${self}`) {
    if (cmd === 'host') cliHost(rest).catch((e) => { console.error(e.message); process.exit(1) })
    else if (cmd === 'bot') cliBot(rest).catch((e) => { console.error(e.message); process.exit(1) })
    else if (cmd) { console.error('usage: node engine.mjs host|bot …'); process.exit(1) }
  }
}
