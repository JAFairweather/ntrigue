# Ntrigue

**A phones-only party game of secrets, dilemmas, and blackmail.** Four friends
around a table. Everyone answers a spicy prompt privately — the answer is an
encrypted scope only they hold. Pairwise prisoner's-dilemma exchanges decide
who sees what. Betrayals are announced by name. The finale is a blackmail
economy where everything you've collected is leverage.

Design law: *you can revoke a secret, but you can't un-tell it.*

This is **v0** (the dinner-party build): 4 players (3–6 supported), phones
only, 4 rounds + blackmail finale, static content, no server, no accounts,
no AI. Version 0.1 · MIT.

## Play tonight

Ntrigue is a static web app — vanilla ESM, no build step. Serve this
directory from any static host (or locally: `python3 -m http.server` and use
your LAN IP). One player taps **New Game** (that phone hosts — keep it
awake), everyone else scans the QR, types a first name, sits down.

There is no game server: public nostr relays are the game room
(`relay.damus.io`, `nos.lol`, `relay.primal.net` by default; override by
opening the landing page with `#r=<url,url>` before tapping New Game).

## Architecture

- **Protocol**: [NIP-DA Scoped Data Grants](https://github.com/JAFairweather/nostr-scoped-data-grants).
  `nipxx.mjs` is vendored unchanged from the protocol repo (only the import
  path points at the local bundle). Each answer is a kind-30440 scope under
  its own key; a trade delivers a kind-440 gift-wrapped grant of that key
  directly to the counterpart. Relays see ciphertext and wraps — never
  plaintext, never who traded with whom.
- **Host = the creator's phone.** It folds player action events through the
  pure reducer in `state.mjs` and publishes public game state (kind-30078,
  game id in the `d` tag). Phones render whatever the latest state says.
  The host relays *that* you answered, never *what*.
- **Simultaneous SHARE/HOLD uses commit–reveal**: `sha256(choice + nonce)`
  first, choice+nonce once both commitments exist. Cheat-resistant with zero
  server.
- **Public reveals** (blackmail, burn) post the plaintext into game state —
  deliberately. You can't un-tell it, and the UI says so at that moment.
- All timers are soft; every phase tolerates relay straggle with
  "waiting on …" states. Refresh/crash rejoins at the current phase from
  localStorage + the latest state event.
- **Deck flavors**: the host picks the night's heat in the lobby —
  Innocent (guilty pleasures and harmless habits; the default, built to be
  the very-playable first game), Spicy (the original deck), or Scorching
  (old flames, closed doors). Each is a full 4-round deck; generated (AI)
  decks bypass flavors.
- **Warm-up round** (host toggle in the lobby, on by default): round 0 runs
  the full answer→match→choose→outcome loop on a mild prompt pool with
  coaching lines on every screen, ends in a debrief, and wipes scores,
  daggers, counters, and collected secrets before round 1.
- **Self-healing transport**: taps never wait on the network (store first,
  retry until the state confirms), every client polls for what push should
  have delivered, and three consecutive misses of the always-present state
  event tear down and rebuild the socket pool — phones sleeping, zombie
  connections, and dozing hosts all recover without a manual reload.
- `vendor/nostr-tools.js` is a prebuilt ESM bundle of nostr-tools 2.x
  (+ noble sha256 + qrcode-generator) so the app stays CDN-free and
  build-free.

The language rule: player-facing screens contain zero protocol vocabulary
(enforced by test). The tech is credited on `about.html` only, reachable
from the landing screen.

## Tests

```sh
node test/banned-words.mjs   # the language rule, over all player-visible copy
node test/sim.mjs            # full scripted game through reducer + real crypto
                             # + adversarial relay-observer + stage-privacy checks
node test/e2e.mjs            # 4 real browsers + a TV stage play a complete night
                             # (dev deps: npm i playwright ws — not committed;
                             #  PLAYWRIGHT_CHROMIUM=<path> to override the browser)
```

## v1 — Stage mode (M-TV)

An enhancement, never a requirement — the phones-only game remains fully
playable forever.

- **`/tv`**: open `<site>/tv/#CODE` on any TV-connected browser — the host
  phone shows the exact address — or open bare `/tv/` and type the 4-letter
  room code (the landing page's Join flow accepts codes too). The stage
  joins read-only with its own throwaway identity. A code in the address
  always beats whatever table the screen remembers, a quiet ↩ New table
  button sits in the corner of every stage screen, and a finished or
  hours-cold night is auto-forgotten on revisit instead of restored.
- **Privacy by construction**: the stage renders public game state only. It
  holds no secret-reading capability, so it cannot display anything that
  hasn't been deliberately made public — asserted in both test suites
  (the stage key receives zero kind-440s in a full game).
- **Style profiles**: rule-based archetypes (Open Book, Vault, Shark, Mark,
  Diplomat, Anarchist, Enforcer, Wildcard) computed from public play
  counters at every scoreboard; every player always has exactly one label,
  ties resolve to the newest-earned, and evolutions get their own beat.
- **Phones adapt** when a stage is present: drama pacing moves to the TV
  (biggest possible), the lobby QR moves to the TV, and phones become
  private controllers with a 📺 chip. If the TV vanishes, its heartbeat
  goes stale, the host declares it gone, and phones re-expand on the next
  update — nothing breaks.
- **Sound**: short WebAudio-synthesized stingers on the stage only
  (betrayal sting, trust chime, tension bed, reveal hit) — off by default,
  toggled from the host phone. Phones stay silent always. (The spec
  suggested static audio assets; synthesis keeps the app asset-free.)
- **Connection self-check**: after creating a table, the host phone reads
  its own first update back and warns if the connection looks one-way.

## v1 — AI Master of Ceremonies (M-MC)

Replaces the static deck and quip templates with a generated, group-tuned
experience. **The static deck and templates remain permanently as the
fallback path** — any API failure, timeout (2.5s for live lines), or
`policy_ok: false` self-check silently falls back. The game never stalls
on a model.

- **Nobody has to type an API key.** The lobby's "AI host" setup offers
  three backends, all behind the single `mc.mjs` interface
  (`generateDeck` / `liveQuip` / `closingRoast`):
  1. **Instant** — one tap, zero setup: a free public text endpoint
     (`text.pollinations.ai`). Best-effort quality and uptime, and fine
     to use precisely because MC inputs are public-only game data — an
     unshared secret can never reach it (tested).
  2. **This site's AI** — the site owner deploys `proxy/worker.js`
     (Cloudflare Workers free tier) once with one low-cost Anthropic key
     (`claude-haiku-4-5` — a full night of quips costs about a cent) and
     ships an `mc.json` (`{"proxyUrl": ...}`, see `mc.json.example`) next
     to `index.html`. Every host then gets quality AI with zero typing.
     The worker pins the model, policy, schemas, and token caps, so the
     key can't be borrowed for anything but party-game content, and
     rate-limits per IP.
  3. **Advanced** — the host's own Anthropic key, direct browser calls,
     stored only in that phone's localStorage.

  To deploy the proxy:
  ```sh
  npm create cloudflare@latest ntrigue-mc -- --type hello-world
  cp proxy/worker.js ntrigue-mc/src/index.js
  cd ntrigue-mc && npx wrangler secret put ANTHROPIC_API_KEY && npx wrangler deploy
  # then: cp mc.json.example mc.json, edit proxyUrl, commit
  ```
- **Deck generation**: one call at game start produces the full night —
  4 rounds × 6 candidates following the v0 arc, tuned by free-text group
  context, a spice dial (1 mild / 2 spicy / 3 scorching, default 2), and
  a topics-to-avoid list that is respected absolutely. The host's redraw
  draws from the candidates without another API call. The generated deck
  is logged locally on the host phone and never published — only the
  drawn prompt's text enters public game state.
- **Live quips**: event-triggered lines (pairings, outcomes, scoreboards,
  extortions, folds, reveals) generated with a hard 2.5s budget against
  the public event log only, then swapped in over the prewritten template
  via the reducer. Stale lines (the card already moved on) are dropped.
- **Closing roast**: one generation from the full public log, ≤150 words,
  delivered card-by-card on the stage (and shown on phones).
- **Content policy**: `mc-policy.md` ships in the repo as the system
  prompt; every prompt and quip carries a structured `{text, policy_ok,
  reason}` self-check — `policy_ok: false` → fallback, no retry loop.
- **Privacy, tested**: the `mc.mjs` input builders accept only the public
  reducer state, which never contains unrevealed secret text — asserted
  end-to-end in `test/sim.mjs` (no MC input contains an unexposed secret;
  deliberately revealed ones are fair game, alluded to rather than quoted).

## v0.1 notes / debts

- Nothing from the spec's cut-list was cut: commit–reveal, full extort
  negotiation, trust daggers, and drama beats all shipped.
- If the host phone dies, the game dies (said on the create screen). v1 may
  add host handoff.
- Burn/blackmail reveal text is posted by the grant-holder's client from its
  decrypted copy — honest-client assumption among friends; the cryptography
  protects against outsiders and relay operators, not table-mates editing
  their own client.
- Payoff numbers (3/5/1/1) per spec defaults — tune after tonight.

## Later seams (designed for, not built)

- Hosted MC proxy with metered games — `mc.mjs` is the single interface
  the backend swaps behind.
- 6–8 players with couple-marking, spectator role.
- Stage sound as shipped audio assets (currently WebAudio synthesis).
