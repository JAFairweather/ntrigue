// test/bots.mjs — the solo night: one human (the host) seats two robot
// guests and plays a complete game — warm-up off, four rounds, finale —
// with the bots answering, trading, and blackmailing on their own. Because
// bot choices are genuinely random, this drives the night by reading the
// screen: whatever the game asks for, the human does.
//
//   node test/bots.mjs
//   PLAYWRIGHT_CHROMIUM=<path> node test/bots.mjs

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startDevRelay } from './devrelay.mjs'

const APP = fileURLToPath(new URL('..', import.meta.url))
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
const server = http.createServer(async (req, res) => {
  const path = req.url.split('#')[0].split('?')[0]
  const file = join(APP, path === '/' ? 'index.html' : path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(8898, r))
const relay = startDevRelay(7778)

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})
const errors = []
const context = await browser.newContext({ viewport: { width: 390, height: 720 } })
const host = await context.newPage()
host.on('pageerror', (e) => errors.push(e.message))
host.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const T = { timeout: 20000 }
const tap = (label) => host.getByRole('button', { name: label, exact: false }).first().click(T)
const see = (text) => host.getByText(text, { exact: false }).first().waitFor(T)
const visible = (text) => host.getByText(text, { exact: false }).first().isVisible().catch(() => false)
const btnVisible = (label) => host.getByRole('button', { name: label, exact: false }).first().isVisible().catch(() => false)
const tapIf = async (label) => {
  if (!(await btnVisible(label))) return false
  await host.getByRole('button', { name: label, exact: false }).first().click({ timeout: 3000 }).catch(() => {})
  return true
}

// ---- open the table, sit down, seat two robot guests
await host.goto('http://localhost:8898/index.html#r=' + encodeURIComponent('ws://localhost:7778'))
await tap('New Game')
await host.locator('#name-input').fill('James', T)
await tap('Sit down')
await see('The table is open')
await tap('Add a robot guest')
await tap('Add a robot guest')
await see('3 at the table')
await see('🤖')                                        // bots visibly seated

// warm-up off for speed — the warm-up path is covered by e2e
await tap('Warm-up round: on')
await see('Warm-up round: off')
await tap('Start the night')

// ---- drive the whole night by reading the screen. Bot choices are random,
// so every branch the game can ask of the human is handled:
//   write+lock a secret · SHARE · read a received secret · pay/refuse an
//   extortion · pick a move on my finale turn · advance the cards
let finished = false
let lastNote = ''
for (let i = 0; i < 400 && !finished; i++) {
  if (i % 25 === 24) {                                 // stall diagnostics
    const note = (await host.evaluate(() => document.body.innerText)).slice(0, 120).replace(/\n/g, ' | ')
    if (note === lastNote) console.log(`  [i=${i}] screen unchanged: ${note}`)
    else console.log(`  [i=${i}] ${note}`)
    lastNote = note
  }
  if (await visible('FINAL SCORES')) { finished = true; break }
  if (await host.locator('#secret-input').isVisible().catch(() => false)) {
    await host.locator('#secret-input').fill(`james-solo-secret-${i}`, T)
    await tap('Lock it in')
  } else if (await btnVisible('SHARE')) {
    await tapIf('SHARE')
  } else if (await btnVisible('Got it')) {
    await tapIf('Got it')                              // close a private read
  } else if (await visible('Your move') && await btnVisible('Vault')) {
    await tapIf('Vault')                               // my finale turn: discretion
    // ('Pay 3 points' also appears in the Extort button's caption, so the
    //  extortion check below must key on the demand text, not the button)
  } else if (await visible('has one of your secrets')) {
    await tapIf(i % 2 ? 'Pay 3' : 'Refuse')            // a bot is extorting ME
  } else if (await btnVisible('Begin')) {
    await tapIf('Begin')
  } else if (await btnVisible('Everyone’s in')) {
    await tapIf('Everyone’s in')
  } else if (await btnVisible('Next')) {
    await tapIf('Next')
  }
  await host.waitForTimeout(400)
}

if (!finished) {
  await host.screenshot({ path: process.env.SNAP || '/tmp/bots-stall.png' }).catch(() => {})
  console.log('STALLED AT:', (await host.evaluate(() => document.body.innerText)).slice(0, 400))
  console.log('PAGE ERRORS:', errors.join(' | ') || '(none)')
}
assert.ok(finished, 'the solo night must reach FINAL SCORES')
await see('Villain of the night')
const final = await host.evaluate(() => document.body.innerText)
assert.ok(final.includes('🤖'), 'robot guests appear on the final scoreboard')
assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`)

await browser.close()
relay.close()
server.close()
console.log('bots ok — one human + two robot guests played a complete night:')
console.log('        bots answered, chose, traded with real sealed copies and')
console.log('        handovers, and played the finale; the human drove it all')
console.log('        from one phone to FINAL SCORES.')
process.exit(0)
