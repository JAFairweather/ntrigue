// app.mjs — the Ntrigue client. One file, three jobs:
//   render:  paint the current phase from the latest game state
//   player:  answer prompts (as 30440 scopes), commit/reveal choices,
//            trade secrets (as 440 grants), play the finale
//   host:    fold action events through the reducer and re-publish state
//
// Everything a player sees comes from copy.mjs / deck.json / quips.json —
// keep it that way; test/banned-words.mjs scans those files.

import {
  generateSecretKey, getPublicKey, bytesToHex, hexToBytes, qrfactory,
} from './vendor/nostr-tools.js'
import { publishScope, grant, receiveGrants, latestGrants, fetchScope, newScopeKey } from './nipxx.mjs'
import { Net, KIND_APP, DEFAULT_RELAYS, dState, sendAction, parseAction, now, codeTag, findGameByCode } from './net.mjs'
import { initialState, reduce, commitHash, flavorRounds, SCHEMA_VERSION, STAGE_STALE_SECS } from './state.mjs'
import { UI, MC_UI, BOT, fill } from './copy.mjs'
import { mcEnabled, mcMode, mcSettings, saveMcSettings, siteConfig, generateDeck, liveQuip, closingRoast } from './mc.mjs'

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------------------------------------------------------------- context

const ctx = {
  gid: null, relays: DEFAULT_RELAYS, hostPub: null,
  sk: null, pub: null, name: null, isHost: false,
  net: null, content: null,
  state: null,
  local: null,          // persisted per-game client data (see defaults below)
  beats: {},            // drama-beat timers already fired, by card key
  sheet: false,         // scoring sheet open
  ui: {},               // transient view flags (card flip, join draft…)
  unsubs: [],
}

const localDefaults = () => ({
  sk: null, name: null, isHost: false, hostPub: null, relays: DEFAULT_RELAYS,
  scopes: {},           // round -> {scopeId, key, text}   (key base64)
  pending: {},          // round -> {choice, nonce}
  granted: {},          // round -> true (grant issued to counterpart)
  pairsByRound: {},     // round -> my counterpart pub
  collected: {},        // `${owner}:${round}` -> text     (my private stash)
  lastState: null,      // host only: last published state (rejoin-proof)
})

const lsKey = () => `ntg:${ctx.gid}`
const saveLocal = () => localStorage.setItem(lsKey(), JSON.stringify(ctx.local))
const loadLocal = () => {
  try { return { ...localDefaults(), ...JSON.parse(localStorage.getItem(lsKey()) || 'null') } }
  catch { return localDefaults() }
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
const unb64 = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0))

// ---------------------------------------------------------------- boot

async function loadContent() {
  const [deck, quips] = await Promise.all([
    fetch('./deck.json').then(r => r.json()),
    fetch('./quips.json').then(r => r.json()),
  ])
  ctx.content = { deck, quips }
}

function parseFragment() {
  const h = new URLSearchParams(location.hash.slice(1))
  if (!h.get('g')) return null
  return {
    gid: h.get('g'),
    relays: (h.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent),
    hostPub: h.get('h'),
  }
}

async function main() {
  await loadContent()
  document.body.addEventListener('click', onTap)
  const frag = parseFragment()
  if (!frag) return render()          // landing
  await enterGame(frag)
}

async function enterGame({ gid, relays, hostPub }) {
  ctx.gid = gid
  ctx.local = loadLocal()
  ctx.relays = relays?.length ? relays : (ctx.local.relays || DEFAULT_RELAYS)
  ctx.hostPub = hostPub || ctx.local.hostPub
  if (!ctx.local.sk) { ctx.local.sk = bytesToHex(generateSecretKey()); saveLocal() }
  ctx.sk = hexToBytes(ctx.local.sk)
  ctx.pub = getPublicKey(ctx.sk)
  ctx.name = ctx.local.name
  ctx.isHost = ctx.local.isHost || ctx.pub === ctx.hostPub
  if (ctx.isHost) {
    // restore a generated deck across refreshes — host-local only, per spec
    try {
      const gen = JSON.parse(localStorage.getItem(`ntg:${ctx.gid}:mcdeck`) || 'null')
      if (gen?.rounds) {
        ctx.content = { ...ctx.content, deck: { ...gen, practice: ctx.content.deck.practice } }
        ctx.ui.mcDeck = true
      }
    } catch { /* fall back to the static deck */ }
  }
  ctx.net = new Net(ctx.relays)
  render()                            // connecting / join screen immediately

  // latest state: remote wins, host's local copy as fallback
  const [remote] = await ctx.net.query({
    kinds: [KIND_APP], authors: [ctx.hostPub], '#d': [dState(ctx.gid)],
  }).catch(() => [])
  if (remote) applyStateEvent(remote)
  else if (ctx.isHost && ctx.local.lastState) ctx.state = ctx.local.lastState
  else if (ctx.isHost) ctx.state = initialState({ gid: ctx.gid, host: ctx.pub, relays: ctx.relays })
  if (ctx.isHost) await hostCatchUp()

  subscribeAll()
  if (ctx.isHost && !remote) { await publishState(); netSelfCheck() }
  refreshCollected()
  render()
  setInterval(tick, 1000)             // soft timers + retries + stage watchdog
  // returning to the foreground: sockets may be dead — fetch and flush now
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    pollNet().catch(console.error)
    deliverAnswer().catch(console.error)
    autoEffects().catch(console.error)
    refreshCollected()
  })
}

// ---------------------------------------------------------------- host driver

let seenStateTs = 0
function applyStateEvent(event) {
  if (event.pubkey !== ctx.hostPub || event.created_at < seenStateTs) return
  let s
  try { s = JSON.parse(event.content) } catch { return }
  if (!s || s.v !== SCHEMA_VERSION || s.gid !== ctx.gid) return
  seenStateTs = event.created_at
  ctx.state = s
  onStateChanged()
}

// The host applies its own actions locally at tap time, so both the catch-up
// query and the live feed skip host-authored events — replaying a non-
// idempotent 'advance' would double-step the game.
async function hostCatchUp() {
  const events = await ctx.net.query({ kinds: [KIND_APP], '#t': [ctx.gid] }).catch(() => [])
  let changed = false
  for (const e of events.sort((a, b) => a.created_at - b.created_at)) {
    if (e.pubkey === ctx.pub) continue
    const act = parseAction(ctx.gid, e)
    if (!act) continue
    const prev = ctx.state
    const next = reduce(prev, act, ctx.content)
    if (next === prev) continue
    if (next.phase !== prev.phase || next.outcomeStep !== prev.outcomeStep ||
        next.finale?.turn !== prev.finale?.turn || next.finale?.step !== prev.finale?.step)
      next.phaseAt = now()
    ctx.state = next
    changed = true
  }
  if (changed) await publishState()
  return changed
}

function hostIngest(event) {
  if (event.pubkey === ctx.pub) return
  const act = parseAction(ctx.gid, event)
  if (act) hostApply(act)
}

async function hostApply(act) {
  const prev = ctx.state
  const next = reduce(prev, act, ctx.content)
  if (next === prev) return
  if (next.phase !== prev.phase || next.outcomeStep !== prev.outcomeStep ||
      next.finale?.turn !== prev.finale?.turn || next.finale?.step !== prev.finale?.step)
    next.phaseAt = now()
  ctx.state = next
  onStateChanged()
  await publishState()
  maybeMc(prev, next)
}

