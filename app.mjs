// app.mjs — the Ntrigue VIEW. Rendering, taps, and the robot guests live
// here; everything else — host duties, retries, trades, transport — is the
// shared headless engine (engine.mjs, issue #31), so phase logic exists in
// exactly one place and phones and headless seats behave identically.
//
// Everything a player sees comes from copy.mjs / deck.json / quips.json —
// keep it that way; test/banned-words.mjs scans those files.

import {
  generateSecretKey, getPublicKey, bytesToHex, hexToBytes, qrfactory,
} from './vendor/nostr-tools.js'
import { publishScope, grant, receiveGrants, latestGrants, fetchScope, newScopeKey } from './nipxx.mjs'
import { Net, KIND_APP, DEFAULT_RELAYS, dState, now, findGameByCode } from './net.mjs'
import { commitHash, flavorRounds, heatFor, multFor, unspentOf, PAYOFF, REACTIONS, reactionBeat, DEAL_SECS } from './state.mjs'
import { Engine } from './engine.mjs'
import { UI, MC_UI, BOT, fill, storyLine, AWARD_TITLES } from './copy.mjs'
import { mcEnabled, mcMode, mcSettings, saveMcSettings, siteConfig, generateDeck, liveQuip, closingRoast } from './mc.mjs'

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------------------------------------------------------------- context

const ctx = {
  engine: null,         // the seat at the table — all game I/O goes through it
  gid: null, relays: DEFAULT_RELAYS, hostPub: null,
  pub: null, name: null, isHost: false,
  content: null,
  beats: {},            // drama-beat timers already fired, by card key
  sheet: false,         // scoring sheet open
  ui: {},               // transient view flags (card flip, join draft…)
}
// the view reads game state and per-game client data straight off the engine
Object.defineProperty(ctx, 'state', { get: () => ctx.engine?.state ?? null })
Object.defineProperty(ctx, 'local', { get: () => ctx.engine?.local ?? {} })

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
const saveLocal = () => localStorage.setItem(lsKey(), JSON.stringify(ctx.engine.local))
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

// One-tap join: resolve a 4-letter code to the full game link and reload
// into it. Serves both the typed fallback and the short #join=CODE invite.
async function joinByCode(code) {
  ctx.ui.codeSearching = true; render()
  const pre = new URLSearchParams(location.hash.slice(1))
  const override = (pre.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent)
  const net = new Net(override.length ? override : DEFAULT_RELAYS)
  const found = await findGameByCode(net, code).catch(() => null)
  net.close()
  if (!found) { ctx.ui.codeSearching = false; ctx.ui.codeMiss = true; return render() }
  location.hash = `g=${found.gid}&r=${found.relays.map(encodeURIComponent).join(',')}&h=${found.hostPub}`
  location.reload()
}

async function main() {
  await loadContent()
  document.body.addEventListener('click', onTap)
  const frag = parseFragment()
  if (frag) return enterGame(frag)
  // a short invite (#join=CODE) finds the table on its own — the guest only
  // ever types their name; the typed code stays as the fallback
  const joinCode = new URLSearchParams(location.hash.slice(1)).get('join')
  if (joinCode && /^[A-Za-z0-9]{4}$/.test(joinCode)) return joinByCode(joinCode.toUpperCase())
  render()                            // landing
}

