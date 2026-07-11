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
                             # + adversarial relay-observer check
node test/e2e.mjs            # 4 real browsers play a complete night
                             # (dev deps: npm i playwright ws — not committed;
                             #  PLAYWRIGHT_CHROMIUM=<path> to override the browser)
```

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

## v1 seams (deliberately left)

- `state.mjs` schema carries a version field (`v`).
- Deck and quips load through `content` indirection — the AI MC swaps in here.
- `stage` client-role flag exists in state for TV/Stage mode.