// ---- AI MC hooks (host only): fire-and-forget upgrades of prewritten
// content. Every path already shipped a template; a generated line that
// arrives inside its budget replaces it via the reducer, otherwise nothing.
function maybeMc(prev, s) {
  if (!mcEnabled()) return
  const name = (pub) => s.players.find(p => p.pub === pub)?.name || '?'
  const upgrade = (eventKey, slots, applyAct) =>
    liveQuip(s, eventKey, slots).then(text => { if (text) hostApply({ ...applyAct, text, pub: ctx.pub }) })

  if (s.phase === 'outcome' && (prev.phase !== 'outcome' || prev.outcomeStep !== s.outcomeStep)) {
    const o = s.outcomes[s.outcomeStep]
    upgrade(o.kind, {
      a: name(o.a), b: name(o.b),
      winner: o.winner && name(o.winner), loser: o.loser && name(o.loser),
    }, { type: 'mc_quip', slot: 'outcome', step: s.outcomeStep })
  } else if (s.phase === 'pairing' && prev.phase !== 'pairing') {
    upgrade('pairing', { pairs: s.pairs.map(p => p.map(name)) },
      { type: 'mc_quip', slot: 'quip', phase: 'pairing' })
  } else if (s.phase === 'scoreboard' && prev.phase !== 'scoreboard') {
    upgrade('scoreboard', { round: s.round, styleChange: s.styleChange },
      { type: 'mc_quip', slot: 'quip', phase: 'scoreboard' })
  } else if (s.phase === 'finale' && (prev.phase !== 'finale' ||
             prev.finale?.turn !== s.finale.turn || prev.finale?.step !== s.finale.step)) {
    const f = s.finale
    const key = f.step === 'extort' ? 'extortion'
      : f.step === 'result' ? (f.action?.kind === 'vault' ? 'vault'
        : f.action?.kind === 'burn' ? 'burn'
        : f.action?.paid ? 'extortion_paid'
        : f.action?.revealed ? 'blackmail_reveal' : 'fold')
      : null
    if (key) upgrade(key, { actor: name(f.order[f.turn]), target: f.action?.owner && name(f.action.owner) },
      { type: 'mc_quip', slot: 'quip', phase: 'finale' })
  } else if (s.phase === 'final' && prev.phase !== 'final') {
    closingRoast(s).then(cards => { if (cards) hostApply({ type: 'mc_roast', cards, pub: ctx.pub }) })
  }
}

async function publishState() {
  ctx.local.lastState = ctx.state
  saveLocal()
  // dSuffix 'state' yields exactly dState(gid); parseAction ignores it, so
  // the host never re-ingests its own state as an action. The `c` tag makes
  // the game findable by its 4-letter room code (TV + code join).
  try {
    await sendAction(ctx.net, ctx.sk, ctx.gid, 'state', ctx.state, [codeTag(ctx.state.code)])
  } catch (e) { console.error('state push failed', e) }
}

// One-shot connection self-check after game creation: publish went through,
// but can it be read back? If not, friends' phones won't find the table.
async function netSelfCheck() {
  await new Promise(r => setTimeout(r, 2500))
  const [back] = await ctx.net.query({
    kinds: [KIND_APP], authors: [ctx.pub], '#d': [dState(ctx.gid)],
  }).catch(() => [])
  ctx.ui.netWarn = !back
  render()
}

// ---------------------------------------------------------------- actions

async function send(dSuffix, payload) {
  if (ctx.isHost) await hostApply({ ...payload, pub: ctx.pub })   // snappy local apply
  try { await sendAction(ctx.net, ctx.sk, ctx.gid, dSuffix, payload) }
  catch (e) { console.error('send failed', e) }
}

// ---------------------------------------------------------------- reactions

function onStateChanged() {
  autoEffects().catch(console.error)
  deliverAnswer().catch(console.error)
  botTick()
  render()
}

// Push my locked answers to the table. Two independent debts, both retried
// until confirmed: the sealed copy of each secret (any round — a refusal
// must never stall the night), and the done flag for the current prompt.
// Idempotent and re-entrant-safe — called from the tap, from every state
// change, on returning to the foreground, and from the retry timer.
let deliveringAnswer = false
async function deliverAnswer() {
  if (deliveringAnswer || !ctx.state) return
  deliveringAnswer = true
  try {
    for (const [round, scope] of Object.entries(ctx.local.scopes)) {
      if (scope.published) continue
      try {
        await publishScope(ctx.net, ctx.sk, {
          scopeId: scope.scopeId, generation: 1, scopeKey: unb64(scope.key),
          payload: { text: scope.text, round: Number(round), prompt: scope.prompt },
        })
        scope.published = true
        saveLocal()
      } catch (e) { console.error('sealed copy not accepted yet — will retry', e) }
    }
    const s = ctx.state
    const mine = s.phase === 'prompt' ? ctx.local.scopes[s.round] : null
    if (mine && mine.prompt === s.promptId && !s.answered[ctx.pub])
      await send(`ans:${s.round}:${ctx.pub}`, { type: 'answered', round: s.round })
  } finally { deliveringAnswer = false }
}

// All live subscriptions in one place, so a pool rebuild can re-arm them.
// The host is the source of truth — it never re-reads its own state events.
function subscribeAll() {
  if (!ctx.isHost) ctx.unsubs.push(ctx.net.subscribe(
    [{ kinds: [KIND_APP], authors: [ctx.hostPub], '#d': [dState(ctx.gid)] }],
    applyStateEvent))
  ctx.unsubs.push(ctx.net.subscribe(
    [{ kinds: [1059], '#p': [ctx.pub] }],
    () => refreshCollected()))
  if (ctx.isHost) ctx.unsubs.push(ctx.net.subscribe(
    [{ kinds: [KIND_APP], '#t': [ctx.gid] }],
    (e) => hostIngest(e)))
}

// Sleeping phones leave zombie connections: they look open, deliver nothing,
// and swallow everything sent. The state event is the liveness probe — it
// always exists once a game has started, so a few consecutive misses means
// the pipes are dead. Tear the whole pool down and rebuild it. No player
// should ever need to reload the page by hand.
let probeMisses = 0
async function rebuildNet() {
  for (const u of ctx.unsubs.splice(0)) { try { u() } catch { /* gone */ } }
  try { ctx.net.close() } catch { /* gone */ }
  ctx.net = new Net(ctx.relays)
  subscribeAll()
  if (ctx.isHost) { await hostCatchUp().catch(console.error); await publishState() }
  deliverAnswer().catch(console.error)
  autoEffects().catch(console.error)
  refreshCollected()
}

// Poll fallback: every few seconds, and on every return to the foreground,
// fetch what push should have brought — and rebuild the pool when even that
// goes quiet.
let polling = false
async function pollNet() {
  if (polling || !ctx.net || !ctx.gid) return
  polling = true
  try {
    const [remote] = await ctx.net.query({
      kinds: [KIND_APP], authors: [ctx.hostPub], '#d': [dState(ctx.gid)],
    }).catch(() => [])
    if (remote) {
      probeMisses = 0
      if (!ctx.isHost) applyStateEvent(remote)
    } else if (ctx.state && ctx.state.phase !== 'lobby' && ++probeMisses >= 3) {
      // the state event exists — three straight misses means dead pipes
      probeMisses = 0
      await rebuildNet()
      return
    }
    if (ctx.isHost) {
      if (await hostCatchUp()) onStateChanged()
    } else {
      refreshCollected()
    }
  } finally { polling = false }
}

