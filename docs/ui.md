# UI language: toon chrome and the rules that keep it readable

The DOM HUD and menus. `smoke:ui-audit` enforces the geometric rules.

## UI language: TOON (2026-09-18)

The DOM chrome speaks the same language as the toon render: **inked outlines** (3px panels, 2px
controls — `--ink`), **flat opaque fills** (`--paper` / `--paper-hi` / `--paper-lo`), **hard offset
ink shadows** (`--drop-sm/--drop/--drop-lg`), a **one-step shade band** at a panel's foot
(`--shade`), **segmented meters** (ink ticks over every bar), cream text on slate, and ONE saturated
accent per surface — amber = the action (End Turn, active tab, toasts), cyan = the player /
confirm / "on", red = the threat, green = OK. All of it is the `TOON UI LAYER` at the end of
`style.css`: tokens on `:root` plus per-class overrides; the legacy `--line/--panel/--cyan/--amber`
tokens are remapped there so the older layers inherit it. Rules that fall out of it:

- **No gradients, no `backdrop-filter`, no blurred glows, no sheen/glint/bracket animations** on
  UI. Depth is an offset solid; state is a fill or an outline colour. The "Blizzard chrome" layer
  that did the opposite was deleted, not overridden — do not bring rivets back.
- **The action currency is AP (action points)** in everything a player reads (owner 2026-09-24: "CP can be
  confusing as an acronym for gamers"). Code keeps `commandPoints` / `maxCommandPoints` internally; never put
  "CP" or "command point" in a string, tooltip, log line or doc the player can see.
- **FEWEST WORDS** (owner 2026-09-24: "minimal UIs and less words is more clear"). On-screen text is a label, a
  number or a 2-5 word state ("Place in the green ring.", "Resolving…", "Done. Space ends the turn."); anything
  that EXPLAINS a rule lives in a hover `data-tip` or the tutorial, never in an always-visible paragraph. Cards
  and overlays carry no instructions players learn by playing (the hotseat handoff is Turn / Player / faction /
  Ready, plus recon/research news only). Never repeat what a header or the board already shows.
- **Menus = title + buttons.** The cosmetic callsign line was removed from the title screen; it is
  still equipped in the Armory. Difficulty is Easy / Normal / Hard (Recruit / Veteran / Elite
  collided with the veteran ranks and the Recruit unit). The vocabulary is **turn**, never round.
- **The Skirmish set-up is a STEP FLOW** (owner 2026-09-24: the one-page version "was overwhelming"):
  Battlefield → Sides → Rules, a stepper in the header, a summary on Rules, and a footer of Back / Next.
  **NO SKIPPING THE PICKS** (owner 2026-10-01: "remove the deploy now button ... users should always have
  to pick"): `[data-start]` (Deploy to Battle) exists ONLY on the Rules step, and a stepper tab opens only
  a step already reached. Smokes walk the flow: click `[data-step-go="next"]` until the step, then act
  (the `page.evaluate` walker in each set-up smoke; `toStep(n)` in `shots-gpu.cjs`). Every STEP fits 1280×720
  (`smoke:ui-audit` one-screen check per step). Settings is three tabs: Display & Sound / Gameplay / Controls.
- **Right-click is Back** everywhere (armed attack, placement, strike): it calls the same handler as Escape.
  Queued-order chips never repeat their title as detail text; every chip meets the 12px floor; long map names wrap in
  the top-right stack; the end screen's medal toasts sit at the very top. `smoke:ui-audit` covers every map's battle
  HUD, the gunship bomb panel and every Achievements page.
- **The base's Defenses / Support decks show everything the faction can ever field there**: research-locked
  pieces stay visible with 🔒 and the doctrine that opens them (never a dead button that arms and then
  refuses), in the faction's own order (starter first). A refused pick or placement click says WHY in a
  toast (`refused()` in main.ts) — the reason is the sim's newest log line.
- **Every choice on a set-up page fits one 1280×720 screen in reading order, and nothing sits under
  a sticky bar.** The old one-page layout was Map + Preview left, Faction → Mode → Difficulty right, Deploy
  last; a card with a CTA footer is a header / scrolling-body / footer grid, never a sticky strip
  laid over its own content (that is how the faction pick got "hidden behind Deploy").
  `shots:gpu mapselect` is the repro at the three widths that have bitten this repo.
- **Tooltips hang OUTSIDE the panel they came from** (above a bottom panel, beside a side rail —
  `positionTooltip` in hud.ts), are ≤2 lines at 420px, and never repeat the card's own name ("Striker
  on cooldown" on the Striker card is "On cooldown"). The listeners live on `<body>` so menu
  `data-tip`s work; any pointerdown dismisses; the tooltip is `data-allow-overlap`.
- **Everything a menu turns on is DERIVED FROM THE DOM** (`syncHudInert`, run by a MutationObserver on
  every top-level screen change): `menus-open` (the dark backdrop) and `stage.setLowCost` while a menu
  screen is up, HUD `inert` while a menu or pause/edit overlay is. Never switch such state on in
  `mountScreen` and off in one close path — Settings' own Back left the backdrop over the battle
  ("everything kept its filter of brightness down", 2026-09-23). Toasts, the turn banner and the
  mission-intro rail hide under menus/overlays (CSS `:has`), the intro is cancelled by `cancelIntro()`
  on every battle start / main menu, and the deploy veil gives way to the hotseat handoff card.
  `smoke:ui-audit` walks battle → Settings/Controls → Back → Resume and asserts `__rht.menuState()`
  is clean (fault-injection proven). `AUDIT_ONLY=a,b AUDIT_VIEWPORT=1280` re-checks one screen fast.
- **Deck cards are two rows** (`.part-options > .btn.confirm`): name (wraps, NEW badge beside it), then
  price/status. One nowrap row pushed prices wholly out of the card; the audit's `clipped` rule now
  reports a WHOLLY clipped element too (it skipped them before) and is fault-injected with a pushed price.
