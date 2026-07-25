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
  flavorTitle: 'Tonight’s menu',
  flavorMild: 'Innocent',
  flavorMildDesc: 'Guilty pleasures, tiny habits, harmless confessions. Nothing deep — the perfect first game.',
  flavorSpicy: 'Spicy',
  flavorSpicyDesc: 'Confessions with consequences. Friendships tested, lightly.',
  flavorScorching: 'Scorching',
  flavorScorchingDesc: 'Old flames, closed doors, and the questions you don’t ask at brunch.',
  flavorArc: 'The Arc',
  flavorArcDesc: 'Starts innocent, ends scorching — the night heats up like a real dinner.',
  practiceOn: 'Warm-up round: on',
  practiceOff: 'Warm-up round: off',
  practiceHint: 'One throwaway round with a mild prompt, so everyone learns the moves. Scores reset after.',
  botAdd: '+ Add a robot guest',
  botHint: 'Robot guests fill empty chairs so you can try a night solo — they answer, trade, and blackmail all on their own.',

  joinTitle: 'Pull up a chair',
  joinNamePlaceholder: 'Your first name',
  joinButton: 'Sit down',
  joinWaitHost: 'You’re in. Watch the table — {host} starts the night.',

  roundLabel: 'Round {n}',
  practiceLabel: 'Warm-up — nothing counts',
  coachPrompt: 'Warm-up: write something mild and true, just to learn the moves.',
  coachDilemma: 'This choice is the whole game. Read your friend’s face, then decide what kind of friend you are. The numbers below are open just this once — in the real rounds they hide behind “How the scoring works.”',
  coachOutcome: 'Watch the points land. In the real rounds, every secret someone collects becomes leverage for the finale.',
  debriefTitle: 'That was the warm-up.',
  debriefBody: 'That’s the whole game: answer, get matched, share or hold, live with it. Four real rounds now — then the blackmail finale, where collected secrets get used.',
  debriefReset: 'Scores are back to zero. The prompts get real.',
  promptYours: 'True secrets only — and only as spicy as you can survive out loud. It stays yours until you choose otherwise.',
  promptPlaceholder: 'Type your secret…',
  promptLock: 'Lock it in',
  promptLocked: 'Locked. Phones down.',
  delivering: 'Reaching the table… keep this screen open.',
  phonesDown: 'Phones down when done.',
  waitingOn: 'Waiting on {names}…',
  hostEveryoneIn: 'Everyone’s in →',
  hostRedraw: 'Redraw prompt',
  hostNext: 'Next →',
  hostForce: 'Resolve it — stragglers hold',

  pairingTitle: 'This round’s matchups',
  yourMatch: 'Your match this round: {name}',
  sittingOut: '{name} sits this one out. Judge freely, {name}.',

  dilemmaVs: 'You  ⇄  {name}',
  dilemmaStakes: 'Do you trust {name}? They’re deciding the same thing about you, right now.',
  dilemmaMath: 'How the scoring works',
  dilemmaCheat: 'Cooperate: {t} each · sneak while they share: {w} + their secret · both sneak: {l} each. Your choice.',
  stakesX2: '×2 STAKES',
  stakesX3: '×3 STAKES — THE MONEY ROUND',
  heatUp: 'Turn it up 🌶️',
  starterLabel: 'Stuck? Steal one — make it yours:',

  dealTitle: 'You’re paired with {name}. Talk it out.',
  dealHint: 'Make your case out loud — plead, promise, bluff. Then everyone chooses in the dark.',
  dealPromise: 'I’ll share 🤝',
  dealPromised: '🤝 You told the table you’ll share. Keep your word — or don’t.',
  dealTheirPromise: '🤝 {name} says they’ll share.',
  tvDeal: 'Talk it out. Choices come when the clock runs dry.',
  promiseBroken: '{name} promised to share — then held.',
  dilemmaShare: 'SHARE',
  dilemmaHold: 'HOLD',
  dilemmaLockedIn: 'Locked in. Eyes on {name}…',
  dilemmaSit: 'You’re sitting out. Enjoy the show.',

  bowlOn: 'The bowl: on',
  bowlOff: 'The bowl: off',
  bowlHint: 'Anyone can drop a copy of their confession in the bowl. After each round one gets drawn and read to the room, and the table guesses whose it is. Nerve pays: +2 if yours is drawn, +1 for a right guess.',
  bowlDrop: '🥣 Drop a copy in the bowl',
  bowlIn: '🥣 It’s in the bowl. If it’s drawn, the room hears it — and you collect +2 for the nerve.',
  bowlKicker: 'FROM THE BOWL',
  bowlFishing: 'Fishing one out of the bowl…',
  bowlWho: 'Who wrote it?',
  bowlYours: 'It’s yours. Eyes steady. Look innocent.',
  bowlGuessed: 'Guess is in. Watching the table…',
  bowlReveal: 'It was {name}.',
  bowlPaid: '{name} collects +2 for the nerve. Right guesses collect +1.',
  tvGuessing: '{n} still guessing…',

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
  finaleIntroBody: 'Everything you collected tonight is leverage — and you can spend all of it. Last place goes first: squeeze a friend, burn them for fun, or shut the vault for profit. The vault ends your turn; the knives don’t.',
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
  finaleAgain: '{name} isn’t done — another card comes out.',
  finaleHolds: '{name} still holds {n}.',
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
  awardsTitle: 'THE AWARDS',
  awardOpenBook: 'The Open Book — shared the most',
  awardVault: 'The Iron Vault — gave up nothing',
  awardSnake: 'Snake of the night — promised, then held',
  awardBold: 'Boldest pen — fed the bowl and owned it',
  recapTitle: 'HOW THE NIGHT WENT',
  storyBetrayal: 'R{r}: {winner} took {loser}’s secret and gave nothing back.',
  storyBetrayalBig: 'R{r}, stakes ×{m}: {winner} took {loser}’s secret and gave nothing back.',
  storyPromise: 'R{r}: {name} promised to share — then held.',
  storyBowl: 'R{r}: {name} fed the bowl and the room heard every word.',
  storyBurn: '{by} burned {owner}’s secret, just to watch it go.',
  storyExposed: '{by} squeezed {owner}, got refused, and told the room anyway.',
  storyPaid: '{target} paid {blackmailer} for silence. The room noticed.',
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
  reconnecting: '📡 Rough air — the last card is still reaching the table. It keeps trying on its own.',

  aiSetup: 'AI host…',
  aiOn: 'AI host: on',
  aiGenerating: 'The AI host is writing tonight’s deck…',
  aiDeckReady: 'Tonight’s deck is bespoke. Nobody has seen these before.',
  roastTitle: 'THE CLOSING ROAST',

  howtoTitle: 'How to play',
  howtoWhat: 'Four rounds, then a finale.',
  howtoStep1: 'Each round you answer a prompt with a secret — a true one.',
  howtoStep2: 'You’re matched with one other player.',
  howtoStep3: 'You and your match each secretly pick one: SHARE your secret with them, or HOLD it back.',
  howtoObjectiveHead: 'The goal',
  howtoObjective: 'Most points at the end wins.',
  howtoRoundHead: 'The choice',
  howtoBothShare: 'Cooperate',
  howtoBothShareOut: 'You both share: 3 points each, and you each get to read the other’s secret.',
  howtoOneShares: 'Or be sneaky',
  howtoOneSharesOut: 'Hold yours and hope they share theirs: 5 points and their secret, giving nothing back. They get 1.',
  howtoBothHold: 'But beware',
  howtoBothHoldOut: 'If you both get sneaky, you each walk away with just 1.',
  howtoChoice: 'So — cooperate for a steady 3, or gamble for 5 and a secret? Your choice.',
  howtoFinaleHead: 'The finale',
  howtoFin1: 'One move each. Lowest score goes first.',
  howtoFin2: 'Pick a secret you collected during the rounds.',
  howtoFin3: 'Use it one of three ways: demand 3 points from its owner (“pay up or everyone hears it”), read it out to the room for 1 point, or keep it quiet for 2.',
  howtoStrategyHead: 'How to win',
  howtoTip1: 'If you both always share, you tie. Holding while they share is the biggest score in the game (5) — but it’s public: a 🗡 goes by your name and the table remembers.',
  howtoTip2: 'Sharing pays less up front, but every secret you collect is a finale move — extortion needs ammunition, and a night of holding leaves you with none.',
  howtoTip3: 'Write secrets that are fun to trade but safe to say out loud — they might be.',
  howtoTip4: 'Rounds 2 and 4 match you with the person sitting beside you (seats 1+2, 3+4) — that’s the couples round, not a random draw.',
  howtoTip5: 'Behind? The finale goes last place first — comebacks are built in.',
  howtoTip6: 'The stakes climb: round 3 pays double, round 4 triple. Behind early is not out — bold late is everything.',
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

