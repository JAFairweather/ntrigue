// copy.mjs — every player-facing string in the game, in one place, so the
// banned-word scan (test/banned-words.mjs) can enforce the language rule:
// zero protocol vocabulary anywhere a player can see. Game words only.

export const UI = {
  title: 'NTRIGUE',
  tagline: 'Secrets. Dilemmas. Blackmail.',
  subtitle: 'A party game for 4 friends and one long dinner.',
  newGame: 'New Game',
  joinGame: 'Join',
  about: 'About',

  createWarning: 'Your phone runs the table tonight. Keep it awake — if it sleeps, the game sleeps.',
  createButton: 'Open the table',

  lobbyTitle: 'The table is open',
  lobbyShare: 'Friends scan this, or open the link:',
  lobbyCopyLink: 'Copy link',
  lobbyCopied: 'Copied!',
  lobbyWaiting: 'Waiting for friends…',
  lobbySeated: '{n} at the table',
  lobbySeatHint: 'Set the seating: couples side by side — seats 1+2 are a couple, 3+4 are a couple.',
  lobbyStart: 'Start the night',
  lobbyNeedPlayers: 'Need at least 3 to start',

  joinTitle: 'Pull up a chair',
  joinNamePlaceholder: 'Your first name',
  joinButton: 'Sit down',
  joinWaitHost: 'You’re in. Watch the table — {host} starts the night.',

  roundLabel: 'Round {n}',
  promptYours: 'Your answer stays yours until you choose otherwise.',
  promptPlaceholder: 'Type your secret…',
  promptLock: 'Lock it in',
  promptLocked: 'Locked. Phones down.',
  phonesDown: 'Phones down when done.',
  waitingOn: 'Waiting on {names}…',
  hostEveryoneIn: 'Everyone’s in →',
  hostRedraw: 'Redraw prompt',
  hostNext: 'Next →',
  hostForce: 'Resolve it — stragglers hold',

  pairingTitle: 'This round’s matchups',
  sittingOut: '{name} sits this one out. Judge freely, {name}.',

  dilemmaVs: 'You  ⇄  {name}',
  dilemmaStakes: 'Trade secrets, or hold out? Decide in the dark — so does {name}.',
  dilemmaShare: 'SHARE',
  dilemmaHold: 'HOLD',
  dilemmaLockedIn: 'Locked in. Eyes on {name}…',
  dilemmaSit: 'You’re sitting out. Enjoy the show.',

  outcomeTrade: '{a} and {b} traded.',
  outcomeBetrayal: '{winner} took {loser}’s secret — and gave nothing back.',
  outcomeStalemate: '{a} and {b} both held. Nothing moves.',
  readSecret: 'Read {name}’s secret',
  eyesOnly: 'FOR YOUR EYES ONLY',
  eyesOnlyHint: 'Angle your screen. This is yours now.',
  gotIt: 'Got it',
  nothingReceived: 'You gave. You got nothing. That’s the game.',
  fetchingSecret: 'Opening…',

  scoreboardTitle: 'Scores after round {n}',
  daggerLegend: '🗡 = took a secret and gave nothing back',

  finaleIntroTitle: 'THE BLACKMAIL FINALE',
  finaleIntroBody: 'Everything you collected tonight is leverage. One move each, last place goes first: squeeze a friend, burn them for fun, or keep your mouth shut for profit.',
  finaleIntroStart: 'Begin',

  finaleYourMove: 'Your move, {name}.',
  finaleHolding: 'You’re holding:',
  finaleSecretItem: '{owner}’s secret · round {n}',
  finaleExtort: 'Extort',
  finaleExtortDesc: '“Pay 3 points or it goes public.”',
  finaleBurn: 'Burn',
  finaleBurnDesc: 'No talk. Straight to the room. +1.',
  finaleVault: 'Vault',
  finaleVaultDesc: 'Say nothing. +2 for discretion.',
  finaleWatching: '{name} is deciding…',
  finaleAutoVault: '{name} collected nothing all night — the vault takes them anyway. +2.',

  extortTitle: '{blackmailer} has one of your secrets.',
  extortDemand: 'Pay 3 points, or it goes public.',
  extortPay: 'Pay 3',
  extortRefuse: 'Refuse',
  extortTargetDeciding: '{name} is checking their wallet…',

  decideTitle: '{target} refused. Your call.',
  decideReveal: 'Make it public',
  decideRevealDesc: 'The room hears it. +2.',
  decideFold: 'Fold',
  decideFoldDesc: 'Keep it quiet. The fold is announced.',
  decideWaiting: '{name} weighs the knife…',

  exposedFrom: '{owner}’s secret, round {n}:',
  cantUntell: 'It’s out. It cannot be un-told.',

  finalTitle: 'FINAL SCORES',
  villainAward: 'Villain of the night',
  suckerAward: 'Biggest sucker',
  playAgain: 'Play again',

  rejoinReturning: 'Welcome back. Rejoining the table…',
  connecting: 'Finding the table…',
  notFound: 'Couldn’t find that table. Check the link and ask the host to keep their phone awake.',

  codeJoinLabel: 'Have a table code?',
  codeJoinPlaceholder: 'ABCD',
  codeJoinButton: 'Find the table',
  codeJoinSearching: 'Looking for your table…',
  codeJoinNotFound: 'No table with that code right now. Check the host phone.',

  tvHint: 'On your TV: open {url} — it finds this table on its own.',
  tvCodeChip: '📺 {code}',
  tvEnterTitle: 'PUT THE NIGHT ON SCREEN',
  tvEnterSub: 'Enter the 4-letter code from the host phone.',
  tvConnected: 'The table is on screen.',
  tvNewTable: 'New table',
  tvWriting: '{n} still writing…',
  tvAllIn: 'Everyone’s in.',
  tvDeciding: 'Deciding…',
  tvWatchPhones: 'Eyes on your phones.',
  tvStyleTitle: 'Tonight’s cast',
  soundOn: 'TV sound: on',
  soundOff: 'TV sound: off',

  netCheckWarn: 'Heads up: this table’s connection looks one-way from here. If friends can’t join, start a new game on different table settings (add #r=… to the address).',

  aiSetup: 'AI host…',
  aiOn: 'AI host: on',
  aiGenerating: 'The AI host is writing tonight’s deck…',
  aiDeckReady: 'Tonight’s deck is bespoke. Nobody has seen these before.',
  roastTitle: 'THE CLOSING ROAST',

  howtoTitle: 'How to play',
  howtoWhat: 'Four rounds, then a finale.',
  howtoStep1: 'Each round you answer a prompt with a secret.',
  howtoStep2: 'You’re matched with one other player.',
  howtoStep3: 'You and your match each secretly pick one: SHARE your secret with them, or HOLD it back.',
  howtoObjectiveHead: 'The goal',
  howtoObjective: 'Most points at the end wins.',
  howtoRoundHead: 'The scoring',
  howtoBothShare: 'Both share',
  howtoBothShareOut: 'You trade secrets and read them in private. 3 points each.',
  howtoOneShares: 'One shares, one holds',
  howtoOneSharesOut: 'The holder reads it and gives nothing back. 5 points for them, 1 for the sharer.',
  howtoBothHold: 'Both hold',
  howtoBothHoldOut: 'Nothing changes hands. 1 point each.',
  howtoFinaleHead: 'The finale',
  howtoFin1: 'One move each. Lowest score goes first.',
  howtoFin2: 'Pick a secret you collected during the rounds.',
  howtoFin3: 'Use it one of three ways: demand 3 points from its owner (“pay up or everyone hears it”), read it out to the room for 1 point, or keep it quiet for 2.',
  howtoStrategyHead: 'How to win',
  howtoTip1: 'Holding pays more, but it’s public — and people remember when the finale comes.',
  howtoTip2: 'Sharing pays less now, but every secret you collect is a move you get to make later.',
  howtoTip3: 'Write secrets that are fun to trade but safe to say out loud — they might be.',
  howtoTip4: 'Rounds 2 and 4 pair you with the person you came with.',
  howtoTip5: 'Behind? The finale goes last place first — comebacks are built in.',
  briefTitle: 'While you wait — tonight, in brief',
  briefMore: 'Full rules and strategy live behind the ? button, on every screen.',
  close: 'Close',
}