let autoBusy = false
async function autoEffects() {
  const s = ctx.state
  if (autoBusy || !s) return
  autoBusy = true
  try { await autoEffectsInner(s) } finally { autoBusy = false }
}
async function autoEffectsInner(s) {
  const me = ctx.pub

  // remember my counterpart for each round (window closes when pairs rotate) —
  // round 0 (the warm-up) needs this too, its trades are the teaching moment
  if (s.pairs?.length) {
    const pair = s.pairs.find(p => p.includes(me))
    if (pair) {
      const other = pair[0] === me ? pair[1] : pair[0]
      if (ctx.local.pairsByRound[s.round] !== other) {
        ctx.local.pairsByRound[s.round] = other
        saveLocal()
      }
    }
  }

  // auto-reveal once both commitments in my pair exist
  if (s.phase === 'dilemma') {
    const other = ctx.local.pairsByRound[s.round]
    const mine = ctx.local.pending[s.round]
    if (mine && !s.commits[me]) await send(`cmt:${s.round}:${me}`,
      { type: 'commit', round: s.round, hash: commitHash(mine.choice, mine.nonce) })
    if (mine && other && s.commits[me] && s.commits[other] && !s.choices[me])
      await send(`rvl:${s.round}:${me}`,
        { type: 'reveal', round: s.round, choice: mine.choice, nonce: mine.nonce })
  }

  // if I shared, deliver my secret to my counterpart — the trade itself
  for (const [round, pend] of Object.entries(ctx.local.pending)) {
    const r = Number(round)
    const resolvedPast = s.round > r || (s.round === r && ['outcome', 'debrief', 'scoreboard', 'finale_intro', 'finale', 'final'].includes(s.phase))
    const scope = ctx.local.scopes[r]
    const other = ctx.local.pairsByRound[r]
    // wait for the sealed copy to be accepted before handing over its key —
    // a pointer to nothing would show the counterpart an endless "Opening…"
    if (pend.choice === 'SHARE' && resolvedPast && scope && scope.published !== false &&
        other && !ctx.local.granted[r]) {
      await grant(ctx.net, ctx.sk, other, {
        scopeId: scope.scopeId, generation: 1, scopeKey: unb64(scope.key),
        scopeName: `r${r}`, relayHint: ctx.relays[0],
      })
      ctx.local.granted[r] = true
      saveLocal()
    }
  }
}

let refreshing = false
async function refreshCollected() {
  if (refreshing || !ctx.net) return
  refreshing = true
  try {
    const grants = latestGrants(await receiveGrants(ctx.net, ctx.sk))
    let changed = false
    for (const g of grants) {
      const res = await fetchScope(ctx.net, g)
      if (res.status !== 'ok' || !res.data?.round) continue
      const key = `${g.publisher}:${res.data.round}`
      if (ctx.local.collected[key] !== res.data.text) {
        ctx.local.collected[key] = res.data.text
        changed = true
      }
    }
    if (changed) { saveLocal(); render() }
  } finally { refreshing = false }
}

// ---------------------------------------------------------------- robot guests
// Host-driven stand-in players, so one person can play a full night. Bots
// go through the SAME reducer as everyone else and their secrets travel the
// same way — sealed copies and handovers made with their own identities —
// so solo play exercises the real pipeline, including the moment a human
// reads a robot's secret.
const botFired = new Set()
const claim = (k) => { if (botFired.has(k)) return false; botFired.add(k); return true }
const unclaim = (k) => botFired.delete(k)
const botDelay = () => 800 + Math.random() * 1800
const botPubs = {}
const botPub = (bot) => botPubs[bot.sk] ??= getPublicKey(hexToBytes(bot.sk))

async function addBot() {
  const bots = ctx.local.bots = ctx.local.bots || []
  if ((ctx.state?.players.length || 0) >= 6 || bots.length >= BOT.names.length) return
  const used = new Set(bots.map(b => b.name))
  const base = BOT.names.find(n => !used.has(`${n} 🤖`))
  if (!base) return
  const bot = { sk: bytesToHex(generateSecretKey()), name: `${base} 🤖` }
  bots.push(bot)
  saveLocal()
  await hostApply({ type: 'join', pub: botPub(bot), name: bot.name })
}

function botTick() {
  if (!ctx.isHost || !ctx.state) return
  for (const bot of ctx.local.bots || []) botAct(bot).catch(console.error)
}

async function botAct(bot) {
  const s = ctx.state
  const pub = botPub(bot)
  if (!s.players.some(p => p.pub === pub)) return
  const store = ctx.local.botData = ctx.local.botData || {}
  const data = store[pub] = store[pub] || { scopes: {}, pending: {}, granted: {}, pairs: {}, stash: {} }
  const save = () => { store[pub] = data; saveLocal() }

  // answer the prompt: seal a canned line, then raise the done flag
  if (s.phase === 'prompt' && !s.answered[pub]) {
    const k = `ans:${s.round}:${s.promptId}:${pub}`
    if (claim(k)) setTimeout(async () => {
      try {
        const line = BOT.lines[Math.floor(Math.random() * BOT.lines.length)]
        const scopeId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
        const scopeKey = newScopeKey()
        data.scopes[s.round] = { scopeId, key: b64(scopeKey), text: line }
        save()
        await publishScope(ctx.net, hexToBytes(bot.sk), {
          scopeId, generation: 1, scopeKey,
          payload: { text: line, round: s.round, prompt: s.promptId },
        }).catch(() => {})       // a refused seal must not stall the bot
        await hostApply({ type: 'answered', round: ctx.state.round, pub })
      } catch (e) { unclaim(k); console.error('bot answer failed', e) }
    }, botDelay())
  }

  // choose in the dark: commit, then reveal once both commitments exist
  if (s.phase === 'dilemma' && s.pairs.flat().includes(pub)) {
    const pair = s.pairs.find(p => p.includes(pub))
    const other = pair[0] === pub ? pair[1] : pair[0]
    if (data.pairs[s.round] !== other) { data.pairs[s.round] = other; save() }
    if (!s.commits[pub]) {
      const k = `cmt:${s.round}:${pub}`
      if (claim(k)) setTimeout(async () => {
        try {
          const choice = Math.random() < 0.7 ? 'SHARE' : 'HOLD'
          const pending = { choice, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))) }
          data.pending[s.round] = pending
          save()
          await hostApply({ type: 'commit', round: s.round, hash: commitHash(choice, pending.nonce), pub })
        } catch (e) { unclaim(k); console.error('bot commit failed', e) }
      }, botDelay())
    }
    const mine = data.pending[s.round]
    if (mine && s.commits[pub] && s.commits[other] && !s.choices[pub] && claim(`rvl:${s.round}:${pub}`))
      await hostApply({ type: 'reveal', round: s.round, choice: mine.choice, nonce: mine.nonce, pub })
  }

  // after a round resolves: hand over the sealed copy if the bot shared
  for (const [r, pend] of Object.entries(data.pending)) {
    const rr = Number(r)
    const done = s.round > rr || (s.round === rr &&
      ['outcome', 'debrief', 'scoreboard', 'finale_intro', 'finale', 'final'].includes(s.phase))
    const scope = data.scopes[rr]
    const other = data.pairs[rr]
    if (pend.choice === 'SHARE' && done && scope && other && !data.granted[rr]) {
      const k = `gr:${rr}:${pub}`
      if (!claim(k)) continue
      try {
        await grant(ctx.net, hexToBytes(bot.sk), other, {
          scopeId: scope.scopeId, generation: 1, scopeKey: unb64(scope.key),
          scopeName: `r${rr}`, relayHint: ctx.relays[0],
        })
        data.granted[rr] = true
        save()
      } catch (e) { unclaim(k); console.error('bot handover failed', e) }
    }
  }

  // collect what was shared WITH the bot — it needs the words to blackmail
  const owed = (s.collected[pub] || []).filter(c => data.stash[`${c.owner}:${c.round}`] === undefined)
  if (owed.length) {
    const k = `stash:${pub}:${owed.map(c => `${c.owner.slice(0, 8)}:${c.round}`).join(',')}`
    if (claim(k)) {
      try {
        const grants = latestGrants(await receiveGrants(ctx.net, hexToBytes(bot.sk)))
        let got = false
        for (const g of grants) {
          const res = await fetchScope(ctx.net, g)
          if (res.status === 'ok' && res.data?.round !== undefined) {
            data.stash[`${g.publisher}:${res.data.round}`] = res.data.text
            got = true
          }
        }
        if (got) save()
        if (owed.some(c => data.stash[`${c.owner}:${c.round}`] === undefined)) unclaim(k)
      } catch { unclaim(k) }
    }
  }

  // the finale: one move, a spine, and no mercy
  if (s.phase === 'finale') {
    const f = s.finale
    const actor = f.order[f.turn]
    if (f.step === 'choose' && actor === pub) {
      const k = `fc:${f.turn}:${pub}`
      if (claim(k)) setTimeout(async () => {
        try {
          const held = ctx.state.collected[pub] || []
          const pickFrom = held.length ? held : null
          if (!pickFrom) return    // reducer auto-vaults empty-handed players
          const target = pickFrom[Math.floor(Math.random() * pickFrom.length)]
          const text = data.stash[`${target.owner}:${target.round}`]
          const roll = Math.random()
          if (roll < 0.45)
            await hostApply({ type: 'finale_choice', action: 'extort', owner: target.owner, round: target.round, pub })
          else if (roll < 0.7 && text)
            await hostApply({ type: 'finale_choice', action: 'burn', owner: target.owner, round: target.round, text, pub })
          else
            await hostApply({ type: 'finale_choice', action: 'vault', pub })
        } catch (e) { unclaim(k); console.error('bot finale failed', e) }
      }, botDelay())
    }
    if (f.step === 'extort' && f.action?.owner === pub) {
      const k = `xr:${f.turn}:${pub}`
      if (claim(k)) setTimeout(() => {
        hostApply({ type: 'extort_response', pay: Math.random() < 0.5, turn: f.turn, pub })
          .catch((e) => { unclaim(k); console.error('bot extort response failed', e) })
      }, botDelay())
    }
    if (f.step === 'decide' && actor === pub) {
      const k = `bd:${f.turn}:${pub}`
      if (claim(k)) setTimeout(() => {
        const text = data.stash[`${f.action.owner}:${f.action.round}`]
        hostApply({ type: 'blackmail_decision', reveal: !!text && Math.random() < 0.6, text: text || '', turn: f.turn, pub })
          .catch((e) => { unclaim(k); console.error('bot decision failed', e) })
      }, botDelay())
    }
  }
}