// Robot guests: stand-in players the host can seat to try a night solo.
// Names and canned secrets are player-visible, so they live here and go
// through the banned-word scan like everything else.
export const BOT = {
  names: ['Pixel', 'Nova', 'Sprocket', 'Widget', 'Echo'],
  lines: [
    'I clap when the plane lands. Every time.',
    'I have been watering a plastic plant for two years.',
    'I say "you too" when waiters tell me to enjoy my meal.',
    'I practice my award-acceptance speech in the shower.',
    'I once lost a staring contest to a cat.',
    'I have never actually read the terms and conditions.',
    'I wave back at people who were waving at someone behind me.',
    'My browser has two hundred tabs open and I fear every one of them.',
    'I eat the crust first so the best bite comes last.',
    'I pretend to check my pockets when someone asks for change.',
    'I rehearse my coffee order in line and still get it wrong.',
    'I keep a fancy candle I refuse to ever actually burn.',
  ],
}

export const fill = (template, slots = {}) => {
  let s = template
  for (const [k, v] of Object.entries(slots)) s = s.split(`{${k}}`).join(v)
  return s
}

// Recap rendering: a state.story event → one line, from the scanned
// templates above. Shared by the phone and the stage.
export const AWARD_TITLES = {
  openBook: UI.awardOpenBook, vault: UI.awardVault, snake: UI.awardSnake, bold: UI.awardBold,
}
export const storyLine = (e) => {
  if (e.t === 'betrayal') return fill(e.m > 1 ? UI.storyBetrayalBig : UI.storyBetrayal,
    { r: String(e.r), m: String(e.m), winner: e.winner, loser: e.loser })
  if (e.t === 'promiseBroken') return fill(UI.storyPromise, { r: String(e.r), name: e.name })
  if (e.t === 'bowl') return fill(UI.storyBowl, { r: String(e.r), name: e.name })
  if (e.t === 'burn') return fill(UI.storyBurn, { by: e.by, owner: e.owner })
  if (e.t === 'exposed') return fill(UI.storyExposed, { by: e.by, owner: e.owner })
  if (e.t === 'paid') return fill(UI.storyPaid, { target: e.target, blackmailer: e.blackmailer })
  return ''
}