async function enterGame({ gid, relays, hostPub }) {
  ctx.gid = gid
  const local = loadLocal()
  ctx.relays = relays?.length ? relays : (local.relays || DEFAULT_RELAYS)
  ctx.hostPub = hostPub || local.hostPub
  if (!local.sk) local.sk = bytesToHex(generateSecretKey())
  const sk = hexToBytes(local.sk)
  ctx.pub = getPublicKey(sk)
  ctx.name = local.name
  ctx.isHost = local.isHost || ctx.pub === ctx.hostPub
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

  // the engine is the seat: host duties, retries, trades, transport. The
  // view hands it the persisted per-game data and saves on every mutation.
  ctx.engine = new Engine({
    gid, relays: ctx.relays, hostPub: ctx.hostPub, sk,
    content: ctx.content, local,
    onLocal: () => saveLocal(),
    restoreState: ctx.isHost ? local.lastState : null,
  })
  ctx.engine.isHost = ctx.isHost      // a restored host key may differ from #h
  saveLocal()
  render()                            // connecting / join screen immediately

  const fresh = ctx.isHost && !local.lastState
  await ctx.engine.connect()
  ctx.engine.onChange((s, prev) => {
    botTick()
    if (prev && ctx.isHost) maybeMc(prev, s)
    render()
  })
  if (fresh && ctx.state?.players.length === 0) netSelfCheck()
  ctx.engine.refreshCollected()
  render()
  setInterval(tick, 1000)             // countdown repaints + robot guests
  // returning to the foreground: the engine fetches and flushes everything owed
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    ctx.engine.wake().then(render)
  })
}

// ---------------------------------------------------------------- host-side hooks
// The engine owns the host driver; the view keeps only what needs the DOM
// (or the MC key). hostApply drives the reducer locally — robot guests and
// MC upgrades ride the same door the engine's own host duties use.

const hostApply = (act) => ctx.engine.applyLocal(act)

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

// One-shot connection self-check after game creation: publish went through,
// but can it be read back? If not, friends' phones won't find the table.
async function netSelfCheck() {
  await new Promise(r => setTimeout(r, 2500))
  const [back] = await ctx.engine.net.query({
    kinds: [KIND_APP], authors: [ctx.pub], '#d': [dState(ctx.gid)],
  }).catch(() => [])
  ctx.ui.netWarn = !back
  render()
}

// ---------------------------------------------------------------- actions
// Every tap funnels through the engine with the same idempotent action ids
// the headless seats use; retries, reveals, and trade deliveries are the
// engine's problem now.

const send = (dSuffix, payload) =>
  ctx.engine.send(dSuffix, payload).catch((e) => console.error('send failed', e))