// ---------------------------------------------------------------- tap handling

async function onTap(ev) {
  const el = ev.target.closest('[data-act]')
  if (!el) return
  const act = el.dataset.act
  const s = ctx.state

  if (act === 'new-game') return createGame()
  if (act === 'sheet') { ctx.sheet = !ctx.sheet; return render() }
  if (act === 'copy-link') {
    await navigator.clipboard?.writeText(joinUrl()).catch(() => {})
    ctx.ui.copied = true; render()
    setTimeout(() => { ctx.ui.copied = false; render() }, 1500)
    return
  }
  if (act === 'join') {
    const name = $('#name-input')?.value?.trim().slice(0, 12)
    if (!name) return
    ctx.name = ctx.local.name = name
    ctx.ui.joined = true
    saveLocal()
    await send(`join:${ctx.pub}`, { type: 'join', name })
    return render()
  }
  if (act === 'seat-up' || act === 'seat-down') {
    const pub = el.dataset.pub
    const order = [...s.players].sort((a, b) => a.seat - b.seat).map(p => p.pub)
    const i = order.indexOf(pub)
    const j = act === 'seat-up' ? i - 1 : i + 1
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    return send('order', { type: 'order', order })
  }
  if (act === 'lock-secret') {
    // Store first, respond instantly, deliver in the background with retries.
    // The tap must never depend on the network — a slow or refusing relay
    // used to kill this handler silently and the button looked dead.
    const text = $('#secret-input')?.value?.trim()
    if (!text) return
    ctx.local.scopes[s.round] = {
      scopeId: bytesToHex(crypto.getRandomValues(new Uint8Array(8))),
      key: b64(newScopeKey()), text, prompt: s.promptId, published: false,
    }
    saveLocal()
    render()
    return deliverAnswer().catch(console.error)
  }
  if (act === 'choose') {
    const choice = el.dataset.choice
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
    ctx.local.pending[s.round] = { choice, nonce }
    saveLocal()
    await send(`cmt:${s.round}:${ctx.pub}`,
      { type: 'commit', round: s.round, hash: commitHash(choice, nonce) })
    return render()
  }
  if (act === 'flip') { ctx.ui.flipped = !ctx.ui.flipped; return render() }
  if (act === 'finale-pick') {
    ctx.ui.finaleSecret = el.dataset.k          // `${owner}:${round}`
    return render()
  }
  if (act === 'finale-move') {
    const kind = el.dataset.kind
    if (kind === 'vault') return send(`fin:${ctx.pub}`, { type: 'finale_choice', action: 'vault' })
    const k = ctx.ui.finaleSecret
    if (!k) return
    const [owner, round] = [k.slice(0, 64), Number(k.slice(65))]
    const payload = { type: 'finale_choice', action: kind, owner, round }
    if (kind === 'burn') payload.text = ctx.local.collected[k] || ''
    return send(`fin:${ctx.pub}`, payload)
  }
  if (act === 'extort-response')
    return send(`exr:${s.finale.turn}:${ctx.pub}`,
      { type: 'extort_response', turn: s.finale.turn, pay: el.dataset.pay === '1' })
  if (act === 'decide') {
    const reveal = el.dataset.reveal === '1'
    const a = s.finale.action
    const payload = { type: 'blackmail_decision', turn: s.finale.turn, reveal }
    if (reveal) payload.text = ctx.local.collected[`${a.owner}:${a.round}`] || ''
    return send(`bmd:${s.finale.turn}:${ctx.pub}`, payload)
  }
  if (act === 'again') { location.hash = ''; location.reload(); return }
  if (act === 'code-join') {
    const code = $('#code-input')?.value?.trim().toUpperCase()
    if (!code || code.length !== 4) return
    ctx.ui.codeSearching = true; render()
    const pre = new URLSearchParams(location.hash.slice(1))
    const override = (pre.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent)
    const net = new Net(override.length ? override : DEFAULT_RELAYS)
    const found = await findGameByCode(net, code).catch(() => null)
    net.close()
    if (!found) { ctx.ui.codeSearching = false; ctx.ui.codeMiss = true; return render() }
    location.hash = `g=${found.gid}&r=${found.relays.map(encodeURIComponent).join(',')}&h=${found.hostPub}`
    location.reload()
    return
  }
  if (act === 'host-sound')
    return send(`host:sound:${now()}`, { type: 'sound', on: !s.sound })
  if (act === 'mc-open') {
    ctx.ui.mcProxy = !!(await siteConfig())?.proxyUrl
    ctx.ui.mcModeDraft = mcSettings().mode || 'off'
    ctx.ui.mcOpen = true
    return render()
  }
  if (act === 'mc-close') { ctx.ui.mcOpen = false; return render() }
  if (act === 'mc-mode') { ctx.ui.mcModeDraft = el.dataset.v; return render() }
  if (act === 'mc-save') {
    saveMcSettings({
      mode: ctx.ui.mcModeDraft || 'off',
      apiKey: $('#mc-key')?.value?.trim() || '',
      groupContext: $('#mc-context')?.value?.trim() || '',
      spice: Number($('#mc-spice')?.value) || 2,
      avoid: $('#mc-avoid')?.value?.trim() || '',
    })
    ctx.ui.mcOpen = false
    return render()
  }
  if (act === 'mc-clear') {
    saveMcSettings({})
    ctx.ui.mcOpen = false
    return render()
  }
  if (act === 'start-night') {
    if (mcEnabled() && !ctx.ui.mcDeck) {
      ctx.ui.generating = true; render()
      const m = mcSettings()
      const deck = await generateDeck({
        groupContext: m.groupContext, spice: m.spice, avoid: m.avoid,
        playerNames: s.players.map(p => p.name),
      }, { rounds: flavorRounds(ctx.content, ctx.ui.flavor || 'mild') })
      ctx.ui.generating = false
      if (deck) {
        // generated decks carry rounds 1-4; the warm-up pool stays static
        ctx.content = { ...ctx.content, deck: { ...deck, practice: ctx.content.deck.practice } }
        ctx.ui.mcDeck = true
        // logged locally on the host phone for post-game review — never published
        localStorage.setItem(`ntg:${ctx.gid}:mcdeck`, JSON.stringify(deck))
      }
    }
    return send(`host:start:${now()}`, { type: 'start', practice: ctx.ui.practice !== false, flavor: ctx.ui.flavor || 'mild' })
  }
  if (act === 'practice-toggle') {
    ctx.ui.practice = ctx.ui.practice === false
    return render()
  }
  if (act === 'flavor') {
    ctx.ui.flavor = el.dataset.v
    return render()
  }
  if (act === 'bot-add') return addBot()

  // host controls — all funnel through the reducer
  if (act === 'host') return send(`host:${el.dataset.t}:${now()}`, { type: el.dataset.t })
}

