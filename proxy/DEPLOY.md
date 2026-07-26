# Deploying the MC proxy — a ten-minute runbook

This turns on the **"This site's AI"** Master-of-Ceremonies backend for every
host, with zero setup on their phones. One Cloudflare Worker holds one
low-cost Anthropic key server-side; `proxy/worker.js` pins the model
(`claude-haiku-4-5`), the policy, the schemas, and the token caps, so the
key cannot be borrowed for anything but party-game content. A full night of
quips costs about a cent.

You need: a Cloudflare account (free tier is fine), an Anthropic API key,
and Node on this machine. Nothing here touches the game's relays or secrets
— MC inputs are public-only game data by construction (tested in `sim.mjs`).

## 1. Create the worker project (once)

```sh
cd ~/Projects
npm create cloudflare@latest ntrigue-mc -- --type hello-world
```

Accept the defaults; say **no** to git and **no** to deploy-now. Then point
it at the game's worker code:

```sh
cp ~/Projects/ntrigue/proxy/worker.js ~/Projects/ntrigue-mc/src/index.js
```

(When `proxy/worker.js` changes later, re-copy and re-deploy — step 3.)

## 2. Give it the key

```sh
cd ~/Projects/ntrigue-mc
npx wrangler secret put ANTHROPIC_API_KEY
```

Paste the key at the prompt. It lives only in Cloudflare's secret store —
never in the repo, never in the browser. Use a dedicated key so you can
revoke it independently (Anthropic console → API keys → create key
"ntrigue-mc").

## 3. Deploy

```sh
npx wrangler deploy
```

The output ends with your worker URL, e.g.
`https://ntrigue-mc.<your-subdomain>.workers.dev`. First deploy may ask you
to log in to Cloudflare in the browser — that's the interactive step this
runbook exists for.

Smoke-test it (a policy-pinned quip request; expect JSON back, not an error):

```sh
curl -s -X POST https://ntrigue-mc.<your-subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -d '{"kind":"quip","user":"Event: betrayal. winner: Alice, loser: Bob."}'
```

## 4. Tell the game about it

```sh
cd ~/Projects/ntrigue
cp mc.json.example mc.json
# edit mc.json: set proxyUrl to the workers.dev URL from step 3
git add mc.json && git commit -m "mc.json: point the site MC at the deployed proxy"
git push
```

`mc.mjs` fetches `mc.json` from next to `index.html` at runtime; once the
site redeploys (ntrigue.nave.pub picks up main), every lobby's AI-host
setup shows the **"This site's AI"** option with nothing to type.

## 5. Verify in the game

Open the site, New Game, lobby → **AI host…** — the "This site's AI" mode
should now be listed. Pick it, start a night with robot guests, and watch
the deck generate and the quips upgrade.

## Care and feeding

- **Rotate the key**: `npx wrangler secret put ANTHROPIC_API_KEY` again
  with a new value, then `npx wrangler deploy`. Revoke the old key in the
  Anthropic console.
- **Turn it off**: delete `mc.json` from the site (hosts fall back to
  Instant/BYOK), or `npx wrangler delete` to remove the worker entirely.
- **Costs**: the worker rate-limits per IP and caps tokens per call;
  `claude-haiku-4-5` puts a heavy night in the cents. Watch usage in the
  Anthropic console; the key is useless for anything but this worker's
  pinned prompts.
- **Policy changes**: the roast/quip guardrails live in `worker.js`'s
  `POLICY` (kept in sync with `mc-policy.md`). Edit → re-copy → deploy.