const refreshCollected = () => ctx.engine.refreshCollected()

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
        await publishScope(ctx.engine.net, hexToBytes(bot.sk), {
          scopeId, generation: 1, scopeKey,
          payload: { text: line, round: s.round, prompt: s.promptId },
        }).catch(() => {})       // a refused seal must not stall the bot
        await hostApply({ type: 'answered', round: ctx.state.round, pub })
      } catch (e) { unclaim(k); console.error('bot answer failed', e) }
    }, botDelay())
  }

  // the bowl: bots have no shame — they drop their line in often enough
  // that solo nights see the table read
  if (s.phase === 'prompt' && s.bowlOn && s.round > 0 && s.answered[pub] && !s.bowl[pub]) {
    const k = `bwl:${s.round}:${pub}`
    if (claim(k)) setTimeout(() => {
      if (Math.random() < 0.5) hostApply({ type: 'bowl', round: ctx.state.round, pub })
        .catch((e) => { unclaim(k); console.error('bot bowl failed', e) })
    }, botDelay())
  }

  // drawn from the bowl: the bot surfaces its canned line, then everyone
  // else guesses a name at random (they are not clever, just brave)
  if (s.phase === 'table_read' && s.tableRead) {
    const tr = s.tableRead
    if (tr.by === pub && !tr.text && data.scopes[s.round]?.text && claim(`bwt:${s.round}:${pub}`))
      await hostApply({ type: 'bowl_text', round: s.round, text: data.scopes[s.round].text, pub })
    if (tr.text && !tr.revealed && tr.by !== pub && !tr.guesses[pub]) {
      const k = `who:${s.round}:${pub}`
      if (claim(k)) setTimeout(() => {
        const others = ctx.state.players.filter(p => p.pub !== pub)
        const owner = others[Math.floor(Math.random() * others.length)].pub
        hostApply({ type: 'whodunit', round: s.round, owner, pub })
          .catch((e) => { unclaim(k); console.error('bot guess failed', e) })
      }, botDelay())
    }
  }

  // the room's gasp: bots react to reveal beats so solo nights feel alive
  if (['outcome', 'table_read', 'finale'].includes(s.phase)) {
    const k = `rx:${reactionBeat(s)}:${pub}`
    if (claim(k)) setTimeout(() => {
      if (Math.random() < 0.5) hostApply({
        type: 'react', emoji: REACTIONS[Math.floor(Math.random() * REACTIONS.length)], pub,
      }).catch((e) => { unclaim(k); console.error('bot react failed', e) })
    }, botDelay())
  }

  // the deal window: bots sometimes flash the (non-binding) promise — and
  // being bots, they feel no obligation to keep it
  if (s.phase === 'deal' && s.pairs.flat().includes(pub) && !s.promises[pub]) {
    const k = `prm:${s.round}:${pub}`
    if (claim(k)) setTimeout(() => {
      if (Math.random() < 0.5) hostApply({ type: 'promise', round: ctx.state.round, pub })
        .catch((e) => { unclaim(k); console.error('bot promise failed', e) })
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
        await grant(ctx.engine.net, hexToBytes(bot.sk), other, {
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
        const grants = latestGrants(await receiveGrants(ctx.engine.net, hexToBytes(bot.sk)))
        let got = false
        for (const g of grants) {
          const res = await fetchScope(ctx.engine.net, g)
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

  // the finale: keep spending while cards remain, a spine, and no mercy.
  // Claim keys carry the actor's move count — the same turn number now
  // repeats across a multi-move hand.
  if (s.phase === 'finale') {
    const f = s.finale
    const actor = f.order[f.turn]
    const mv = f.moves?.[actor] || 0
    if (f.step === 'choose' && actor === pub) {
      const k = `fc:${f.turn}:${mv}:${pub}`
      if (claim(k)) setTimeout(async () => {
        try {
          const held = unspentOf(ctx.state, pub)
          if (!held.length) return   // reducer auto-vaults empty-handed players
          const target = held[Math.floor(Math.random() * held.length)]
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
      const k = `xr:${f.turn}:${mv}:${pub}`
      if (claim(k)) setTimeout(() => {
        hostApply({ type: 'extort_response', pay: Math.random() < 0.5, turn: f.turn, pub })
          .catch((e) => { unclaim(k); console.error('bot extort response failed', e) })
      }, botDelay())
    }
    if (f.step === 'decide' && actor === pub) {
      const k = `bd:${f.turn}:${mv}:${pub}`
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
  if (act === 'copy-invite') {
    await navigator.clipboard?.writeText(inviteUrl()).catch(() => {})
    ctx.ui.copiedShort = true; render()
    setTimeout(() => { ctx.ui.copiedShort = false; render() }, 1500)
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
    // The tap must never depend on the network: the engine stores first and
    // delivers in the background with retries.
    const text = $('#secret-input')?.value?.trim()
    if (!text) return
    ctx.engine.lockSecret(text).catch(console.error)
    return render()
  }
  if (act === 'react')
    return send(`rx:${now()}:${ctx.pub}`, { type: 'react', emoji: el.dataset.e })
  if (act === 'promise')
    return send(`prm:${s.round}:${ctx.pub}`, { type: 'promise', round: s.round })
  if (act === 'choose') {
    ctx.engine.choose(el.dataset.choice).catch(console.error)
    return render()
  }
  if (act === 'flip') { ctx.ui.flipped = !ctx.ui.flipped; return render() }
  if (act === 'finale-pick') {
    ctx.ui.finaleSecret = el.dataset.k          // `${owner}:${round}`
    return render()
  }
  // finale d-suffixes carry the actor's move count — turns repeat across a
  // multi-move hand, and each move must be its own idempotent action
  if (act === 'finale-move') {
    const mv = s.finale.moves?.[ctx.pub] || 0
    const kind = el.dataset.kind
    if (kind === 'vault') return send(`fin:${mv}:${ctx.pub}`, { type: 'finale_choice', action: 'vault' })
    const k = ctx.ui.finaleSecret
    if (!k) return
    ctx.ui.finaleSecret = null                     // a spent card can't stay armed
    const [owner, round] = [k.slice(0, 64), Number(k.slice(65))]
    const payload = { type: 'finale_choice', action: kind, owner, round }
    if (kind === 'burn') payload.text = ctx.local.collected[k] || ''
    return send(`fin:${mv}:${ctx.pub}`, payload)
  }
  if (act === 'extort-response')
    return send(`exr:${s.finale.turn}:${s.finale.moves?.[s.finale.order[s.finale.turn]] || 0}:${ctx.pub}`,
      { type: 'extort_response', turn: s.finale.turn, pay: el.dataset.pay === '1' })
  if (act === 'decide') {
    const mv = s.finale.moves?.[ctx.pub] || 0
    const reveal = el.dataset.reveal === '1'
    const a = s.finale.action
    const payload = { type: 'blackmail_decision', turn: s.finale.turn, reveal }
    if (reveal) payload.text = ctx.local.collected[`${a.owner}:${a.round}`] || ''
    return send(`bmd:${s.finale.turn}:${mv}:${ctx.pub}`, payload)
  }
  if (act === 'again') { location.hash = ''; location.reload(); return }
  if (act === 'code-join') {
    const code = $('#code-input')?.value?.trim().toUpperCase()
    if (!code || code.length !== 4) return
    return joinByCode(code)
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
    return send(`host:start:${now()}`, {
      type: 'start', practice: ctx.ui.practice !== false,
      flavor: ctx.ui.flavor || 'mild', bowl: ctx.ui.bowl !== false,
      shape: ctx.ui.shape || 'friends',
    })
  }
  if (act === 'practice-toggle') {
    ctx.ui.practice = ctx.ui.practice === false
    return render()
  }
  if (act === 'bowl-toggle') {
    ctx.ui.bowl = ctx.ui.bowl === false
    return render()
  }
  if (act === 'starter') {
    const input = $('#secret-input')
    if (input) { input.value = el.dataset.text; input.focus() }
    return
  }
  if (act === 'bowl')
    return send(`bwl:${s.round}:${ctx.pub}`, { type: 'bowl', round: s.round })
  if (act === 'whodunit')
    return send(`who:${s.round}:${ctx.pub}`, { type: 'whodunit', round: s.round, owner: el.dataset.pub })
  if (act === 'flavor') {
    ctx.ui.flavor = el.dataset.v
    return render()
  }
  if (act === 'shape') {
    ctx.ui.shape = el.dataset.v
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
// the chat-friendly version: just the room code (plus table settings when
// they aren't the defaults) — it resolves itself on open
const inviteUrl = () => {
  const custom = ctx.relays.join(',') !== DEFAULT_RELAYS.join(',')
  return location.origin + location.pathname + `#join=${ctx.state.code}` +
    (custom ? `&r=${ctx.relays.map(encodeURIComponent).join(',')}` : '')
}

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

// The engine's own tick handles retries, polling, the deal auto-close, the
// stall republish, and the stage watchdog. The view's tick is only what
// needs pixels: countdown repaints, the robot guests' cadence — and one
// impatience: while a reveal card of mine is waiting on its words, pull
// for them every other second instead of the engine's easy stroll.
const awaitingSecret = (s) => {
  const o = s.outcomes[s.outcomeStep]
  if (!o) return false
  const iReceive = (o.kind === 'trade' && [o.a, o.b].includes(ctx.pub)) ||
                   (o.kind === 'betrayal' && o.winner === ctx.pub)
  if (!iReceive) return false
  const from = [o.a, o.b].find(p => p !== ctx.pub)
  return !ctx.local.collected[`${from}:${s.round}`]
}

let tickN = 0
function tick() {
  tickN++
  if (tickN % 4 === 0) botTick()
  const s = ctx.state
  if (!s) return
  if (s.phase === 'outcome' && tickN % 2 === 0 && awaitingSecret(s)) refreshCollected()
  if (s.phase === 'deal' || s.phase === 'dilemma' || (s.phase === 'finale' && s.finale?.step === 'extort'))
    render()                            // countdown repaint
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
    lobby: vLobby, prompt: vPrompt, pairing: vPairing, deal: vDeal, dilemma: vDilemma,
    outcome: vOutcome, table_read: vTableRead, debrief: vDebrief, scoreboard: vScoreboard,
    finale_intro: vFinaleIntro, finale: vFinale, final: vFinal,
  }[s.phase] || (() => ''))()
  const stageChip = s?.stage && amIn()
    ? `<div class="stage-chip">${esc(fill(UI.tvCodeChip, { code: s.code }))}</div>` : ''
  const stallChip = ctx.engine?.stalled
    ? `<div class="stall-chip">${esc(UI.reconnecting)}</div>` : ''
  app.innerHTML = html + stageChip + stallChip + (ctx.gid && s ? vSheetButton() : '') +
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
  ${ctx.state?.groupShape === 'couples' ? `<p class="small">· ${esc(UI.howtoTip4)}</p>` : ''}
  <p class="small">· ${esc(UI.howtoTip5)}</p>
  <p class="small">· ${esc(UI.howtoTip6)}</p>
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
      ${btn(ctx.ui.copiedShort ? UI.lobbyCopied : UI.lobbyCopyInvite, 'copy-invite', '', 'btn ghost')}
      <p class="mute small">${esc(UI.lobbyInviteHint)}</p>
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
    ${ctx.isHost && s.players.length > 1 ? `<p class="small mute">${esc(
      (ctx.ui.shape || 'friends') === 'couples' ? UI.lobbySeatHint : UI.lobbySeatHintFriends)}</p>` : ''}
    <ul class="seats">${rows || `<li class="mute">${esc(UI.lobbyWaiting)}</li>`}</ul>
    ${ctx.isHost && s.players.length < 6 ? `
      ${btn(UI.botAdd, 'bot-add', '', 'btn ghost')}
      <p class="mute small">${esc(UI.botHint)}</p>` : ''}
    ${ctx.isHost ? `
      ${btn(mcEnabled() ? UI.aiOn : UI.aiSetup, 'mc-open', '', 'btn ghost')}
      ${ctx.ui.generating ? `<p class="quip">${esc(UI.aiGenerating)}</p>` : ''}
      ${ctx.ui.mcDeck && !ctx.ui.generating ? `<p class="mute small">${esc(UI.aiDeckReady)}</p>` : ''}
      <p class="kicker">${esc(UI.groupTitle)}</p>
      ${[['friends', UI.groupFriends, UI.groupFriendsDesc],
         ['couples', UI.groupCouples, UI.groupCouplesDesc]].map(([v, label, desc]) => `
        <button class="stash ${(ctx.ui.shape || 'friends') === v ? 'sel' : ''}" data-act="shape" data-v="${v}">
          ${esc(label)}<span class="desc small mute"> — ${esc(desc)}</span>
        </button>`).join('')}
      <p class="kicker">${esc(UI.flavorTitle)}</p>
      ${[['mild', UI.flavorMild, UI.flavorMildDesc], ['spicy', UI.flavorSpicy, UI.flavorSpicyDesc],
         ['scorching', UI.flavorScorching, UI.flavorScorchingDesc],
         ['arc', UI.flavorArc, UI.flavorArcDesc]].map(([v, label, desc]) => `
        <button class="stash ${(ctx.ui.flavor || 'mild') === v ? 'sel' : ''}" data-act="flavor" data-v="${v}">
          ${esc(label)}<span class="desc small mute"> — ${esc(desc)}</span>
        </button>`).join('')}
      ${btn(ctx.ui.practice !== false ? UI.practiceOn : UI.practiceOff, 'practice-toggle', '', 'btn ghost')}
      <p class="mute small">${esc(UI.practiceHint)}</p>
      ${btn(ctx.ui.bowl !== false ? UI.bowlOn : UI.bowlOff, 'bowl-toggle', '', 'btn ghost')}
      <p class="mute small">${esc(UI.bowlHint)}</p>
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
  const name = flavorRounds(ctx.content, heatFor(s.flavor, s.round, s.heatBump)).find(r => r.round === s.round)?.name
  return `${esc(fill(UI.roundLabel, { n: String(s.round) }))}${name ? ` · ${esc(name)}` : ''}`
}
const coach = (text) => ctx.state.round === 0 ? `<p class="coach">${esc(text)}</p>` : ''
// the stakes chip: rounds that pay more say so, loudly
const stakesChip = () => {
  const m = multFor(ctx.state.round)
  return m > 1 ? `<p class="kicker hot-text">${esc(m === 2 ? UI.stakesX2 : UI.stakesX3)}</p>` : ''
}
const cheatLine = () => {
  const m = multFor(ctx.state.round)
  return fill(UI.dilemmaCheat, { t: String(PAYOFF.trade * m), w: String(PAYOFF.betrayWin * m), l: String(PAYOFF.hold * m) })
}

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
      ${s.bowlOn && s.round > 0 ? (s.bowl[ctx.pub]
        ? `<p class="mute small">${esc(UI.bowlIn)}</p>`
        : btn(UI.bowlDrop, 'bowl', '', 'btn ghost')) : ''}
      ${s.answered[ctx.pub]
        ? `<p class="mute">${esc(fill(UI.waitingOn, { names: missing.join(', ') || '…' }))}</p>`
        : `<p class="mute small">${esc(UI.delivering)}</p>`}` : `
      <p class="mute small">${esc(UI.promptYours)}</p>
      <textarea id="secret-input" rows="3" placeholder="${esc(UI.promptPlaceholder)}"></textarea>
      ${btn(UI.promptLock, 'lock-secret', '', 'btn hot big')}
      ${vStarters()}
      <p class="mute small">${esc(UI.phonesDown)}</p>`}
  `) + hostBar(
    btn(UI.hostEveryoneIn, 'host', 'data-t="override"', 'btn ghost'),
    s.redrawsLeft ? btn(UI.hostRedraw, 'host', 'data-t="redraw"', 'btn ghost') : '')
}

// blank-box assist: a few tappable starters so no one stalls staring at an
// empty field — tap fills the box, then make it yours
function vStarters() {
  const s = ctx.state
  const pool = ctx.content.deck.starters?.[heatFor(s.flavor, s.round || 1, s.heatBump)]
  if (!pool?.length) return ''
  const off = (s.round * 3) % pool.length
  const picks = [0, 1, 2].map(i => pool[(off + i) % pool.length])
  return `
    <p class="mute small">${esc(UI.starterLabel)}</p>
    <div class="stash-list">${picks.map(t =>
      `<button class="stash small" data-act="starter" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>`
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
    ${stakesChip()}
    ${cards}
    ${other ? `<p class="locked">${esc(fill(UI.yourMatch, { name: nameOf(other) }))}</p>` : ''}
    ${out.map(p => `<p class="mute small">${esc(fill(UI.sittingOut, { name: p.name }))}</p>`).join('')}
    <p class="quip">${esc(s.quip)}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

// The deal: the pair is named, the room talks out loud, and the app just
// holds the window open and counts it down. The 🤝 is a public, non-binding
// promise — the outcome remembers whether it was kept.
function vDeal() {
  const s = ctx.state
  const other = counterpart()
  const left = timerLeft(DEAL_SECS)
  if (!other) return vCard(`<p class="mute">${esc(UI.dilemmaSit)}</p>`, 'center') +
    hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
  return vCard(`
    <p class="kicker">${roundKicker()}</p>
    ${stakesChip()}
    <h2>${esc(fill(UI.dealTitle, { name: nameOf(other) }))}</h2>
    <p class="mute">${esc(UI.dealHint)}</p>
    <div class="timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
    ${s.promises[ctx.pub]
      ? `<p class="locked">${esc(UI.dealPromised)}</p>`
      : btn(UI.dealPromise, 'promise', '', 'btn ghost')}
    ${s.promises[other] ? `<p class="quip">${esc(fill(UI.dealTheirPromise, { name: nameOf(other) }))}</p>` : ''}
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
    ${stakesChip()}
    <h2>${esc(fill(UI.dilemmaVs, { name: nameOf(other) }))}</h2>
    <p class="stakes">${esc(fill(UI.dilemmaStakes, { name: nameOf(other) }))}</p>
    ${s.promises[other] ? `<p class="quip">${esc(fill(UI.dealTheirPromise, { name: nameOf(other) }))}</p>` : ''}
    ${s.promises[ctx.pub] ? `<p class="mute small">${esc(UI.dealPromised)}</p>` : ''}
    ${coach(UI.coachDilemma)}
    ${committed ? `<p class="locked">🔒 ${esc(fill(UI.dilemmaLockedIn, { name: nameOf(other) }))}</p>` : `
      <div class="timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
      <div class="choices">
        <button class="btn choice share" data-act="choose" data-choice="SHARE">${esc(UI.dilemmaShare)}</button>
        <button class="btn choice hold" data-act="choose" data-choice="HOLD">${esc(UI.dilemmaHold)}</button>
      </div>
      <details class="cheat" ${s.round === 0 ? 'open' : ''}><summary class="mute small">${esc(UI.dilemmaMath)}</summary>
        <p class="mute small">${esc(cheatLine())}</p></details>`}
  `, 'center') + hostBar(btn(UI.hostForce, 'host', 'data-t="force"', 'btn ghost'))
}

// the reaction rail: one-tap emoji during a reveal beat; counts are the
// room's, keyed to this exact card
function vReactRail() {
  const s = ctx.state
  const counts = s.reactions?.key === reactionBeat(s) ? s.reactions.counts : {}
  return `<div class="react-rail">${REACTIONS.map(e =>
    `<button class="react" data-act="react" data-e="${e}">${e}${counts[e] ? `<span class="rc">${counts[e]}</span>` : ''}</button>`).join('')}</div>`
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
  const brokenWord = (o.broken || [])
    .map(p => `<p class="hot-text">${esc(fill(UI.promiseBroken, { name: nameOf(p) }))}</p>`).join('')
  return vCard(`
    <h2 class="${o.kind === 'betrayal' ? 'hot-text' : ''}">${esc(headline)}</h2>
    ${brokenWord}
    <p class="quip">${esc(o.quip)}</p>
    ${sub}
    ${coach(UI.coachOutcome)}
    ${vReactRail()}
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

// The table read: one bowled confession, read to the room, author hidden
// until every guess is in (or the host moves it along).
function vTableRead() {
  const s = ctx.state
  const tr = s.tableRead
  if (!tr.text) return vCard(`
    <p class="kicker">${esc(UI.bowlKicker)}</p>
    <div class="dots">…</div>
    <p class="mute">${esc(UI.bowlFishing)}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn ghost'))
  if (tr.revealed) return vCard(`
    <p class="kicker">${esc(UI.bowlKicker)}</p>
    <p class="secret-text">“${esc(tr.text)}”</p>
    <h2>${esc(fill(UI.bowlReveal, { name: nameOf(tr.by) }))}</h2>
    <p class="mute small">${esc(fill(UI.bowlPaid, { name: nameOf(tr.by) }))}</p>
    <p class="quip">${esc(s.quip)}</p>
    ${vReactRail()}
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
  const mineToGuess = tr.by !== ctx.pub && !tr.guesses[ctx.pub]
  const waiting = seated().filter(p => p.pub !== tr.by && !tr.guesses[p.pub]).map(p => p.name)
  return vCard(`
    <p class="kicker">${esc(UI.bowlKicker)}</p>
    <p class="secret-text">“${esc(tr.text)}”</p>
    <h2>${esc(UI.bowlWho)}</h2>
    ${tr.by === ctx.pub ? `<p class="quip">${esc(UI.bowlYours)}</p>` : ''}
    ${mineToGuess ? `<div class="stash-list">${seated().filter(p => p.pub !== ctx.pub).map(p =>
      `<button class="stash" data-act="whodunit" data-pub="${p.pub}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${!mineToGuess && tr.by !== ctx.pub ? `<p class="locked">${esc(UI.bowlGuessed)}</p>` : ''}
    <p class="mute small">${esc(fill(UI.waitingOn, { names: waiting.join(', ') || '…' }))}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn ghost'))
}

// "turn it up 🌶️": offered between rounds while there's still a hotter rung
// and rounds left to feel it
const heatUpBtn = () => {
  const s = ctx.state
  const can = s.round < 4 && s.heatBump < 2 &&
    (s.flavor === 'arc' || heatFor(s.flavor, s.round + 1, s.heatBump) !== 'scorching')
  return can ? btn(UI.heatUp, 'host', 'data-t="heat_up"', 'btn ghost') : ''
}

function vDebrief() {
  return vCard(`
    <h2>${esc(UI.debriefTitle)}</h2>
    <p>${esc(UI.debriefBody)}</p>
    <p class="quip">${esc(UI.debriefReset)}</p>
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'), heatUpBtn())
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
    ${s.callback ? `<p class="quip small">${esc(s.callback)}</p>` : ''}
  `) + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'), heatUpBtn())
}

function vFinaleIntro() {
  const s = ctx.state
  return vCard(`
    <h1 class="logo hot-text">${esc(UI.finaleIntroTitle)}</h1>
    <p>${esc(UI.finaleIntroBody)}</p>
    ${s.callback ? `<p class="quip">${esc(s.callback)}</p>` : ''}
  `, 'center') + hostBar(btn(UI.finaleIntroStart, 'host', 'data-t="advance"', 'btn hot big'))
}

function vFinale() {
  const s = ctx.state
  const f = s.finale
  const actor = f.order[f.turn]
  const meActor = actor === ctx.pub

  if (f.step === 'choose') {
    const again = (f.moves?.[actor] || 0) > 0
    if (!meActor) return vCard(`
      <p class="kicker">${esc(UI.finaleIntroTitle)}</p>
      <h2>${esc(fill(again ? UI.finaleAgain : UI.finaleWatching, { name: nameOf(actor) }))}</h2>
      <p class="mute small">${esc(fill(UI.finaleHolds, { name: nameOf(actor), n: String(unspentOf(s, actor).length) }))}</p>
      <p class="quip">${esc(s.quip)}</p>`, 'center')
    const mine = unspentOf(s, ctx.pub)
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

  // result card — with the drama beat (keyed per move: turns repeat now)
  const key = `f:${f.turn}:${f.moves?.[actor] || 0}`
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
    ${vReactRail()}
  `, 'center') + hostBar(btn(UI.hostNext, 'host', 'data-t="advance"', 'btn hot'))
}

function vFinal() {
  const s = ctx.state
  const titles = AWARD_TITLES
  return vCard(`
    <h1 class="logo">${esc(UI.finalTitle)}</h1>
    <ul class="scores">${scoreRows()}</ul>
    <div class="awards">
      <p><span class="kicker">${esc(UI.villainAward)}</span> ${esc(s.ending.villain)} ${'🗡'.repeat(s.ending.vd)}</p>
      <p><span class="kicker">${esc(UI.suckerAward)}</span> ${esc(s.ending.sucker)}</p>
    </div>
    ${(s.ending.awards || []).length ? `
      <p class="kicker">${esc(UI.awardsTitle)}</p>
      ${s.ending.awards.map(a => `<p class="small"><b>${esc(a.name)}</b> · ${esc(titles[a.k] || a.k)}</p>`).join('')}` : ''}
    ${(s.story || []).length ? `
      <p class="kicker">${esc(UI.recapTitle)}</p>
      ${s.story.map(e => `<p class="small mute">${esc(storyLine(e))}</p>`).join('')}` : ''}
    ${s.roast ? `
      <p class="kicker">${esc(UI.roastTitle)}</p>
      ${s.roast.map(c => `<p class="quip">${esc(c)}</p>`).join('')}` :
      `<p class="quip">${esc(s.quip)}</p>`}
    ${btn(UI.playAgain, 'again', '', 'btn ghost')}
  `)
}

main().catch(console.error)