async function createGame() {
  // #r=… on the landing page overrides the default tables — used by the
  // browser test (local ws:// room) and available to power users.
  const pre = new URLSearchParams(location.hash.slice(1))
  const relays = (pre.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent)
  const useRelays = relays.length ? relays : DEFAULT_RELAYS
  const gid = bytesToHex(crypto.getRandomValues(new Uint8Array(4)))
  const sk = generateSecretKey()
  const local = {
    ...localDefaults(),
    sk: bytesToHex(sk), isHost: true,
    hostPub: getPublicKey(sk), relays: useRelays,
  }
  localStorage.setItem(`ntg:${gid}`, JSON.stringify(local))
  location.hash = `g=${gid}&r=${useRelays.map(encodeURIComponent).join(',')}&h=${local.hostPub}`
  location.reload()
}

// ---------------------------------------------------------------- render

const joinUrl = () => location.origin + location.pathname +
  `#g=${ctx.gid}&r=${ctx.relays.map(encodeURIComponent).join(',')}&h=${ctx.hostPub}`

const nameOf = (pub) => ctx.state?.players.find(p => p.pub === pub)?.name || '?'
const seated = () => [...(ctx.state?.players || [])].sort((a, b) => a.seat - b.seat)
const myPair = () => ctx.state?.pairs.find(p => p.includes(ctx.pub))
const counterpart = () => { const p = myPair(); return p ? (p[0] === ctx.pub ? p[1] : p[0]) : null }
const amIn = () => ctx.state?.players.some(p => p.pub === ctx.pub)
const promptText = () => ctx.state.promptText || flavorRounds(ctx.content, ctx.state.flavor)
  .find(r => r.round === ctx.state.round)?.prompts.find(p => p.id === ctx.state.promptId)?.text || ''

// drama beat: cards keyed here render "…" for 1s the first time they appear.
// When a stage (TV) is present, the beat lives THERE, biggest possible —
// phones show content immediately and stay pure controllers.
function beat(key) {
  if (ctx.state?.stage) return true
  if (ctx.beats[key] === 'done') return true
  if (!ctx.beats[key]) {
    ctx.beats[key] = setTimeout(() => { ctx.beats[key] = 'done'; render() }, 1000)
  }
  return false
}

let tickN = 0
function tick() {
  tickN++
  // retry loop: anything owed to the table that hasn't been confirmed yet
  // (locked answer, commit, reveal, trade delivery) gets another attempt
  if (tickN % 4 === 0) {
    deliverAnswer().catch(console.error)
    autoEffects().catch(console.error)
    botTick()
  }
  // pull what push should have brought — survives dead sockets after sleep
  if (tickN % 8 === 0) pollNet().catch(console.error)
  const s = ctx.state
  if (!s) return
  if (s.phase === 'dilemma' || (s.phase === 'finale' && s.finale?.step === 'extort'))
    render()                            // countdown repaint
  // stage watchdog: the TV heartbeats; if it goes quiet the host declares it
  // gone and every phone re-expands on the next state event
  if (ctx.isHost && s.stage && Math.floor(Date.now() / 1000) - (s.stageSeen || 0) > STAGE_STALE_SECS)
    send(`host:stage_gone:${now()}`, { type: 'stage_gone' })
}

function timerLeft(total) {
  const left = total - (Math.floor(Date.now() / 1000) - (ctx.state.phaseAt || 0))
  return Math.max(0, left)
}

function render() {
  const app = $('#app')
  if (!app) return
  // A state straggle mid-typing must never eat someone's secret: snapshot
  // input values/focus before the innerHTML rebuild, restore after.
  const keep = {}
  for (const id of ['secret-input', 'name-input', 'code-input', 'mc-key', 'mc-context', 'mc-avoid', 'mc-spice']) {
    const el = document.getElementById(id)
    if (el) keep[id] = {
      value: el.value, focus: document.activeElement === el,
      ss: el.selectionStart, se: el.selectionEnd,
    }
  }
  const s = ctx.state
  let html
  if (!ctx.gid) html = vLanding()
  else if (!s) html = vCard(`<p class="mute">${esc(ctx.isHost ? UI.connecting : UI.connecting)}</p>`)
  else if (!amIn() && s.phase === 'lobby') html = vJoin()
  else if (!amIn()) html = vCard(`<p class="mute">${esc(UI.notFound)}</p>`)
  else html = ({
    lobby: vLobby, prompt: vPrompt, pairing: vPairing, dilemma: vDilemma,
    outcome: vOutcome, debrief: vDebrief, scoreboard: vScoreboard,
    finale_intro: vFinaleIntro, finale: vFinale, final: vFinal,
  }[s.phase] || (() => ''))()
  const stageChip = s?.stage && amIn()
    ? `<div class="stage-chip">${esc(fill(UI.tvCodeChip, { code: s.code }))}</div>` : ''
  app.innerHTML = html + stageChip + (ctx.gid && s ? vSheetButton() : '') +
    (ctx.sheet ? vSheet() : '') + (ctx.ui.mcOpen ? vMcModal() : '')
  for (const [id, k] of Object.entries(keep)) {
    const el = document.getElementById(id)
    if (!el) continue
    el.value = k.value
    if (k.focus) { el.focus(); try { el.setSelectionRange(k.ss, k.se) } catch { /* ok */ } }
  }
}

const vCard = (inner, cls = '') => `<div class="card ${cls}">${inner}</div>`
const btn = (label, act, data = '', cls = 'btn') =>
  `<button class="${cls}" data-act="${act}" ${data}>${esc(label)}</button>`

const vSheetButton = () => `<button class="sheet-btn" data-act="sheet">?</button>`
const vPayoff = () => [
  [UI.howtoBothShare, UI.howtoBothShareOut],
  [UI.howtoOneShares, UI.howtoOneSharesOut],
  [UI.howtoBothHold, UI.howtoBothHoldOut],
].map(([l, o]) => `<div class="payoff"><b>${esc(l)}</b><span class="small">${esc(o)}</span></div>`).join('') +
  `<p class="small payoff-choice">${esc(UI.howtoChoice)}</p>`
