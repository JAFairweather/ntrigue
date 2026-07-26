// test/banned-words.mjs — the language rule, enforced: player-facing screens
// contain ZERO protocol vocabulary. Scans every source of player-visible
// text. about.html is deliberately exempt — the spec allows the tech to be
// credited there, reachable from the landing screen only.
//
//   node test/banned-words.mjs

import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const BANNED = [
  'nostr', 'relay', 'relays', 'scope', 'scopes', 'grant', 'grants', 'granted',
  'key', 'keys', 'npub', 'nsec', 'encrypt', 'encrypted', 'encryption',
  'decrypt', 'decrypted', 'event', 'events', 'publish', 'published', 'sign', 'signed',
]
const wordRe = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i')

const failures = []
const check = (where, text) => {
  const m = text.match(wordRe)
  if (m) failures.push(`${where}: "${m[1]}" in ${JSON.stringify(text.slice(0, 80))}`)
}

// 1. every UI string, robot-guest names, and robot-guest canned secrets
const { UI, BOT } = await import('../copy.mjs')
for (const [k, v] of Object.entries(UI)) check(`copy.mjs UI.${k}`, v)
for (const n of BOT.names) check('copy.mjs BOT.names', n)
BOT.lines.forEach((l, i) => check(`copy.mjs BOT.lines[${i}]`, l))

// 2. every prompt in the deck — warm-up pool and all three flavors
const deck = JSON.parse(await readFile(new URL('../deck.json', import.meta.url)))
const allPrompts = [
  ...(deck.practice || []),
  ...(deck.flavors || [{ rounds: deck.rounds }]).flatMap(f => f.rounds.flatMap(r => r.prompts)),
]
for (const p of allPrompts) check(`deck #${p.id}`, p.text)
for (const [heat, list] of Object.entries(deck.starters || {}))
  list.forEach((s, i) => check(`deck starters.${heat}[${i}]`, s))

// 3. every quip variant
const quips = JSON.parse(await readFile(new URL('../quips.json', import.meta.url)))
for (const [k, list] of Object.entries(quips.quips))
  list.forEach((q, i) => check(`quips ${k}[${i}]`, q))

// 4. visible text of the game page (tags stripped). Two deliberate
// exemptions, same rationale: about.html credits the tech, and the Nave
// intro splash (#nave-intro, dismissed before the game is ever visible)
// IS the protocol's front-door introduction — it quotes and links Nostr
// on purpose (#37). The game's own screens stay under the rule.
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const visible = html
  .replace(/<!--[\s\S]*?-->/g, ' ')          // comments aren't visible text
  .replace(/<div id="nave-intro"[\s\S]*?<\/script>/i, '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ') // neither are stylesheets
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<[^>]+>/g, ' ')
check('index.html', visible)

assert.deepEqual(failures, [], `banned protocol vocabulary reached player-facing copy:\n${failures.join('\n')}`)
console.log(`banned-words ok — ${Object.keys(UI).length} UI strings, ${allPrompts.length} prompts, ` +
  `${Object.values(quips.quips).flat().length} quips, index.html: all clean.`)