// MC settings copy lives OUTSIDE the scanned UI object: spec §14.1 requires
// this screen to say exactly where the API key lives, which necessarily uses
// protocol vocabulary. It is host-only setup, reachable from the lobby —
// never shown during play — and is deliberately exempt from the banned-word
// scan (which covers the UI export above).
export const MC_UI = {
  title: 'AI Master of Ceremonies',
  intro: 'A generated, group-tuned night: bespoke prompts, live commentary, and a closing roast. The prewritten deck stays as the fallback — the game never stalls on the AI.',
  modeOff: 'Off',
  modeOffDesc: 'The prewritten deck and lines. Zero AI.',
  modeCommunity: 'Instant',
  modeCommunityDesc: 'One tap, nothing to set up — runs on a free public text service. Only public game info (names, choices, scores, and secrets already revealed to the room) is ever sent; unshared secrets never leave your phones.',
  modeProxy: 'This site’s AI',
  modeProxyDesc: 'Runs on this game’s own AI service. Nothing to set up.',
  modeByok: 'Advanced — your own Anthropic key',
  keyLabel: 'Anthropic API key',
  keyHint: 'The key lives in this phone’s localStorage, is used only from this phone, and never appears in game data or on the network — except to api.anthropic.com. Uses the low-cost claude-haiku-4-5 model; a full night costs about a cent.',
  contextLabel: 'About your group (optional)',
  contextPlaceholder: 'e.g. two couples, friends 20 years, one just retired, all love to cook',
  spiceLabel: 'Spice',
  spice1: '1 · Mild',
  spice2: '2 · Spicy',
  spice3: '3 · Scorching',
  avoidLabel: 'Topics to avoid (respected absolutely)',
  avoidPlaceholder: 'e.g. the divorce, money, health',
  save: 'Save',
  clear: 'Turn off + forget key',
  close: 'Close',
}

export const fill = (template, slots = {}) => {
  let s = template
  for (const [k, v] of Object.entries(slots)) s = s.split(`{${k}}`).join(v)
  return s
}