const vSteps = (...ts) => ts.map((t, i) => `<p class="small">${i + 1}. ${esc(t)}</p>`).join('')
const vSheet = () => `<div class="sheet"><div class="sheet-inner">
  <h3>${esc(UI.howtoTitle)}</h3>
  <p class="small">${esc(UI.howtoWhat)}</p>
  ${vSteps(UI.howtoStep1, UI.howtoStep2, UI.howtoStep3)}
  <p class="kicker">${esc(UI.howtoRoundHead)}</p>
  ${vPayoff()}
  <p class="kicker">${esc(UI.howtoFinaleHead)}</p>
  ${vSteps(UI.howtoFin1, UI.howtoFin2, UI.howtoFin3)}
  <p class="kicker">${esc(UI.howtoObjectiveHead)}</p>
  <p class="small">${esc(UI.howtoObjective)}</p>
  <p class="kicker">${esc(UI.howtoStrategyHead)}</p>
  <p class="small">· ${esc(UI.howtoTip1)}</p>
  <p class="small">· ${esc(UI.howtoTip2)}</p>
  <p class="small">· ${esc(UI.howtoTip3)}</p>
  <p class="small">· ${esc(UI.howtoTip4)}</p>
  <p class="small">· ${esc(UI.howtoTip5)}</p>
  ${btn(UI.close, 'sheet')}</div></div>`

function vLanding() {
  return vCard(`
    <h1 class="logo">${esc(UI.title)}</h1>
    <p class="tagline">${esc(UI.tagline)}</p>
    <p class="mute">${esc(UI.subtitle)}</p>
    <p class="mute small">${esc(UI.createWarning)}</p>
    ${btn(UI.newGame, 'new-game', '', 'btn hot big')}
    <p class="mute small">${esc(UI.codeJoinLabel)}</p>
    <div class="code-row">
      <input id="code-input" maxlength="4" placeholder="${esc(UI.codeJoinPlaceholder)}" autocapitalize="characters" autocomplete="off">
      ${btn(UI.codeJoinButton, 'code-join', '', 'btn ghost')}
    </div>
    ${ctx.ui.codeSearching ? `<p class="mute small">${esc(UI.codeJoinSearching)}</p>` : ''}
    ${ctx.ui.codeMiss ? `<p class="mute small">${esc(UI.codeJoinNotFound)}</p>` : ''}
    <p class="small"><a href="./about.html">${esc(UI.about)}</a></p>
  `, 'center')
}

function vJoin() {
  if (ctx.ui.joined) return vCard(`<p class="mute">${esc(UI.lobbyWaiting)}</p>`, 'center')
  return vCard(`
    <h1 class="logo">${esc(UI.title)}</h1>
    <h2>${esc(UI.joinTitle)}</h2>
    <input id="name-input" maxlength="12" placeholder="${esc(UI.joinNamePlaceholder)}" autocomplete="given-name">
    ${btn(UI.joinButton, 'join', '', 'btn hot big')}
  `, 'center')
}

