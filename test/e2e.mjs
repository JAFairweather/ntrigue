// test/e2e.mjs — the spec's scripted 4-browser full-game run (§9), automated
// with Playwright: four isolated browser contexts (four "phones") play a
// complete night — join by link, four rounds with trades and a betrayal,
// private secret reading, blackmail finale — against a local dev room.
// Dev-only deps: playwright + ws (see README).
//
//   node test/e2e.mjs

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
await new Promise(r => server.listen(8899, r))
const relay = startDevRelay(7777)

// PLAYWRIGHT_CHROMIUM overrides the executable when the installed playwright
// version's pinned browser build isn't present (e.g. preinstalled sandboxes).
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})
const errors = []
const NAMES = ['James', 'Sarah', 'Priya', 'Marco']
const pages = {}
for (const name of NAMES) {
  const context = await browser.newContext({ viewport: { width: 390, height: 720 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`) })
  pages[name] = page
}
const [james, sarah, priya, marco] = NAMES.map(n => pages[n])
const all = Object.values(pages)

const T = { timeout: 15000 }
const tap = (page, label) => page.getByRole('button', { name: label, exact: false }).first().click(T)
const see = (page, text) => page.getByText(text, { exact: false }).first().waitFor(T)

// ---- host opens the table on the local room
await james.goto('http://localhost:8899/index.html#r=' + encodeURIComponent('ws://localhost:7777'))
await tap(james, 'New Game')
await james.locator('#name-input').fill('James', T)
await tap(james, 'Sit down')
await see(james, 'The table is open')

// ---- friends join by link
const joinUrl = await james.evaluate(() => location.href)
for (const name of NAMES.slice(1)) {
  const page = pages[name]
  await page.goto(joinUrl)
  await page.locator('#name-input').fill(name, T)
  await tap(page, 'Sit down')
}
await see(james, '4 at the table')
await tap(james, 'Start the night')

// ---- four rounds; R3 has a betrayal (Marco holds on James), rest trade
for (let r = 1; r <= 4; r++) {
  for (const name of NAMES) {
    const page = pages[name]
    await see(page, `Round ${r}`)
    await page.locator('#secret-input').fill(`${name} secret r${r}`, T)
    await tap(page, 'Lock it in')
  }
  await see(james, 'matchups')
  await tap(james, 'Next')
  for (const name of NAMES) {
    const betray = r === 3 && name === 'Marco'
    await tap(pages[name], betray ? 'HOLD' : 'SHARE')
  }
  // outcome cards (drama beat included); James reads a received secret in R1
  await see(james, r === 3 ? 'took' : 'traded')
  if (r === 1) {
    await tap(james, 'Read Priya’s secret')          // R1 pairs James ⇄ Priya
    await see(james, 'FOR YOUR EYES ONLY')
    await see(james, 'Priya secret r1')
    await tap(james, 'Got it')
  }
  if (r === 3) await see(marco, 'gave nothing back') // betrayal announced by name
  await tap(james, 'Next')                           // outcome pair 2
  await tap(james, 'Next')                           // scoreboard
  await see(james, `Scores after round ${r}`)
  await tap(james, 'Next')
}

// ---- finale, last place first: James(10), Priya(12, seat tie-break),
// Sarah(12), Marco(14). Covers every finale surface: extort → refuse →
// public reveal, two vaults, and a burn.
await see(james, 'BLACKMAIL FINALE')
await tap(james, 'Begin')

// James extorts Sarah with her round-2 secret; she refuses; he goes public
await see(james, 'Your move')
await james.locator('.stash', { hasText: 'round 2' }).click(T)
await tap(james, 'Extort')
await see(sarah, 'has one of your secrets')
await tap(sarah, 'Refuse')
await see(james, 'Your call')
await tap(james, 'Make it public')
await see(priya, 'Sarah secret r2')                  // the room hears it
await see(priya, 'cannot be un-told')
await tap(james, 'Next')

// Priya and Sarah keep quiet for profit
for (const mover of [priya, sarah]) {
  await see(mover, 'Your move')
  await tap(mover, 'Vault')
  await tap(james, 'Next')
}

// Marco burns what he took from James in round 3
await see(marco, 'Your move')
await marco.locator('.stash', { hasText: 'James' }).click(T)
await tap(marco, 'Burn')
await see(sarah, 'James secret r3')
await tap(james, 'Next')

// ---- the reckoning, on every phone
for (const page of all) {
  await see(page, 'FINAL SCORES')
  await see(page, 'Villain of the night')
}
// trades +3; R3 betrayal: Marco +5 / James +1; finale: reveal +2, vaults +2, burn +1
const score = async (page, name) => Number(await page.locator('.score-row', { hasText: name }).first().locator('.pts').textContent(T))
assert.equal(await score(james, 'James'), 3 + 3 + 1 + 3 + 2)
assert.equal(await score(james, 'Marco'), 3 + 3 + 5 + 3 + 1)
assert.equal(await score(james, 'Sarah'), 3 * 4 + 2)
assert.equal(await score(james, 'Priya'), 3 * 4 + 2)

// ---- refresh-rejoin: a player reloads and lands back at the final card
await sarah.reload()
await see(sarah, 'FINAL SCORES')

// ---- adversarial check on the live room: 14 secrets stayed ciphertext,
// only the two deliberate reveals (blackmail + burn) are stored readable
const stored = relay.store.events.map(e => e.content).join('\n')
for (const name of NAMES) for (let r = 1; r <= 4; r++) {
  const text = `${name} secret r${r}`
  const wasExposed = (name === 'James' && r === 3) || (name === 'Sarah' && r === 2)
  if (wasExposed) assert.ok(stored.includes(text), `deliberately public: ${text}`)
  else assert.ok(!stored.includes(text), `room must never hold: ${text}`)
}

assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`)
await browser.close()
relay.close()
server.close()
console.log('e2e ok — 4 phones, full night: join → 4 rounds (trades + a betrayal,')
console.log('        private reads) → finale extort/refuse/reveal, vaults, burn →')
console.log('        exact scores → refresh-rejoin → room stored no private plaintext.')
process.exit(0)
