// tv.mjs — the Stage: the same web app in a display role. Joins a room by
// its 4-letter code, read-only, with its own throwaway identity. Privacy by
// construction: this client holds no secret-reading capability at all — it
// can only render public game state, so it CANNOT show a secret that hasn't
// been deliberately made public (asserted in test/sim.mjs).

import { generateSecretKey, getPublicKey, bytesToHex, hexToBytes, qrfactory } from '../vendor/nostr-tools.js'
import { Net, KIND_APP, DEFAULT_RELAYS, dState, sendAction, findGameByCode } from '../net.mjs'
import { SCHEMA_VERSION, STAGE_PING_SECS } from '../state.mjs'
import { UI, fill } from '../copy.mjs'

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const ctx = {
  sk: null, pub: null, net: null,
  gid: null, hostPub: null, relays: [],
  state: null, deck: null,
  beats: {}, ui: {}, played: {},
}

// ---------------------------------------------------------------- boot

const LS = 'ntg:tv'
async function main() {
  ctx.deck = await fetch('../deck.json').then(r => r.json())
  document.body.addEventListener('click', onTap)
  document.body.addEventListener('keydown', (e) => { if (e.key === 'Enter') onTap({ target: $('#tv-go') }) })
  // a code in the address (…/tv/#ABCD) always wins over whatever this screen
  // remembers — so pointing the TV at a new table is just opening its link
  const urlCode = codeFromHash()
  if (urlCode) return findAndConnect(urlCode)
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || 'null') } catch { return null } })()
  if (saved?.gid) return connect(saved, true)
  render()
}

function codeFromHash() {
  const first = location.hash.slice(1).split('&')[0]
  return /^[A-Za-z0-9]{4}$/.test(first) && !first.includes('=') ? first.toUpperCase() : null
}

async function findAndConnect(code) {
  ctx.ui.searching = true; ctx.ui.miss = false; render()
  // honor a #r=… override, same as the phone landing page
  const pre = new URLSearchParams(location.hash.slice(1))
  const override = (pre.get('r') || '').split(',').filter(Boolean).map(decodeURIComponent)
  const probe = new Net(override.length ? override : DEFAULT_RELAYS)
  const found = await findGameByCode(probe, code).catch(() => null)
  probe.close()
  ctx.ui.searching = false
  if (!found) { ctx.ui.miss = true; return render() }
  const conn = { ...found, sk: bytesToHex(generateSecretKey()) }
  localStorage.setItem(LS, JSON.stringify(conn))
  connect(conn)
}