function vLobby() {
  const s = ctx.state
  const rows = seated().map((p, i, arr) => `
    <li class="seat-row">
      <span class="seat-n">${p.seat}</span><span class="seat-name">${esc(p.name)}</span>
      ${ctx.isHost ? `
        <button class="mini" data-act="seat-up" data-pub="${p.pub}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="mini" data-act="seat-down" data-pub="${p.pub}" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button>` : ''}
    </li>`).join('')
  const qr = (() => {
    const q = qrfactory(0, 'M'); q.addData(joinUrl()); q.make()
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  })()
  const tvUrl = location.origin + location.pathname.replace(/index\.html$/, '') + 'tv/#' + s.code
  return vCard(`
    <h2>${esc(UI.lobbyTitle)}</h2>
    ${ctx.isHost ? `
      ${s.stage ? '' : `<div class="qr">${qr}</div>`}
      <p class="mute small">${esc(UI.lobbyShare)}</p>
      ${btn(ctx.ui.copied ? UI.lobbyCopied : UI.lobbyCopyLink, 'copy-link', '', 'btn ghost')}
      <p class="mute small">${esc(fill(UI.tvHint, { url: tvUrl, code: s.code }))}</p>
      ${s.stage ? btn(s.sound ? UI.soundOn : UI.soundOff, 'host-sound', '', 'btn ghost') : ''}
      ${ctx.ui.netWarn ? `<p class="small hot-text">${esc(UI.netCheckWarn)}</p>` : ''}
      <p class="mute small">${esc(UI.createWarning)}</p>` :
      `<p class="mute">${esc(fill(UI.joinWaitHost, { host: nameOf(ctx.hostPub) }))}</p>
      <p class="kicker">${esc(UI.briefTitle)}</p>
      <p class="small">${esc(UI.howtoWhat)}</p>
      ${vSteps(UI.howtoStep1, UI.howtoStep2, UI.howtoStep3)}
      ${vPayoff()}
      <p class="small">${esc(UI.howtoFin1)} ${esc(UI.howtoFin2)} ${esc(UI.howtoFin3)}</p>
      <p class="small mute">${esc(UI.briefMore)}</p>`}
    <p class="mute">${esc(fill(UI.lobbySeated, { n: String(s.players.length) }))}</p>
    ${ctx.isHost && s.players.length > 1 ? `<p class="small mute">${esc(UI.lobbySeatHint)}</p>` : ''}
    <ul class="seats">${rows || `<li class="mute">${esc(UI.lobbyWaiting)}</li>`}</ul>
    ${ctx.isHost && s.players.length < 6 ? `
      ${btn(UI.botAdd, 'bot-add', '', 'btn ghost')}
      <p class="mute small">${esc(UI.botHint)}</p>` : ''}
    ${ctx.isHost ? `
      ${btn(mcEnabled() ? UI.aiOn : UI.aiSetup, 'mc-open', '', 'btn ghost')}
      ${ctx.ui.generating ? `<p class="quip">${esc(UI.aiGenerating)}</p>` : ''}
      ${ctx.ui.mcDeck && !ctx.ui.generating ? `<p class="mute small">${esc(UI.aiDeckReady)}</p>` : ''}
      <p class="kicker">${esc(UI.flavorTitle)}</p>
      ${[['mild', UI.flavorMild, UI.flavorMildDesc], ['spicy', UI.flavorSpicy, UI.flavorSpicyDesc],
         ['scorching', UI.flavorScorching, UI.flavorScorchingDesc]].map(([v, label, desc]) => `
        <button class="stash ${(ctx.ui.flavor || 'mild') === v ? 'sel' : ''}" data-act="flavor" data-v="${v}">
          ${esc(label)}<span class="desc small mute"> — ${esc(desc)}</span>
        </button>`).join('')}
      ${btn(ctx.ui.practice !== false ? UI.practiceOn : UI.practiceOff, 'practice-toggle', '', 'btn ghost')}
      <p class="mute small">${esc(UI.practiceHint)}</p>
      ${s.players.length >= 3 && !ctx.ui.generating
        ? btn(UI.lobbyStart, 'start-night', '', 'btn hot big')
        : `<p class="mute small">${esc(UI.lobbyNeedPlayers)}</p>`}` : ''}
  `)
}

function vMcModal() {
  const m = mcSettings()
  const draft = ctx.ui.mcModeDraft || 'off'
  const opt = (v, label) => `<option value="${v}" ${(m.spice || 2) === v ? 'selected' : ''}>${esc(label)}</option>`
  const mode = (v, label, desc) => `
    <button class="stash ${draft === v ? 'sel' : ''}" data-act="mc-mode" data-v="${v}">
      ${esc(label)}${desc ? `<span class="desc small mute"> — ${esc(desc)}</span>` : ''}
    </button>`
  return `<div class="sheet"><div class="sheet-inner">
    <h3>${esc(MC_UI.title)}</h3>
    <p class="small mute">${esc(MC_UI.intro)}</p>
    ${mode('off', MC_UI.modeOff, MC_UI.modeOffDesc)}
    ${mode('community', MC_UI.modeCommunity, MC_UI.modeCommunityDesc)}
    ${ctx.ui.mcProxy ? mode('proxy', MC_UI.modeProxy, MC_UI.modeProxyDesc) : ''}
    ${mode('byok', MC_UI.modeByok, '')}
    ${draft === 'byok' ? `
      <label class="small">${esc(MC_UI.keyLabel)}</label>
      <input id="mc-key" type="password" value="${esc(m.apiKey || '')}" autocomplete="off">
      <p class="small mute">${esc(MC_UI.keyHint)}</p>` : ''}
    ${draft !== 'off' ? `
      <label class="small">${esc(MC_UI.contextLabel)}</label>
      <textarea id="mc-context" rows="2" placeholder="${esc(MC_UI.contextPlaceholder)}">${esc(m.groupContext || '')}</textarea>
      <label class="small">${esc(MC_UI.spiceLabel)}</label>
      <select id="mc-spice">${opt(1, MC_UI.spice1)}${opt(2, MC_UI.spice2)}${opt(3, MC_UI.spice3)}</select>
      <label class="small">${esc(MC_UI.avoidLabel)}</label>
      <textarea id="mc-avoid" rows="2" placeholder="${esc(MC_UI.avoidPlaceholder)}">${esc(m.avoid || '')}</textarea>` : ''}
    ${btn(MC_UI.save, 'mc-save', '', 'btn hot')}
    ${btn(MC_UI.clear, 'mc-clear', '', 'btn ghost')}
    ${btn(MC_UI.close, 'mc-close', '', 'btn ghost')}
  </div></div>`
}

function hostBar(...buttons) {
  if (!ctx.isHost) return ''
  return `<div class="hostbar">${buttons.join('')}</div>`
}

// round-0-safe header: the warm-up gets its own label, real rounds keep
// 'Round n · deck name'; coach lines appear only during the warm-up
const roundKicker = () => {
  const s = ctx.state
  if (s.round === 0) return esc(UI.practiceLabel)
  const name = flavorRounds(ctx.content, s.flavor).find(r => r.round === s.round)?.name
  return `${esc(fill(UI.roundLabel, { n: String(s.round) }))}${name ? ` · ${esc(name)}` : ''}`
}
const coach = (text) => ctx.state.round === 0 ? `<p class="coach">${esc(text)}</p>` : ''

function vPrompt() {
  const s = ctx.state
  const missing = seated().filter(p => !s.answered[p.pub]).map(p => p.name)
  const mine = ctx.local.scopes[s.round]
  const done = s.answered[ctx.pub] || (mine && mine.prompt === s.promptId)
  return vCard(`
    <p class="kicker">${roundKicker()}</p>
    <h2 class="prompt">${esc(promptText())}</h2>
    ${coach(UI.coachPrompt)}
    ${done ? `
      <p class="locked">🔒 ${esc(UI.promptLocked)}</p>
      ${s.answered[ctx.pub]
        ? `<p class="mute">${esc(fill(UI.waitingOn, { names: missing.join(', ') || '…' }))}</p>`
        : `<p class="mute small">${esc(UI.delivering)}</p>`}` : `
      <p class="mute small">${esc(UI.promptYours)}</p>
      <textarea id="secret-input" rows="3" placeholder="${esc(UI.promptPlaceholder)}"></textarea>
      ${btn(UI.promptLock, 'lock-secret', '', 'btn hot big')}
      <p class="mute small">${esc(UI.phonesDown)}</p>`}
  `) + hostBar(
    btn(UI.hostEveryoneIn, 'host', 'data-t="override"', 'btn ghost'),
    s.redrawsLeft ? btn(UI.hostRedraw, 'host', 'data-t="redraw"', 'btn ghost') : '')
}

function vPairing() {
  const s = ctx.state
  const cards = s.pairs.map(([a, b]) => {
    const mine = [a, b].includes(ctx.pub)
    return `<div class="matchup ${mine ? 'mine' : ''}">${esc(nameOf(a))} <span class="vs">⇄</span> ${esc(nameOf(b))}</div>`
  }).join('')
  const other = counterpart()
  const out = seated().filter(p => !s.pairs.flat().includes(p.pub))
  return vCard(`
    <p class="kicker">${roundKicker()} · ${esc(UI.pairingTitle)}</p>
    ${cards}
    ${other ? `<p class="locked">${esc(fill(UI.yourMatch, { name: nameOf(other) }))}</p>` : ''}
    ${out.map(p => `<p class="mute small">${esc(fill(UI.sittingOut, { name: p.name }))}</p>`).join('')}
    <p class="quip">${esc(s.quip)}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function vDilemma() {
  const s = ctx.state
  const other = counterpart()
  if (!other) return vCard(`<p class="mute">${esc(UI.dilemmaSit)}</p>`, 'center') +
    hostBar(btn(UI.hostForce, 'host', 'data-t="force"', 'btn ghost'))
  const left = timerLeft(15)
  const committed = s.commits[ctx.pub] || ctx.local.pending[s.round]
  return vCard(`
    <p class="kicker">${roundKicker()}</p>
    <h2>${esc(fill(UI.dilemmaVs, { name: nameOf(other) }))}</h2>
    <p class="mute">${esc(fill(UI.dilemmaStakes, { name: nameOf(other) }))}</p>
    ${coach(UI.coachDilemma)}
    ${committed ? `<p class="locked">🔒 ${esc(fill(UI.dilemmaLockedIn, { name: nameOf(other) }))}</p>` : `
      <div class="timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
      <div class="choices">
        <button class="btn choice share" data-act="choose" data-choice="SHARE">${esc(UI.dilemmaShare)}</button>
        <button class="btn choice hold" data-act="choose" data-choice="HOLD">${esc(UI.dilemmaHold)}</button>
      </div>
      <p class="mute small">${esc(UI.dilemmaCheat)}</p>`}
  `, 'center') + hostBar(btn(UI.hostForce, 'host', 'data-t="force"', 'btn ghost'))
}

function vOutcome() {
  const s = ctx.state
  const o = s.outcomes[s.outcomeStep]
  const key = `o:${s.round}:${s.outcomeStep}`
  if (!beat(key)) return vCard(`<div class="dots">…</div>`, 'center')
  const names = { a: nameOf(o.a), b: nameOf(o.b) }
  let headline, sub = ''
  if (o.kind === 'trade') headline = fill(UI.outcomeTrade, names)
  else if (o.kind === 'stalemate') headline = fill(UI.outcomeStalemate, names)
  else headline = fill(UI.outcomeBetrayal, { winner: nameOf(o.winner), loser: nameOf(o.loser) })

  // my private reading moment, if this outcome sent me a secret
  const iReceive = (o.kind === 'trade' && [o.a, o.b].includes(ctx.pub)) ||
                   (o.kind === 'betrayal' && o.winner === ctx.pub)
  const iGaveForNothing = o.kind === 'betrayal' && o.loser === ctx.pub
  if (iReceive) {
    const from = [o.a, o.b].find(p => p !== ctx.pub)
    const text = ctx.local.collected[`${from}:${s.round}`]
    sub = ctx.ui.flipped ? `
      <div class="eyes-only">
        <p class="kicker">${esc(UI.eyesOnly)}</p>
        <p class="secret-text">${esc(text ?? UI.fetchingSecret)}</p>
        <p class="mute small">${esc(UI.eyesOnlyHint)}</p>
        ${btn(UI.gotIt, 'flip', '', 'btn ghost')}
      </div>` :
      btn(fill(UI.readSecret, { name: nameOf(from) }), 'flip', '', 'btn hot')
    if (!text) refreshCollected()
  } else if (iGaveForNothing) sub = `<p class="mute">${esc(UI.nothingReceived)}</p>`
  return vCard(`
    <h2 class="${o.kind === 'betrayal' ? 'hot-text' : ''}">${esc(headline)}</h2>
    <p class="quip">${esc(o.quip)}</p>
    ${sub}
    ${coach(UI.coachOutcome)}
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function vDebrief() {
  return vCard(`
    <h2>${esc(UI.debriefTitle)}</h2>
    <p>${esc(UI.debriefBody)}</p>
    <p class="quip">${esc(UI.debriefReset)}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function scoreRows() {
  const s = ctx.state
  return [...seated()]
    .sort((a, b) => (s.scores[b.pub] || 0) - (s.scores[a.pub] || 0))
    .map(p => `<li class="score-row">
      <span class="seat-name">${esc(p.name)}${p.pub === ctx.pub ? ' ·' : ''}</span>
      <span class="dag">${'🗡'.repeat(s.daggers[p.pub] || 0)}</span>
      <span class="pts">${s.scores[p.pub] || 0}</span>
    </li>`).join('')
}

function vScoreboard() {
  const s = ctx.state
  return vCard(`
    <h2>${esc(fill(UI.scoreboardTitle, { n: String(s.round) }))}</h2>
    <ul class="scores">${scoreRows()}</ul>
    <p class="mute small">${esc(UI.daggerLegend)}</p>
    <p class="quip">${esc(s.quip)}</p>
  `) + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function vFinaleIntro() {
  return vCard(`
    <h1 class="logo hot-text">${esc(UI.finaleIntroTitle)}</h1>
    <p>${esc(UI.finaleIntroBody)}</p>
  `, 'center') + hostBar(btn(UI.finaleIntroStart, 'host', 'data-t="advance"', 'btn hot big'))
}

function vFinale() {
  const s = ctx.state
  const f = s.finale
  const actor = f.order[f.turn]
  const meActor = actor === ctx.pub

  if (f.step === 'choose') {
    if (!meActor) return vCard(`
      <p class="kicker">${esc(UI.finaleIntroTitle)}</p>
      <h2>${esc(fill(UI.finaleWatching, { name: nameOf(actor) }))}</h2>
      <p class="quip">${esc(s.quip)}</p>`, 'center')
    const mine = (s.collected[ctx.pub] || [])
    const items = mine.map(c => {
      const k = `${c.owner}:${c.round}`
      const sel = ctx.ui.finaleSecret === k
      return `<button class="stash ${sel ? 'sel' : ''}" data-act="finale-pick" data-k="${k}">
        ${esc(fill(UI.finaleSecretItem, { owner: nameOf(c.owner), n: String(c.round) }))}</button>`
    }).join('')
    const armed = !!ctx.ui.finaleSecret
    return vCard(`
      <h2>${esc(fill(UI.finaleYourMove, { name: ctx.name }))}</h2>
      <p class="mute small">${esc(UI.finaleHolding)}</p>
      <div class="stash-list">${items}</div>
      <div class="finale-moves">
        <button class="btn hot" data-act="finale-move" data-kind="extort" ${armed ? '' : 'disabled'}>
          ${esc(UI.finaleExtort)}<span class="desc">${esc(UI.finaleExtortDesc)}</span></button>
        <button class="btn" data-act="finale-move" data-kind="burn" ${armed ? '' : 'disabled'}>
          ${esc(UI.finaleBurn)}<span class="desc">${esc(UI.finaleBurnDesc)}</span></button>
        <button class="btn ghost" data-act="finale-move" data-kind="vault">
          ${esc(UI.finaleVault)}<span class="desc">${esc(UI.finaleVaultDesc)}</span></button>
      </div>`)
  }

  if (f.step === 'extort') {
    const target = f.action.owner
    if (target === ctx.pub) {
      const left = timerLeft(20)
      return vCard(`
        <h2 class="hot-text">${esc(fill(UI.extortTitle, { blackmailer: nameOf(actor) }))}</h2>
        <p>${esc(UI.extortDemand)}</p>
        <div class="timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
        <div class="choices">
          <button class="btn choice hold" data-act="extort-response" data-pay="1">${esc(UI.extortPay)}</button>
          <button class="btn choice share" data-act="extort-response" data-pay="0">${esc(UI.extortRefuse)}</button>
        </div>`, 'center')
    }
    return vCard(`
      <p class="quip">${esc(s.quip)}</p>
      <h2>${esc(fill(UI.extortTargetDeciding, { name: nameOf(target) }))}</h2>`, 'center')
  }

  if (f.step === 'decide') {
    if (meActor) return vCard(`
      <h2>${esc(fill(UI.decideTitle, { target: nameOf(f.action.owner) }))}</h2>
      <div class="finale-moves">
        <button class="btn hot" data-act="decide" data-reveal="1">
          ${esc(UI.decideReveal)}<span class="desc">${esc(UI.decideRevealDesc)}</span></button>
        <button class="btn ghost" data-act="decide" data-reveal="0">
          ${esc(UI.decideFold)}<span class="desc">${esc(UI.decideFoldDesc)}</span></button>
      </div>`)
    return vCard(`<h2>${esc(fill(UI.decideWaiting, { name: nameOf(actor) }))}</h2>`, 'center')
  }

  // result card — with the drama beat
  const key = `f:${f.turn}`
  if (!beat(key)) return vCard(`<div class="dots">…</div>`, 'center')
  const a = f.action
  let body = ''
  if (a.kind === 'vault' && a.auto) body = `<p>${esc(fill(UI.finaleAutoVault, { name: nameOf(actor) }))}</p>`
  else if (a.kind === 'burn' || a.revealed) {
    const x = s.exposed[s.exposed.length - 1]
    body = `<div class="exposed">
      <p class="kicker hot-text">${esc(fill(UI.exposedFrom, { owner: nameOf(x.owner), n: String(x.round) }))}</p>
      <p class="secret-text">${esc(x.text)}</p>
      <p class="mute small">${esc(UI.cantUntell)}</p></div>`
  }
  return vCard(`
    <p class="quip big-quip">${esc(s.quip)}</p>
    ${body}
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function vFinal() {
  const s = ctx.state
  return vCard(`
    <h1 class="logo">${esc(UI.finalTitle)}</h1>
    <ul class="scores">${scoreRows()}</ul>
    <div class="awards">
      <p><span class="kicker">${esc(UI.villainAward)}</span> ${esc(s.ending.villain)} ${'🗡'.repeat(s.ending.vd)}</p>
      <p><span class="kicker">${esc(UI.suckerAward)}</span> ${esc(s.ending.sucker)}</p>
    </div>
    ${s.roast ? `
      <p class="kicker">${esc(UI.roastTitle)}</p>
      ${s.roast.map(c => `<p class="quip">${esc(c)}</p>`).join('')}` :
      `<p class="quip">${esc(s.quip)}</p>`}
    ${btn(UI.playAgain, 'again', '', 'btn ghost')}
  `)
}

main().catch(console.error)
