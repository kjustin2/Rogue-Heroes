import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { endTurnAndSettle, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "smoke-economy" });

const PORT = 5176;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });

const { page, errors, close } = await launchGame({ port: PORT, query: "lowfx=1" });

try {
  // Navigate the landing menu into a battle (Start Game -> Deploy) so HUD clicks land.
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-start]");
  await page.click("[data-start]");
  await page.waitForSelector(".menu-screen", { state: "detached", timeout: 4000 }).catch(() => {});

  const baseId = await page.evaluate(() => {
    window.__rht.reset();
    // Grant a comfortable treasury so the harness exercises mechanics, not the price curve.
    window.__rht.sim.economy.set("player", 2500);
    const base = window.__rht.sim.entities.find((entity) => entity.kind === "base" && entity.team === "player");
    return base ? base.id : null;
  });
  if (!baseId) throw new Error("No player base in scenario");
  const startMoney = await page.evaluate(() => window.__rht.money("player"));

  // 1) Deploy a Recruit straight from the base, through the real HUD command deck.
  await page.click(`[data-select="${baseId}"]`);
  try {
    await page.waitForSelector('[data-spawn="soldier"]', { timeout: 4000 });
  } catch {
    const diag = await page.evaluate(() => ({
      selectedId: window.__rht.sim.selectedId,
      phase: window.__rht.sim.phase,
      commandbar: document.querySelector(".commandbar")?.textContent?.slice(0, 300),
    }));
    throw new Error(`Base command deck never appeared: ${JSON.stringify(diag)}`);
  }
  const fieldBefore = await page.evaluate(() => window.__rht.sim.fieldUnitCount("player"));
  // First click ARMS the placement ring (nothing spent), then the chosen ground point fields it.
  await page.click('[data-spawn="soldier"]');
  const armed = await page.evaluate(() => ({ pending: window.__rht.sim.pendingDeploy, money: window.__rht.money("player") }));
  if (armed.pending !== "soldier") throw new Error(`Deploy card did not arm placement: ${JSON.stringify(armed)}`);
  if (armed.money !== startMoney) throw new Error(`Arming placement must not spend: ${JSON.stringify({ startMoney, ...armed })}`);
  const chosen = await page.evaluate(() => {
    const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    const point = { x: base.position.x + 3.5, z: base.position.z - 2 };
    return { ok: window.__rht.queueDeployAt("soldier", point), point };
  });
  if (!chosen.ok) throw new Error(`Placed deploy rejected: ${JSON.stringify(chosen)}`);
  const afterDeploy = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    return {
      money: window.__rht.money("player"),
      field: sim.fieldUnitCount("player"),
      baseCp: base.commandPoints,
      spawned: sim.entities.some((e) => e.id.startsWith("p-spawn-")),
    };
  });
  if (!afterDeploy.spawned) throw new Error(`Deploy did not place a troop: ${JSON.stringify(afterDeploy)}`);
  const landed = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.id.startsWith("p-spawn-")).position);
  if (Math.hypot(landed.x - chosen.point.x, landed.z - chosen.point.z) > 2.2) throw new Error(`Recruit not fielded at the chosen point: ${JSON.stringify({ landed, chosen })}`);
  if (afterDeploy.field !== fieldBefore + 1) throw new Error(`Field count did not grow: ${JSON.stringify({ fieldBefore, ...afterDeploy })}`);
  if (afterDeploy.money >= startMoney) throw new Error(`Deploy did not spend money: ${JSON.stringify({ startMoney, ...afterDeploy })}`);
  if (afterDeploy.baseCp !== 0) throw new Error(`Deploy did not spend the base CP: ${JSON.stringify(afterDeploy)}`);

  const moneyBar = await page.evaluate(() => document.querySelector(".money-bar")?.textContent ?? "");
  if (!/\d/.test(moneyBar)) throw new Error(`Missing treasury bar in HUD: "${moneyBar}"`);

  // 2) Next turn: upgrade income from the base.
  await endTurnAndSettle(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.click('[data-base-tab="upgrade"]'); // base deck is tabbed now
  await page.waitForSelector('[data-base-upgrade="income"]', { timeout: 4000 });
  const incomeBefore = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").incomeLevel ?? 0);
  const moneyBeforeIncome = await page.evaluate(() => window.__rht.money("player"));
  await page.click('[data-base-upgrade="income"]');
  const afterIncome = await page.evaluate(() => {
    const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    return { incomeLevel: base.incomeLevel ?? 0, money: window.__rht.money("player") };
  });
  if (afterIncome.incomeLevel !== incomeBefore + 1) throw new Error(`Income upgrade did not raise the tier: ${JSON.stringify({ incomeBefore, ...afterIncome })}`);
  if (afterIncome.money >= moneyBeforeIncome) throw new Error(`Income upgrade did not spend money: ${JSON.stringify({ moneyBeforeIncome, ...afterIncome })}`);

  // 3) Next turn: research a tech-tree doctrine to unlock new troops.
  await endTurnAndSettle(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.click('[data-base-tab="tech"]');
  await page.waitForSelector('[data-tech="assault"]', { timeout: 4000 });
  await page.click('[data-tech="assault"]');
  const techAfter = await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").unlockedTech ?? []).includes("assault"));
  if (!techAfter) throw new Error("Research did not unlock the Assault doctrine");

  // 4) Next turn: the now-unlocked Striker can be deployed.
  await endTurnAndSettle(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.click('[data-base-tab="deploy"]'); // switch back from the tech tab
  await page.waitForSelector('[data-spawn="striker"]:not([data-disabled="true"])', { timeout: 4000 });
  // Quick deploy: a second click on the armed card drops the troop at the base's own spot.
  await page.click('[data-spawn="striker"]');
  if ((await page.evaluate(() => window.__rht.sim.pendingDeploy)) !== "striker") throw new Error("Striker card did not arm placement");
  await page.click('[data-spawn="striker"]');
  const striker = await page.evaluate(() => window.__rht.sim.entities.some((e) => e.kind === "striker" && e.team === "player" && e.id.startsWith("p-spawn-")));
  if (!striker) throw new Error("Tech-unlocked Striker did not deploy");

  await page.screenshot({ path: join(OUT, "8-economy-deploy.png") });

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  const finalMoney = await page.evaluate(() => window.__rht.money("player"));
  console.log(`Economy passed: deployed troops, researched Assault, upgraded income, treasury $${finalMoney}`);
} finally {
  await close();
}