function leave() {
  localStorage.removeItem(LS)
  // drop any #CODE from the address (the reload would just rejoin it),
  // but keep a #r=… override intact
  const r = location.hash.match(/(?:^#|&)(r=[^&]*)/)
  history.replaceState(null, '', location.pathname + location.search + (r ? '#' + r[1] : ''))
  location.reload()
}

async function onTap(ev) {
  const el = ev.target?.closest?.('[data-act]')
  if (!el) return
  if (el.dataset.act === 'go') {
    const code = $('#tv-code')?.value?.trim().toUpperCase()
    if (!code || code.length !== 4) return
    findAndConnect(code)
  }
  if (el.dataset.act === 'leave') leave()
}

async function connect({ gid, hostPub, relays, sk }, resumed = false) {
  ctx.gid = gid
  ctx.hostPub = hostPub
  ctx.relays = relays?.length ? relays : DEFAULT_RELAYS
  ctx.sk = hexToBytes(sk)
  ctx.pub = getPublicKey(ctx.sk)
  ctx.net = new Net(ctx.relays)
  ctx.ui.connected = true
  render()

  const [remote] = await ctx.net.query({
    kinds: [KIND_APP], authors: [hostPub], '#d': [dState(gid)],
  }).catch(() => [])
  if (resumed) {
    // don't cling to a night that's over: if the remembered table is gone,
    // finished, or hours cold, forget it and offer the code screen instead
    let phase = null
    try { phase = JSON.parse(remote?.content || 'null')?.phase } catch { /* stale */ }
    const ageHrs = remote ? (Date.now() / 1000 - remote.created_at) / 3600 : Infinity
    if (!remote || phase === 'final' || ageHrs > 12) return leave()
  }
  if (remote) applyState(remote)
  ctx.net.subscribe([{ kinds: [KIND_APP], authors: [hostPub], '#d': [dState(gid)] }], applyState)

  // announce + heartbeat, so phones adapt and the host can detect a yank
  const hello = () => sendAction(ctx.net, ctx.sk, gid, `stg:${ctx.pub}`,
    { type: ctx.announced ? 'stage_ping' : 'stage_join' }).then(() => { ctx.announced = true }).catch(() => {})
  hello()
  setInterval(hello, STAGE_PING_SECS * 1000)
  setInterval(() => {
    const s = ctx.state
    if (s && (s.phase === 'lobby' || s.phase === 'dilemma' ||
        (s.phase === 'finale' && s.finale?.step === 'extort'))) render()
  }, 1000)
}

let seenTs = 0
function applyState(event) {
  if (event.pubkey !== ctx.hostPub || event.created_at < seenTs) return
  let s
  try { s = JSON.parse(event.content) } catch { return }
  if (!s || s.v !== SCHEMA_VERSION || s.gid !== ctx.gid) return
  seenTs = event.created_at
  const prev = ctx.state
  ctx.state = s
  stingers(prev, s)
  render()
}

// ---------------------------------------------------------------- sound
// Short synthesized stingers (stage-only, host-toggled, off by default).
// WebAudio keeps the app asset-free; phones stay silent always.

let audio
const tone = (freq, dur, type = 'sine', gain = 0.12, when = 0) => {
  audio = audio || new (window.AudioContext || window.webkitAudioContext)()
  const o = audio.createOscillator(), g = audio.createGain()
  o.type = type; o.frequency.value = freq
  g.gain.setValueAtTime(gain, audio.currentTime + when)
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + when + dur)
  o.connect(g).connect(audio.destination)
  o.start(audio.currentTime + when); o.stop(audio.currentTime + when + dur)
}
const STING = {
  betrayal: () => { tone(220, .5, 'sawtooth', .1); tone(233, .5, 'sawtooth', .1); tone(110, .8, 'triangle', .12, .1) },
  trust: () => { tone(523, .3, 'sine', .1); tone(659, .4, 'sine', .1, .12); tone(784, .6, 'sine', .1, .24) },
  tension: () => { tone(98, 1.6, 'triangle', .1); tone(103, 1.6, 'triangle', .08) },
  reveal: () => { tone(880, .12, 'square', .08); tone(440, .5, 'sawtooth', .1, .1); tone(220, .9, 'triangle', .12, .2) },
}
function play(key, kind) {
  if (!ctx.state?.sound || ctx.played[key]) return
  ctx.played[key] = true
  try { STING[kind]() } catch { /* no audio permitted yet */ }
}
function stingers(prev, s) {
  if (!prev) return
  if (s.phase === 'outcome') {
    const o = s.outcomes[s.outcomeStep]
    play(`o:${s.round}:${s.outcomeStep}`, o.kind === 'betrayal' ? 'betrayal' : o.kind === 'trade' ? 'trust' : 'tension')
  }
  if (s.phase === 'finale' && s.finale?.step === 'extort') play(`x:${s.finale.turn}`, 'tension')
  if ((s.exposed?.length || 0) > (prev.exposed?.length || 0)) play(`r:${s.exposed.length}`, 'reveal')
}

// ---------------------------------------------------------------- render

const nameOf = (pub) => ctx.state?.players.find(p => p.pub === pub)?.name || '?'
const seated = () => [...(ctx.state?.players || [])].sort((a, b) => a.seat - b.seat)
const promptText = () => ctx.state.promptText || ctx.deck.rounds
  .find(r => r.round === ctx.state.round)?.prompts.find(p => p.id === ctx.state.promptId)?.text || ''
const timerLeft = (total) => Math.max(0, total - (Math.floor(Date.now() / 1000) - (ctx.state.phaseAt || 0)))

function beat(key, ms = 1500) {
  if (ctx.beats[key] === 'done') return true
  if (!ctx.beats[key]) ctx.beats[key] = setTimeout(() => { ctx.beats[key] = 'done'; render() }, ms)
  return false
}

const card = (inner) => `<div class="tv-card">${inner}</div>`

function render() {
  const stage = $('#stage')
  if (!stage) return
  const s = ctx.state
  let html
  if (!ctx.gid) html = vEnter()
  else if (!s) html = card(`<h1 class="tv-logo">${esc(UI.title)}</h1><p class="tv-mute">${esc(UI.tvConnected)}</p>`)
  else html = ({
    lobby: vLobby, prompt: vPrompt, pairing: vPairing, dilemma: vDilemma,
    outcome: vOutcome, scoreboard: vScoreboard, finale_intro: vFinaleIntro,
    finale: vFinale, final: vFinal,
  }[s.phase] || (() => ''))()
  // always a way off a table — quiet corner button on every connected screen
  const off = ctx.gid ? `<button class="tv-btn tv-leave" data-act="leave">↩ ${esc(UI.tvNewTable)}</button>` : ''
  stage.innerHTML = html + off
}

function vEnter() {
  return card(`
    <h1 class="tv-logo">${esc(UI.title)}</h1>
    <p class="tv-kicker">${esc(UI.tvEnterTitle)}</p>
    <p class="tv-mute">${esc(UI.tvEnterSub)}</p>
    <input id="tv-code" class="tv-input" maxlength="4" placeholder="${esc(UI.codeJoinPlaceholder)}" autofocus>
    <button id="tv-go" class="tv-btn" data-act="go">${esc(UI.codeJoinButton)}</button>
    ${ctx.ui.searching ? `<p class="tv-mute">${esc(UI.codeJoinSearching)}</p>` : ''}
    ${ctx.ui.miss ? `<p class="tv-mute">${esc(UI.codeJoinNotFound)}</p>` : ''}
  `)
}

function joinUrl() {
  const base = location.origin + location.pathname.replace(/tv\/(index\.html)?$/, '')
  return base + `#g=${ctx.gid}&r=${ctx.relays.map(encodeURIComponent).join(',')}&h=${ctx.hostPub}`
}

function vLobby() {
  const s = ctx.state
  // rotate join info with how-to-play cards while the table fills; the
  // roster and room code stay pinned so late arrivals always see them
  const panels = [
    () => {
      const q = qrfactory(0, 'M'); q.addData(joinUrl()); q.make()
      return `
        <h1 class="tv-logo">${esc(UI.title)}</h1>
        <div class="tv-qr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <p class="tv-mute">${esc(UI.lobbyShare)}</p>`
    },
    () => `
      <p class="tv-kicker">${esc(UI.howtoTitle)}</p>
      <p class="tv-body">${esc(UI.howtoWhat)}</p>
      <p class="tv-quip">${esc(UI.howtoObjective)}</p>`,
    () => `
      <p class="tv-kicker">${esc(UI.howtoRoundHead)}</p>
      <p class="tv-body">${esc(UI.howtoRound)}</p>
      <p class="tv-quip">${esc(UI.howtoMatrix)}</p>`,
    () => `
      <p class="tv-kicker">${esc(UI.howtoFinaleHead)}</p>
      <p class="tv-body">${esc(UI.howtoFinale)}</p>
      <p class="tv-quip">${esc(UI.howtoTip3)}</p>`,
    () => `
      <p class="tv-kicker">${esc(UI.howtoStrategyHead)}</p>
      <p class="tv-body">${esc(UI.howtoTip1)}</p>
      <p class="tv-quip">${esc(UI.howtoTip2)} ${esc(UI.howtoTip5)}</p>`,
  ]
  const step = Math.floor(Date.now() / 9000) % panels.length
  return card(`
    ${panels[step]()}
    <div class="tv-roster">${seated().map(p => `<span class="name">${esc(p.name)}</span>`).join('')}</div>
    <div class="tv-code">${esc(s.code)}</div>
  `)
}

function vPrompt() {
  const s = ctx.state
  const missing = seated().filter(p => !s.answered[p.pub]).length
  return card(`
    <p class="tv-kicker">${esc(fill(UI.roundLabel, { n: String(s.round) }))} · ${esc(ctx.deck.rounds[s.round - 1].name)}</p>
    <h1 class="tv-huge">${esc(promptText())}</h1>
    <p class="tv-mute">${missing ? esc(fill(UI.tvWriting, { n: String(missing) })) : esc(UI.tvAllIn)}</p>
  `)
}

function vPairing() {
  const s = ctx.state
  return card(`
    <p class="tv-kicker">${esc(fill(UI.roundLabel, { n: String(s.round) }))}</p>
    ${s.pairs.map(([a, b]) =>
      `<div class="tv-names">${esc(nameOf(a).toUpperCase())}<span class="vs">⇄</span>${esc(nameOf(b).toUpperCase())}</div>`).join('')}
    <p class="tv-quip">${esc(s.quip)}</p>
  `)
}

function vDilemma() {
  const s = ctx.state
  const left = timerLeft(15)
  const locked = s.pairs.flat().filter(p => s.commits[p]).length
  return card(`
    <p class="tv-kicker">${esc(fill(UI.roundLabel, { n: String(s.round) }))}</p>
    ${s.pairs.map(([a, b]) =>
      `<div class="tv-names">${esc(nameOf(a).toUpperCase())}<span class="vs">⇄</span>${esc(nameOf(b).toUpperCase())}</div>`).join('')}
    <div class="tv-timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
    <p class="tv-mute">${locked}/${s.pairs.flat().length} · ${esc(UI.tvWatchPhones)}</p>
  `)
}

function vOutcome() {
  const s = ctx.state
  const o = s.outcomes[s.outcomeStep]
  if (!beat(`o:${s.round}:${s.outcomeStep}`)) return card(`<div class="tv-dots">…</div>`)
  const names = { a: nameOf(o.a), b: nameOf(o.b) }
  const headline = o.kind === 'trade' ? fill(UI.outcomeTrade, names)
    : o.kind === 'stalemate' ? fill(UI.outcomeStalemate, names)
    : fill(UI.outcomeBetrayal, { winner: nameOf(o.winner), loser: nameOf(o.loser) })
  return card(`
    <h1 class="tv-huge ${o.kind === 'betrayal' ? 'hot-text' : ''}">${esc(headline)}</h1>
    <p class="tv-quip">${esc(o.quip)}</p>
  `)
}

function tvScoreRows() {
  const s = ctx.state
  return [...seated()]
    .sort((a, b) => (s.scores[b.pub] || 0) - (s.scores[a.pub] || 0))
    .map(p => `<li>
      <span class="nm">${esc(p.name)}</span>
      <span class="style-tag">${esc(s.styles[p.pub] || '')}</span>
      <span class="dg">${'🗡'.repeat(s.daggers[p.pub] || 0)}</span>
      <span class="pt">${s.scores[p.pub] || 0}</span>
    </li>`).join('')
}

function vScoreboard() {
  const s = ctx.state
  // a style evolution gets its own beat before the standings
  if (s.styleChange && !beat(`sc:${s.round}`, 3000)) return card(`
    <p class="tv-kicker">${esc(UI.tvStyleTitle)}</p>
    <h1 class="tv-huge">${esc(s.styleChange.quip)}</h1>
  `)
  return card(`
    <p class="tv-kicker">${esc(fill(UI.scoreboardTitle, { n: String(s.round) }))}</p>
    <ul class="tv-scores">${tvScoreRows()}</ul>
    <p class="tv-quip">${esc(s.quip)}</p>
  `)
}

function vFinaleIntro() {
  return card(`
    <h1 class="tv-logo hot-text">${esc(UI.finaleIntroTitle)}</h1>
    <p class="tv-body">${esc(UI.finaleIntroBody)}</p>
  `)
}

function vFinale() {
  const s = ctx.state
  const f = s.finale
  const actor = nameOf(f.order[f.turn])
  if (f.step === 'choose') return card(`
    <p class="tv-kicker">${esc(UI.finaleIntroTitle)}</p>
    <h1 class="tv-huge">${esc(fill(UI.finaleWatching, { name: actor }))}</h1>
    <p class="tv-quip">${esc(s.styles[f.order[f.turn]] || '')}</p>
  `)
  if (f.step === 'extort') {
    const left = timerLeft(20)
    return card(`
      <p class="tv-quip">${esc(s.quip)}</p>
      <div class="tv-names">${esc(actor.toUpperCase())}<span class="vs">🗡</span>${esc(nameOf(f.action.owner).toUpperCase())}</div>
      <div class="tv-timer ${left <= 5 ? 'hot-t' : ''}">${left || '…'}</div>
      <p class="tv-mute">${esc(fill(UI.extortTargetDeciding, { name: nameOf(f.action.owner) }))}</p>
    `)
  }
  if (f.step === 'decide') return card(`
    <h1 class="tv-huge">${esc(fill(UI.decideWaiting, { name: actor }))}</h1>
  `)
  if (!beat(`f:${f.turn}`)) return card(`<div class="tv-dots">…</div>`)
  const a = f.action
  let body = ''
  if (a.kind === 'vault' && a.auto) body = `<p class="tv-body">${esc(fill(UI.finaleAutoVault, { name: actor }))}</p>`
  else if (a.kind === 'burn' || a.revealed) {
    const x = s.exposed[s.exposed.length - 1]
    body = `<div class="tv-exposed">
      <p class="tv-kicker hot-text">${esc(fill(UI.exposedFrom, { owner: nameOf(x.owner), n: String(x.round) }))}</p>
      <p class="secret">${esc(x.text)}</p>
      <p class="tv-mute">${esc(UI.cantUntell)}</p></div>`
  }
  return card(`<p class="tv-quip" style="font-size:6vh">${esc(s.quip)}</p>${body}`)
}

function vFinal() {
  const s = ctx.state
  // the closing roast plays card by card before the standings
  if (s.roast) {
    const step = Math.min(ctx.ui.roastStep ?? 0, s.roast.length)
    if (step < s.roast.length) {
      if (beat(`roast:${step}`, 6000)) {                // generous dwell per card
        ctx.ui.roastStep = step + 1
        setTimeout(render, 0)
      }
      return card(`
        <p class="tv-kicker">${esc(UI.roastTitle)}</p>
        <h1 class="tv-huge">${esc(s.roast[step])}</h1>
      `)
    }
  }
  return card(`
    <h1 class="tv-logo">${esc(UI.finalTitle)}</h1>
    <ul class="tv-scores">${tvScoreRows()}</ul>
    <p class="tv-body"><span class="tv-kicker">${esc(UI.villainAward)}</span> ${esc(s.ending.villain)} ${'🗡'.repeat(s.ending.vd)}
      · <span class="tv-kicker">${esc(UI.suckerAward)}</span> ${esc(s.ending.sucker)}</p>
    <p class="tv-quip">${esc(s.quip)}</p>
  `)
}

main().catch(console.error)
