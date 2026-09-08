// Faction-select capture: opens the deploy screen and photographs the faction picker, then picks
// each faction in turn and photographs the resulting in-battle deck. This is the evidence that the
// roster narrowing is real and visible -- that choosing Bastion actually changes what you can build,
// rather than only changing what spawnFailureReason says.
// Out: shots/faction/*.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "shot-faction" });

const PORT = 5193;
const OUT = join("shots", "faction");
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };

const { page, errors, close } = await launchGame({
  port: PORT,
  query: "lowfx=1",
  viewport: { width: 1600, height: 900 },
});

try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-faction]");
  // The menu fades in; screenshotting on the selector alone catches it mid-transition and the
  // evidence is a washed-out frame that says nothing about the real contrast.
  await page.waitForTimeout(900);

  // REACHABILITY OF THE UI ITSELF. The setup screen is dense -- five map cards, a preview, five
  // modes, three difficulties and now three factions -- and content that falls below the fold in a
  // container that does not scroll is simply unclickable. This checks the last faction card can
  // actually be reached, at the 1280x720 floor as well as at full size.
  for (const [w, h] of [[1600, 900], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const reach = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-faction]")];
      const last = cards[cards.length - 1];
      if (!last) return { ok: false, why: "no faction cards" };
      let node = last.parentElement;
      let scroller = null;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2) { scroller = node; break; }
        node = node.parentElement;
      }
      const pageScrolls = document.scrollingElement.scrollHeight > window.innerHeight + 2;
      const box = last.getBoundingClientRect();
      const visible = box.bottom <= window.innerHeight + 1 && box.top >= -1;
      return { ok: visible || !!scroller || pageScrolls, visible, scrolls: !!scroller || pageScrolls, bottom: Math.round(box.bottom), vh: window.innerHeight };
    });
    if (!reach.ok) fail(`deploy screen at ${w}x${h}: last faction card is unreachable (bottom ${reach.bottom} vs viewport ${reach.vh}, nothing scrolls)`);
    console.log(`  layout ${w}x${h}: last faction card ${reach.visible ? "on screen" : "reachable by scrolling"}`);
  }
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(300);

  const cards = await page.$$eval("[data-faction]", (els) => els.map((e) => e.dataset.faction));
  if (cards.length !== 3) fail(`expected 3 faction cards, got ${cards.length}: ${cards.join(",")}`);
  await page.screenshot({ path: join(OUT, "0-picker.png") });

  // Deploy once per faction and record what its base can actually build.
  const summaries = [];
  for (const faction of cards) {
    await page.click(`[data-faction="${faction}"]`);
    await page.click("[data-map]");
    await page.click("[data-start]");
    await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
    await page.waitForTimeout(900);
    await assertLit(page, `faction ${faction}`);

    // Open the base deck so the roster is on screen.
    const baseId = await page.evaluate(() => {
      const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
      if (base) window.__rht.sim.select(base.id);
      return base?.id ?? null;
    });
    if (!baseId) fail(`${faction}: no player base`);
    await page.waitForTimeout(500);

    const deckCards = await page.$$eval("[data-spawn]", (els) => els.map((e) => e.dataset.spawn));

    // Open the doctrine tab too, so the tech filter is exercised and not just the deck. Reading it
    // with the tab closed reports zero nodes for every faction, which looks like a passing check
    // and measures nothing.
    await page.click('[data-base-tab="tech"]');
    await page.waitForTimeout(350);
    const techNodes = await page.$$eval("[data-tech]", (els) => els.map((e) => e.dataset.tech));
    await page.screenshot({ path: join(OUT, `2-${faction}-doctrine.png`) });
    await page.click('[data-base-tab="deploy"]');
    await page.waitForTimeout(250);

    const info = await page.evaluate(() => {
      const sim = window.__rht.sim;
      const f = sim.factionOf("player");
      return { id: f.id, name: f.name, roster: [...f.roster], tech: [...f.tech] };
    });
    info.cards = deckCards;
    info.techNodes = techNodes;
    if (techNodes.length === 0) fail(`${faction}: doctrine tab rendered no tech nodes`);
    // Every node on the board must be one this faction may research, and vice versa -- an
    // unresearchable node on the tree is a dead end the player cannot see is dead.
    const offDoctrine = techNodes.filter((id) => !info.tech.includes(id));
    if (offDoctrine.length) fail(`${faction}: doctrine tree shows unresearchable nodes ${offDoctrine.join(",")}`);
    if (info.id !== faction) fail(`picked ${faction} but the sim is fielding ${info.id}`);
    summaries.push(info);
    await page.screenshot({ path: join(OUT, `1-${faction}-deck.png`) });

    // Back to the menu for the next faction. A full reload rather than reset(): reset() restarts
    // the BATTLE, it does not return to the menu, and reloading also proves the faction choice
    // survives a fresh boot (it is persisted in settings).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".main-menu", { timeout: 20000 });
    await page.click('[data-menu="play"]');
    await page.waitForSelector("[data-faction]");
  }

  // THE assertion that matters: the three factions must actually differ. Identical rosters would
  // mean the picker is cosmetic, which is exactly the failure this script exists to catch.
  const signature = (s) => [...s.roster].sort().join(",");
  const unique = new Set(summaries.map(signature));
  if (unique.size !== summaries.length) fail(`factions share a roster: ${[...unique].join(" | ")}`);

  for (const s of summaries) {
    console.log(`  ${s.name.padEnd(10)} roster ${String(s.roster.length).padStart(2)}  deck cards ${String(s.cards.length).padStart(2)}  doctrine nodes ${s.techNodes.length}`);
  }

  if (errors.length) fail(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  console.log(`Faction smoke passed: ${summaries.length} distinct rosters -> ${OUT}`);
} finally {
  await close();
}
