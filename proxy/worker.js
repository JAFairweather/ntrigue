// proxy/worker.js — the site's own AI relay for Ntrigue's Master of
// Ceremonies. Deploy once (Cloudflare Workers free tier), and every host
// gets the AI host with zero setup: phones POST {kind, user} here and this
// worker holds the ONE low-cost Anthropic key server-side.
//
// Deliberately NOT a passthrough: the system prompt, model, schemas, and
// token caps are pinned here, so the key cannot be borrowed for anything
// except generating party-game content.
//
// Deploy:
//   npm create cloudflare@latest ntrigue-mc -- --type hello-world
//   cp this file over src/index.js (or point wrangler.toml main at it)
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler deploy
// Then ship mc.json next to the game's index.html:
//   { "proxyUrl": "https://ntrigue-mc.<your-subdomain>.workers.dev" }

const MODEL = 'claude-haiku-4-5'   // low-cost tier: a full night of quips costs about a cent

// Keep in sync with mc-policy.md in the game repo.
const POLICY = `You are the Master of Ceremonies for Ntrigue, a party game of
secrets, dilemmas, and blackmail played by close friends around a dinner
table. Your voice: dry roast-comic. PG-13. Spicy, not racy. Never cruel.
Tension between players is the product; harm is not.

Hard rules: no lines targeting bodies, weight, appearance, or health; no
protected traits; no fidelity or cheating accusations; no finances-as-shame;
no grief, illness, or trauma; anything on the host's avoid list is respected
absolutely. Punch at choices and quirks, never at vulnerabilities. Secrets
belong to the players — never invent or allude to a secret's content unless
it is in the material you are given.

Every generated prompt and quip carries a policy_ok boolean and a short
reason. If a line brushes any hard rule, set policy_ok: false. Never retry.`

const CAND = {
  type: 'object',
  properties: { text: { type: 'string' }, policy_ok: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['text', 'policy_ok', 'reason'],
  additionalProperties: false,
}
const KINDS = {
  deck: {
    maxTokens: 8000,
    schema: {
      type: 'object',
      properties: {
        rounds: {
          type: 'array',
          items: {
            type: 'object',
            properties: { round: { type: 'integer' }, candidates: { type: 'array', items: CAND } },
            required: ['round', 'candidates'],
            additionalProperties: false,
          },
        },
      },
      required: ['rounds'],
      additionalProperties: false,
    },
  },
  quip: { maxTokens: 300, schema: CAND },
  roast: {
    maxTokens: 1500,
    schema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'string' } },
        policy_ok: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['cards', 'policy_ok', 'reason'],
      additionalProperties: false,
    },
  },
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

// Best-effort per-IP rate limit (per isolate — enough to stop casual abuse
// on the free tier without needing KV/Durable Objects).
const buckets = new Map()
function allow(ip, perMinute = 30) {
  const now = Date.now()
  const b = buckets.get(ip) || { count: 0, reset: now + 60_000 }
  if (now > b.reset) { b.count = 0; b.reset = now + 60_000 }
  b.count++
  buckets.set(ip, b)
  if (buckets.size > 10_000) buckets.clear()
  return b.count <= perMinute
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: CORS })

    const ip = request.headers.get('cf-connecting-ip') || 'unknown'
    if (!allow(ip)) return new Response('rate limited', { status: 429, headers: CORS })

    let body
    try { body = await request.json() } catch { return new Response('bad json', { status: 400, headers: CORS }) }
    const kind = KINDS[body?.kind]
    const user = typeof body?.user === 'string' ? body.user : ''
    if (!kind || !user || user.length > 20_000)
      return new Response('bad request', { status: 400, headers: CORS })

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: kind.maxTokens,
        system: POLICY,
        output_config: { format: { type: 'json_schema', schema: kind.schema } },
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!upstream.ok)
      return new Response('upstream error', { status: 502, headers: CORS })
    const msg = await upstream.json()
    if (msg.stop_reason === 'refusal')
      return new Response('declined', { status: 502, headers: CORS })
    const text = (msg.content || []).find(b => b.type === 'text')?.text || ''
    return new Response(text, {
      headers: { ...CORS, 'content-type': 'application/json' },
    })
  },
}
