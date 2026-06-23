import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = Number(process.env.SMOKE_PORT ?? 5175);
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(OUT)) {
  if (file.endsWith(".png")) unlinkSync(join(OUT, file));
}

const serverLog = [];
let server = null;

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  }

  await waitForServer(URL, 20000);
  const executablePath = findChromium();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar");
  // Navigate the landing menu into a battle (Start Game -> Deploy).
  const playButton = await page.$('[data-menu="play"]');
  if (playButton) {
    await playButton.click();
    await page.waitForSelector("[data-start]", { timeout: 4000 }).catch(() => {});
    const startButton = await page.$("[data-start]");
    if (startButton) await startButton.click();
    await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  }
  await assertCanvasPainted(page, "desktop command");
  await assertHudLayout(page, "desktop command", [".topbar", ".roster", ".commandbar", ".log"]);
  await assertNoOverlap(page, "desktop command log and order bar", ".log.compact-log:not(.expanded)", ".commandbar", 8);
  const defaultDrawerState = await page.evaluate(() => ({
    targetPanel: Boolean(document.querySelector(".target-panel")),
    unitDetail: Boolean(document.querySelector(".unit-detail-panel")),
    commandWidth: document.querySelector(".commandbar")?.getBoundingClientRect().width,
    viewportRight: window.innerWidth,
  }));
  if (defaultDrawerState.targetPanel || defaultDrawerState.unitDetail) {
    throw new Error(`Default command view opens too many drawers: ${JSON.stringify(defaultDrawerState)}`);
  }
  if ((defaultDrawerState.commandWidth ?? 0) > 1000) {
    throw new Error(`Command bar should stay compact by default: ${JSON.stringify(defaultDrawerState)}`);
  }
  const initialRenderDebug = await page.evaluate(() => window.__rht.renderDebug());
  if (initialRenderDebug.unitMarkers < 4) {
    throw new Error(`Expected persistent overhead unit markers for map readability: ${JSON.stringify(initialRenderDebug)}`);
  }
  const commandDeckState = await page.evaluate(() => ({
    layout: Boolean(document.querySelector(".command-layout")),
    actionDeck: Boolean(document.querySelector(".action-deck")),
    detailDeck: Boolean(document.querySelector(".detail-deck")),
    flowCount: document.querySelectorAll(".flow-steps span").length,
    sectionCount: document.querySelectorAll(".section-label").length,
    accuracyPanels: document.querySelectorAll(".accuracy-panel").length,
    commandHeight: document.querySelector(".commandbar")?.getBoundingClientRect().height,
    commandText: document.querySelector(".commandbar")?.textContent,
    actionLabels: Array.from(document.querySelectorAll("[data-order-action] strong")).map((node) => node.textContent?.trim()),
  }));
  if (!commandDeckState.layout || !commandDeckState.actionDeck || commandDeckState.detailDeck) {
    throw new Error(`Command deck is not organized into action/detail sections: ${JSON.stringify(commandDeckState)}`);
  }
  if (commandDeckState.flowCount || commandDeckState.sectionCount || commandDeckState.accuracyPanels) {
    throw new Error(`Command deck should be condensed without flow labels or repeated accuracy panels: ${JSON.stringify(commandDeckState)}`);
  }
  for (const label of ["1. Move", "2. Shoot", "3. Ram"]) {
    if (!commandDeckState.actionLabels.includes(label)) throw new Error(`Missing organized action label ${label}: ${JSON.stringify(commandDeckState)}`);
  }
  for (const hidden of ["4. Crouch", "4. Strike"]) {
    if (commandDeckState.actionLabels.includes(hidden)) throw new Error(`Tank command deck exposed impossible action ${hidden}: ${JSON.stringify(commandDeckState)}`);
  }
  if (typeof commandDeckState.commandHeight === "number" && commandDeckState.commandHeight > 190) {
    throw new Error(`Default command bar should stay compact: ${JSON.stringify(commandDeckState)}`);
  }
  if (commandDeckState.commandText?.includes("CP ready")) {
    throw new Error(`Default command bar should not repeat selected-unit ready text: ${JSON.stringify(commandDeckState)}`);
  }
  await page.screenshot({ path: join(OUT, "1-command.png") });

  await page.locator('[data-select="p-soldier-1"]').click();
  const selectedDrawerState = await page.evaluate(() => ({
    targetPanel: Boolean(document.querySelector(".target-panel")),
    unitDetail: Boolean(document.querySelector(".unit-detail-panel")),
    commandText: document.querySelector(".commandbar")?.textContent,
    detailDeck: Boolean(document.querySelector(".detail-deck")),
  }));
  if (selectedDrawerState.targetPanel || selectedDrawerState.unitDetail || selectedDrawerState.detailDeck || selectedDrawerState.commandText?.includes("CP ready")) {
    throw new Error(`Selecting a unit should keep details closed and focus the action flow: ${JSON.stringify(selectedDrawerState)}`);
  }
  await page.mouse.click(820, 90);
  await page.waitForFunction(() => !window.__rht.sim.selectedId && !document.querySelector(".commandbar")?.textContent?.includes("Rook"));
  const deselectedState = await page.evaluate(() => ({
    selectedId: window.__rht.sim.selectedId,
    commandText: document.querySelector(".commandbar")?.textContent,
  }));
  if (deselectedState.commandText?.includes("Move") || deselectedState.commandText?.includes("Shoot")) {
    throw new Error(`Ground click should deselect and clear unit actions: ${JSON.stringify(deselectedState)}`);
  }
  await page.locator('[data-select="p-soldier-1"]').click();
  await page.locator('[data-order-action="move"]').hover();
  await page.waitForSelector(".hud-tooltip.visible");
  const moveTooltip = await page.locator(".hud-tooltip.visible").textContent();
  if (!moveTooltip?.includes("click ground or a cover object")) {
    throw new Error(`Move tooltip is unclear or clipped: ${moveTooltip}`);
  }
  await assertHudLayout(page, "desktop hover tooltip", [".hud-tooltip.visible"]);
  await page.screenshot({ path: join(OUT, "2-hover-help.png") });

  await page.locator('[data-order-action="shoot"]').click();
  await page.waitForSelector(".target-panel");
  const targetDrawerState = await page.evaluate(() => ({
    title: document.querySelector(".target-panel h2")?.textContent,
    closeButton: Boolean(document.querySelector('[data-command="close-target"]')),
    hostileCount: document.querySelectorAll(".target-panel .target-chip").length,
  }));
  if (!targetDrawerState.title?.includes("Pick Target") || !targetDrawerState.closeButton || targetDrawerState.hostileCount < 2) {
    throw new Error(`Shoot action did not open a clear closable target drawer: ${JSON.stringify(targetDrawerState)}`);
  }
  await page.locator('[data-command="close-target"]').click();
  await page.waitForFunction(() => !document.querySelector(".target-panel"));
  await page.locator('[data-order-action="shoot"]').click();
  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="rifle"]').click();
  await page.locator('[data-confirm="shoot"]').click();
  await page.waitForSelector(".undo-order");
  const queuedState = await page.evaluate(() => ({
    selectedId: window.__rht.sim.selectedId,
    orders: window.__rht.sim.orders.map((order) => ({ id: order.id, actorId: order.actorId, kind: order.kind, targetPartId: order.targetPartId })),
    cp: window.__rht.sim.entity("p-soldier-1")?.commandPoints,
    commandText: document.querySelector(".commandbar")?.textContent,
    chipCount: document.querySelectorAll(".queued-chip").length,
    actions: Array.from(document.querySelectorAll("[data-order-action]")).map((el) => ({
      action: el.getAttribute("data-order-action"),
      disabled: el.getAttribute("data-disabled"),
    })),
  }));
  if (queuedState.selectedId !== "p-soldier-1" || queuedState.orders.length !== 1 || queuedState.orders[0].actorId !== "p-soldier-1") {
    throw new Error(`Expected Rook queued order, got ${JSON.stringify(queuedState)}`);
  }
  if (queuedState.cp !== 1 || queuedState.chipCount !== 1 || queuedState.commandText?.includes("queued 1 order")) {
    throw new Error(`Queued order was not clear or did not spend CP: ${JSON.stringify(queuedState)}`);
  }
  for (const action of ["move", "shoot", "defend"]) {
    const state = queuedState.actions.find((item) => item.action === action);
    if (state?.disabled !== "false") throw new Error(`Expected ${action} to remain enabled with 1 CP: ${JSON.stringify(queuedState.actions)}`);
  }
  await page.screenshot({ path: join(OUT, "3-queued-undo.png") });

  await page.locator('[data-order-action="defend"]').click();
  await page.locator('[data-confirm="defend"]').click();
  await page.waitForFunction(() => window.__rht.sim.orders.length === 2 && window.__rht.sim.entity("p-soldier-1")?.commandPoints === 0);
  const multiOrderState = await page.evaluate(() => ({
    orders: window.__rht.sim.orders.map((order) => ({ id: order.id, kind: order.kind })),
    commandText: document.querySelector(".commandbar")?.textContent,
    chipCount: document.querySelectorAll(".queued-chip").length,
  }));
  if (!multiOrderState.orders.some((order) => order.kind === "shoot") || !multiOrderState.orders.some((order) => order.kind === "defend")) {
    throw new Error(`Expected shoot and defend orders, got ${JSON.stringify(multiOrderState)}`);
  }
  if (multiOrderState.chipCount !== 2 || multiOrderState.commandText?.includes("queued 2 orders")) {
    throw new Error(`Multi-order state was unclear: ${JSON.stringify(multiOrderState)}`);
  }

  await page.locator(".undo-order").first().click();
  await page.waitForFunction(() => window.__rht.sim.orders.length === 1 && window.__rht.sim.entity("p-soldier-1")?.commandPoints === 1);
  await page.locator(".undo-order").first().click();
  await page.waitForFunction(() => window.__rht.sim.orders.length === 0 && window.__rht.sim.entity("p-soldier-1")?.commandPoints === 2);
  await page.mouse.move(24, 24);
  await page.waitForFunction(() => !document.querySelector(".hud-tooltip.visible"));
  await page.locator('[data-select="p-soldier-1"]').click();
  await page.waitForFunction(() => !document.querySelector(".unit-detail-panel") && !document.querySelector(".target-panel"));
  const compactSelection = await page.evaluate(() => ({
    commandText: document.querySelector(".commandbar")?.textContent,
    detailButtons: document.querySelectorAll("[data-detail]").length,
    detailDeck: Boolean(document.querySelector(".detail-deck")),
  }));
  if (compactSelection.commandText?.includes("CP ready") || compactSelection.detailDeck || compactSelection.detailButtons < 3) {
    throw new Error(`Compact unit selection did not expose clear action/detail choices: ${JSON.stringify(compactSelection)}`);
  }
  await page.locator('[data-detail="p-soldier-1"]').click();
  await page.waitForSelector(".unit-detail-panel");
  const ownSelection = await page.evaluate(() => ({
    targetPanel: Boolean(document.querySelector(".target-panel")),
    commandText: document.querySelector(".commandbar")?.textContent,
    detailText: document.querySelector(".unit-detail-panel")?.textContent,
    closeButton: Boolean(document.querySelector('[data-command="close-unit-detail"]')),
    detailCard: Boolean(document.querySelector(".unit-detail-panel .detail-card")),
    roleBadges: document.querySelectorAll(".unit-detail-panel .role-badge").length,
    closeRect: document.querySelector('[data-command="close-unit-detail"]')?.getBoundingClientRect().toJSON(),
  }));
  if (ownSelection.targetPanel) {
    throw new Error(`Friendly unit details should not appear in the target panel: ${JSON.stringify(ownSelection)}`);
  }
  if (ownSelection.commandText?.includes("CP ready")) {
    throw new Error(`Command bar did not remain focused on the action flow: ${JSON.stringify(ownSelection)}`);
  }
  if (!ownSelection.detailText?.includes("Rook") || !ownSelection.detailText.includes("Legs") || !ownSelection.detailText.includes("24/24") || !ownSelection.closeButton) {
    throw new Error(`Details button did not expose closable side-panel part health: ${JSON.stringify(ownSelection)}`);
  }
  if (!ownSelection.detailCard || ownSelection.roleBadges < 4 || (ownSelection.closeRect?.width ?? 0) < 70 || (ownSelection.closeRect?.height ?? 0) < 28) {
    throw new Error(`Unit detail panel lost its professional readout or obvious close control: ${JSON.stringify(ownSelection)}`);
  }
  await page.mouse.move(820, 100);
  await page.waitForFunction(() => !document.querySelector(".hud-tooltip.visible"));
  await page.screenshot({ path: join(OUT, "4-unit-detail.png") });
  await page.locator('[data-command="close-unit-detail"]').click();
  await page.waitForFunction(() => !document.querySelector(".unit-detail-panel"));
  await page.screenshot({ path: join(OUT, "4-undone.png") });

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    api.sim.select("p-soldier-1");
    api.sim.queueMove({ x: -8, z: -1.6 });
    api.sim.queueMove({ x: -6.8, z: -0.8 });
  });
  await page.waitForFunction(() => window.__rht.sim.orders.length === 2 && document.querySelectorAll(".queued-chip").length === 2);
  const twoMoveState = await page.evaluate(() => ({
    commandText: document.querySelector(".commandbar")?.textContent,
    chipCount: document.querySelectorAll(".queued-chip").length,
    undoCount: document.querySelectorAll(".undo-order").length,
    commandHeight: document.querySelector(".commandbar")?.getBoundingClientRect().height,
    targetPanel: Boolean(document.querySelector(".target-panel")),
  }));
  if (twoMoveState.chipCount !== 2 || twoMoveState.undoCount !== 2 || twoMoveState.commandText?.includes("queued 2 orders")) {
    throw new Error(`Two move queue did not stay clear and undoable: ${JSON.stringify(twoMoveState)}`);
  }
  if (twoMoveState.targetPanel) {
    throw new Error(`Two move queue should not keep the target drawer open: ${JSON.stringify(twoMoveState)}`);
  }
  if (typeof twoMoveState.commandHeight === "number" && twoMoveState.commandHeight > 260) {
    throw new Error(`Two move queue blocks too much screen: ${JSON.stringify(twoMoveState)}`);
  }
  await assertHudLayout(page, "desktop two move compact queue", [".topbar", ".roster", ".commandbar"]);
  await page.screenshot({ path: join(OUT, "4-two-moves-compact.png") });
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);
  await page.evaluate(() => {
    for (const entity of window.__rht.sim.entities) {
      if (entity.team === "player") entity.commandPoints = 0;
    }
  });
  await page.waitForSelector(".all-orders-chip");
  const allOrdersState = await page.evaluate(() => ({
    chip: document.querySelector(".all-orders-chip")?.textContent,
    rosterClass: document.querySelector(".roster")?.className,
  }));
  if (!allOrdersState.chip?.includes("All set") || !allOrdersState.rosterClass?.includes("all-set")) {
    throw new Error(`Squad all-orders-set state is not visible: ${JSON.stringify(allOrdersState)}`);
  }
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const rook = api.sim.entity("p-soldier-1");
    if (rook) rook.stance = "crouched";
    api.sim.select("p-soldier-1");
  });
  await page.waitForSelector('.unit-card.crouched .stance-chip');
  const crouchUiState = await page.evaluate(() => ({
    chip: document.querySelector('.unit-card.crouched .stance-chip')?.textContent,
    cardText: document.querySelector('.unit-card.crouched')?.textContent,
  }));
  if (crouchUiState.chip !== "Crouched" || !crouchUiState.cardText?.includes("Rook")) {
    throw new Error(`Crouched squad indicator is not clear: ${JSON.stringify(crouchUiState)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const striker = api.sim.entity("p-striker-1");
    if (striker) {
      striker.position.x = -8;
      striker.position.z = 0;
      striker.commandPoints = 2;
    }
    api.sim.select("p-striker-1");
    api.sim.queueMove({ x: -4.8, z: 0 });
    api.setIntent("melee");
  });
  const projectedMeleeRange = await page.evaluate(() => window.__rht.sim.selectedActionRange());
  if (projectedMeleeRange?.kind !== "melee" || Math.abs((projectedMeleeRange.position?.x ?? 0) - -4.8) > 0.35) {
    throw new Error(`Melee range ring should originate from queued move destination: ${JSON.stringify(projectedMeleeRange)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const tank = api.sim.entity("p-tank-1");
    if (tank) {
      tank.position.x = -8;
      tank.position.z = 2;
      tank.commandPoints = 2;
    }
    api.sim.select("p-tank-1");
    api.sim.queueMove({ x: -5.9, z: 2 });
    api.setIntent("ram");
  });
  const projectedRamRange = await page.evaluate(() => window.__rht.sim.selectedActionRange());
  if (projectedRamRange?.kind !== "ram" || Math.abs((projectedRamRange.position?.x ?? 0) - -5.9) > 0.35) {
    throw new Error(`Ram range ring should originate from queued move destination: ${JSON.stringify(projectedRamRange)}`);
  }
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const sniper = api.sim.entity("p-sniper-1");
    if (sniper) {
      sniper.position.x = 8;
      sniper.position.z = 5;
    }
  });
  await page.locator('[data-select="p-sniper-1"]').click();
  await page.waitForTimeout(80);
  const cameraAfterRosterSelect = await page.evaluate(() => window.__rht.camera());
  if (Math.abs(cameraAfterRosterSelect.x - 8) > 0.35 || Math.abs(cameraAfterRosterSelect.z - 5) > 0.35) {
    throw new Error(`Selecting from squad roster should focus the map camera: ${JSON.stringify(cameraAfterRosterSelect)}`);
  }
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);

  const cameraBefore = await page.evaluate(() => window.__rht.camera());
  await page.keyboard.down("d");
  await page.waitForTimeout(360);
  await page.keyboard.up("d");
  const cameraAfterPan = await page.evaluate(() => window.__rht.camera());
  if (!(cameraAfterPan.x > cameraBefore.x + 0.4)) {
    throw new Error(`Expected WASD pan to move camera right: before=${JSON.stringify(cameraBefore)} after=${JSON.stringify(cameraAfterPan)}`);
  }
  const panRenderDebug = await page.evaluate(() => window.__rht.renderDebug());
  if (panRenderDebug.ghostedEntities.length) {
    throw new Error(`Plain WASD map panning should not tint/ghost battlefield textures: ${JSON.stringify(panRenderDebug)}`);
  }
  await page.mouse.wheel(0, -480);
  await page.waitForTimeout(80);
  const cameraAfterZoom = await page.evaluate(() => window.__rht.camera());
  if (!(cameraAfterZoom.zoom < cameraAfterPan.zoom)) {
    throw new Error(`Expected wheel zoom in to reduce camera distance: before=${JSON.stringify(cameraAfterPan)} after=${JSON.stringify(cameraAfterZoom)}`);
  }
  const cameraBeforeOrbit = await page.evaluate(() => window.__rht.camera());
  await page.mouse.move(820, 420);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(980, 420, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  const cameraAfterOrbit = await page.evaluate(() => window.__rht.camera());
  if (!(Math.abs(cameraAfterOrbit.yaw - cameraBeforeOrbit.yaw) > 0.4)) {
    throw new Error(`Expected middle-drag orbit to rotate camera: before=${JSON.stringify(cameraBeforeOrbit)} after=${JSON.stringify(cameraAfterOrbit)}`);
  }
  await page.keyboard.down("d");
  await page.waitForTimeout(360);
  await page.keyboard.up("d");
  const cameraAfterRotatedPan = await page.evaluate(() => window.__rht.camera());
  if (!(Math.abs(cameraAfterRotatedPan.z - cameraAfterOrbit.z) > 0.4)) {
    throw new Error(`Expected D pan after orbit to move relative to rotated screen right, not the original world axis: before=${JSON.stringify(cameraAfterOrbit)} after=${JSON.stringify(cameraAfterRotatedPan)}`);
  }
  const cameraBeforePitch = await page.evaluate(() => window.__rht.camera());
  await page.mouse.move(820, 420);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(820, 260, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  const cameraAfterPitchUp = await page.evaluate(() => window.__rht.camera());
  if (!(cameraAfterPitchUp.pitch > cameraBeforePitch.pitch + 0.3)) {
    throw new Error(`Expected middle-drag vertical orbit to raise camera pitch: before=${JSON.stringify(cameraBeforePitch)} after=${JSON.stringify(cameraAfterPitchUp)}`);
  }
  await page.mouse.move(820, 260);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(820, 860, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  const cameraAfterPitchDown = await page.evaluate(() => window.__rht.camera());
  if (!(cameraAfterPitchDown.pitch >= 0.12 && cameraAfterPitchDown.pitch < cameraAfterPitchUp.pitch - 0.4)) {
    throw new Error(`Expected middle-drag vertical orbit to lower camera pitch but clamp above the play field: high=${JSON.stringify(cameraAfterPitchUp)} low=${JSON.stringify(cameraAfterPitchDown)}`);
  }

  await page.locator('[data-select="p-soldier-1"]').click();
  await page.locator('[data-order-action="move"]').click();
  await page.evaluate(() => window.__rht.queueMoveToCover("cover-wall-1"));
  await page.waitForFunction(() => window.__rht.sim.orders.length === 1 && window.__rht.sim.orders[0].kind === "move");
  const coverMoveState = await page.evaluate(() => ({
    order: window.__rht.sim.orders[0],
    targetPanel: Boolean(document.querySelector(".target-panel")),
    commandText: document.querySelector(".commandbar")?.textContent,
    log: window.__rht.sim.log.slice(),
  }));
  if (coverMoveState.order.targetId || !coverMoveState.order.destination || coverMoveState.targetPanel) {
    throw new Error(`Move-clicking cover should queue a move, not target the wall: ${JSON.stringify(coverMoveState)}`);
  }
  if (!coverMoveState.log.some((line) => line.includes("moves to cover"))) {
    throw new Error(`Cover move was not communicated in the log: ${JSON.stringify(coverMoveState)}`);
  }
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const rook = api.sim.entity("p-soldier-1");
    if (rook) {
      rook.position.x = 0;
      rook.position.z = 3.1;
      rook.commandPoints = 2;
    }
    api.sim.select("p-soldier-1");
    api.chooseBoardEntity("cliff-1");
  });
  await page.waitForSelector('[data-cover-action="climb"]');
  const cliffInteractState = await page.evaluate(() => ({
    text: document.querySelector(".commandbar")?.textContent,
    climbButtons: document.querySelectorAll('[data-cover-action="climb"]').length,
    shootButtons: document.querySelectorAll('[data-cover-action="shoot"]').length,
    coverButtons: document.querySelectorAll('[data-cover-action="cover"]').length,
  }));
  if (!cliffInteractState.text?.includes("Climb Cliff") || cliffInteractState.climbButtons !== 1 || cliffInteractState.shootButtons || cliffInteractState.coverButtons) {
    throw new Error(`Cliff interaction should expose only the compact infantry climb action: ${JSON.stringify(cliffInteractState)}`);
  }
  await page.screenshot({ path: join(OUT, "5-cliff-interact.png") });
  await page.locator('[data-cover-action="climb"]').click();
  await page.waitForFunction(() => window.__rht.sim.orders.length === 1 && window.__rht.sim.orders[0].kind === "move");
  const cliffClimbQueued = await page.evaluate(() => ({
    order: window.__rht.sim.orders[0],
    log: window.__rht.sim.log.slice(),
    cp: window.__rht.sim.entity("p-soldier-1")?.commandPoints,
  }));
  if (!cliffClimbQueued.log.some((line) => line.includes("climbs the cliff")) || cliffClimbQueued.cp !== 1) {
    throw new Error(`Infantry cliff climb did not queue clearly: ${JSON.stringify(cliffClimbQueued)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const tank = api.sim.entity("p-tank-1");
    if (tank) {
      tank.position.x = 0;
      tank.position.z = 3.2;
    }
    api.sim.select("p-tank-1");
    api.chooseBoardEntity("cliff-1");
  });
  await page.waitForFunction(() => document.querySelector(".commandbar")?.textContent?.includes("Tanks cannot climb this cliff"));
  const tankCliffState = await page.evaluate(() => ({
    text: document.querySelector(".commandbar")?.textContent,
    buttons: document.querySelectorAll("[data-cover-action]").length,
    rejected: window.__rht.queueMoveToCover("cliff-1"),
    log: window.__rht.sim.log.slice(),
    orders: window.__rht.sim.orders.length,
  }));
  if (tankCliffState.rejected || tankCliffState.buttons || tankCliffState.orders || !tankCliffState.log.some((line) => line.includes("cannot climb the cliff"))) {
    throw new Error(`Tank cliff refusal was not clear: ${JSON.stringify(tankCliffState)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const rook = api.sim.entity("p-soldier-1");
    if (rook) {
      rook.position.x = 0;
      rook.position.z = 3.1;
      rook.commandPoints = 2;
    }
    api.sim.select("p-soldier-1");
    api.sim.queueMove({ x: 0, z: 5.8 });
  });
  const cliffMoveBlock = await page.evaluate(() => ({
    destination: window.__rht.sim.orders[0]?.destination,
    log: window.__rht.sim.log.slice(),
  }));
  if (!cliffMoveBlock.log.some((line) => line.includes("must use a cliff ascent")) || !(cliffMoveBlock.destination?.z < 5.1)) {
    throw new Error(`Plain move over cliff should be blocked before the mesa: ${JSON.stringify(cliffMoveBlock)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    for (const entity of api.sim.entities) {
      if (entity.team === "neutral") {
        entity.position.x = 15;
        entity.position.z = 9;
      }
    }
    const rook = api.sim.entity("p-soldier-1");
    const target = api.sim.entity("e-soldier-1");
    if (rook) {
      rook.position.x = 0;
      rook.position.z = 0;
      rook.commandPoints = 2;
    }
    if (target) {
      target.position.x = 6.2;
      target.position.z = 0.35;
      target.grenades = 0;
      const rifle = target.parts.find((part) => part.id === "rifle");
      if (rifle) rifle.hp = 0;
    }
    api.sim.select("p-soldier-1");
    api.setIntent("grenade");
  });
  const groundGrenadeQueued = await page.evaluate(() => ({
    queued: window.__rht.queueGrenadeAt({ x: 6.1, z: 0 }),
    order: window.__rht.sim.orders[0],
    grenades: window.__rht.sim.entity("p-soldier-1")?.grenades,
    log: window.__rht.sim.log.slice(),
  }));
  if (!groundGrenadeQueued.queued || groundGrenadeQueued.order?.kind !== "grenade" || groundGrenadeQueued.order?.targetId || !groundGrenadeQueued.order?.destination || groundGrenadeQueued.grenades !== 1) {
    throw new Error(`Ground-target grenade did not queue correctly: ${JSON.stringify(groundGrenadeQueued)}`);
  }

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    const striker = api.sim.entity("p-striker-1");
    const target = api.sim.entity("e-soldier-1");
    if (striker) {
      striker.position.x = 0;
      striker.position.z = 0;
      striker.commandPoints = 2;
    }
    if (target) {
      target.position.x = 1.35;
      target.position.z = 0;
    }
  });
  await page.locator('[data-select="p-striker-1"]').click();
  await page.locator('[data-order-action="melee"]').click();
  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="head"]').click();
  await page.locator('[data-confirm="melee"]').click();
  const meleePartQueued = await page.evaluate(() => ({
    order: window.__rht.sim.orders[0],
    text: document.querySelector(".commandbar")?.textContent,
  }));
  if (meleePartQueued.order?.kind !== "melee" || meleePartQueued.order?.targetPartId !== "head") {
    throw new Error(`Part-specific adjacent strike did not queue head target: ${JSON.stringify(meleePartQueued)}`);
  }

  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1 && window.__rht.sim.orders.length === 0);
  await page.locator('[data-select="p-tank-1"]').click();
  await page.locator('[data-order-action="shoot"]').click();
  await page.locator('[data-select="fuel-1"]').click();
  await page.waitForSelector(".single-target-card");
  const singlePartTargetState = await page.evaluate(() => ({
    singleCards: document.querySelectorAll(".single-target-card").length,
    summaries: document.querySelectorAll(".order-body > .target-summary").length,
    text: document.querySelector(".commandbar")?.textContent,
    overflowY: getComputedStyle(document.querySelector(".commandbar")).overflowY,
  }));
  if (singlePartTargetState.singleCards !== 1 || singlePartTargetState.summaries !== 0 || !singlePartTargetState.text?.includes("Fuel Cell") || !singlePartTargetState.text.includes("% /") || singlePartTargetState.overflowY !== "visible") {
    throw new Error(`Single-part target should combine line and part info in one non-scrolling box: ${JSON.stringify(singlePartTargetState)}`);
  }
  await page.locator('[data-command="clear-order-focus"]').click();
  await page.waitForSelector('[data-order-action="shoot"]');

  await page.locator('[data-select="p-tank-1"]').click();
  await page.locator('[data-order-action="shoot"]').click();
  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="head"]').click();
  await page.waitForFunction(() => document.querySelector(".part-choice.active")?.getAttribute("data-part") === "head");
  await page.waitForFunction(() => document.querySelector(".target-summary")?.textContent?.includes("Line blocked"));
  const blockedState = await page.evaluate(() => {
    const preview = window.__rht.sim.previewShot(window.__rht.sim.selectedId, "e-soldier-1", "head");
    return {
      preview,
      targetPanel: Boolean(document.querySelector(".target-panel")),
      summary: document.querySelector(".target-summary")?.textContent,
      activeParts: Array.from(document.querySelectorAll(".part-choice.active")).map((el) => el.getAttribute("data-part")),
    };
  });
  if (blockedState.targetPanel) throw new Error(`Target drawer should close after selecting Cutlass: ${JSON.stringify(blockedState)}`);
  if (!blockedState.preview?.blockedById) throw new Error(`Expected blocked preview for Cutlass head shot, got ${JSON.stringify(blockedState)}`);
  if (!blockedState.summary?.includes("Line blocked")) throw new Error(`Blocked target summary was unclear: ${blockedState.summary}`);
  if (blockedState.activeParts.length !== 1 || blockedState.activeParts[0] !== "head") {
    throw new Error(`Expected exactly one selected head part, got ${JSON.stringify(blockedState.activeParts)}`);
  }
  await page.locator('[data-confirm="shoot"]').hover();
  await page.screenshot({ path: join(OUT, "5-blocked-targeting.png") });
  await page.locator('[data-command="clear-order-focus"]').click();
  await page.waitForSelector('[data-order-action="shoot"]');

  await page.evaluate(() => {
    for (const entity of window.__rht.sim.entities) {
      if (entity.team === "neutral") entity.position.z = 8;
    }
    window.__rht.sim.rng.reseed(11);
    const playerTank = window.__rht.sim.entity("p-tank-1");
    const enemyTank = window.__rht.sim.entity("e-tank-1");
    if (playerTank) {
      playerTank.position.x = -3;
      playerTank.position.z = 0;
    }
    if (enemyTank) {
      enemyTank.position.x = 2.6;
      enemyTank.position.z = 0;
    }
  });
  await page.locator('[data-order-action="shoot"]').click();
  await page.locator('[data-select="e-tank-1"]').click();
  if (await page.locator('.part-choice[data-part="head"]').count()) {
    throw new Error("Tank target exposed an invalid head part option");
  }
  await page.locator('.part-choice[data-part="right-tread"]').click();
  await page.waitForFunction(() => {
    const text = document.querySelector(".target-summary")?.textContent ?? "";
    return text.includes("Line is clear") || text.includes("Arcing explosive path");
  });
  const treadTip = await page.locator('.part-choice[data-part="right-tread"]').getAttribute("data-tip");
  if (!treadTip?.includes("Estimated damage")) throw new Error(`Missing damage tooltip on tread option: ${treadTip}`);
  const preview = await page.evaluate(() => window.__rht.sim.previewShot("p-tank-1", "e-tank-1", "right-tread"));
  if (!preview || preview.blockedById) throw new Error(`Expected clear preview for tank tread shot, got ${JSON.stringify(preview)}`);
  const clearTargetRenderDebug = await page.evaluate(() => window.__rht.renderDebug());
  if (clearTargetRenderDebug.previewLabels < 1 || clearTargetRenderDebug.splashRings < 1 || clearTargetRenderDebug.affectedMarkers < 1) {
    throw new Error(`Clear shell targeting should show damage, splash radius, and affected markers: ${JSON.stringify(clearTargetRenderDebug)}`);
  }
  const commandPanelText = await page.locator(".commandbar").textContent();
  if (!commandPanelText?.includes("Right Tread") || !commandPanelText.includes("34 HP")) {
    throw new Error(`Compact shoot panel did not expose selected tread detail: ${commandPanelText}`);
  }
  await assertHudLayout(page, "desktop targeting", [".topbar", ".roster", ".commandbar", ".log"]);
  await page.screenshot({ path: join(OUT, "6-clear-targeting.png") });
  await page.locator('[data-confirm="shoot"]').click();
  const queuedOrderDebug = await page.evaluate(() => ({
    ...window.__rht.renderDebug(),
    orderCount: window.__rht.sim.orders.length,
  }));
  if (queuedOrderDebug.orderCount < 1 || queuedOrderDebug.orderMarkers !== 0) {
    throw new Error(`Queued orders should draw paths without numbered map markers: ${JSON.stringify(queuedOrderDebug)}`);
  }

  await page.evaluate(() => {
    const openTarget = window.__rht.sim.entity("e-soldier-1");
    const sniper = window.__rht.sim.entity("p-sniper-1");
    openTarget.position.x = -4.4;
    openTarget.position.z = -4.7;
    if (sniper) {
      sniper.position.x = -6.2;
      sniper.position.z = -4.7;
      sniper.stance = "crouched";
    }
  });
  await page.locator('[data-select="p-sniper-1"]').click();
  await page.locator('[data-order-action="shoot"]').click();
  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="rifle"]').click();
  await page.locator('[data-confirm="shoot"]').click();
  const cameraBeforeResolve = await page.evaluate(() => window.__rht.camera());
  await page.locator('[data-command="end"]').click();
  await page.mouse.move(820, 420);

  const resolveFrameStats = await page.evaluate(async () => {
    const deltas = [];
    let last = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        if (deltas.length >= 50) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const max = Math.max(...deltas.slice(3));
    const avg = deltas.slice(3).reduce((sum, delta) => sum + delta, 0) / Math.max(1, deltas.length - 3);
    const over120 = deltas.filter((delta) => delta > 120).length;
    return { max, avg, over120 };
  });
  const cameraDuringResolve = await page.evaluate(() => window.__rht.camera());
  if (angleDelta(cameraDuringResolve.yaw, cameraBeforeResolve.yaw) > 0.35) {
    throw new Error(`Resolve camera should not whip yaw around: before=${JSON.stringify(cameraBeforeResolve)} during=${JSON.stringify(cameraDuringResolve)}`);
  }
  if (resolveFrameStats.max > 220 || resolveFrameStats.avg > 55 || resolveFrameStats.over120 > 1) {
    throw new Error(`Resolve phase frame pacing regressed: ${JSON.stringify(resolveFrameStats)}`);
  }
  await page.waitForTimeout(250);
  const projectileCount = await page.evaluate(() => window.__rht.sim.projectiles.length);
  if (projectileCount < 1) throw new Error("Expected visible projectile travel during resolve");
  const projectileKinds = await page.evaluate(() => window.__rht.sim.projectiles.map((projectile) => projectile.kind));
  if (!projectileKinds.includes("shell") || !projectileKinds.includes("rifle")) {
    throw new Error(`Expected distinct shell and rifle projectiles, got ${JSON.stringify(projectileKinds)}`);
  }
  await page.screenshot({ path: join(OUT, "7-projectiles.png") });
  const resolveFeedbackDebug = await page.evaluate(() => window.__rht.renderDebug());
  if (resolveFeedbackDebug.floatingLabels !== 0 || resolveFeedbackDebug.orderMarkers !== 0) {
    throw new Error(`Resolve should avoid floating damage labels and queued-order numbers: ${JSON.stringify(resolveFeedbackDebug)}`);
  }

  await page.waitForFunction(() => window.__rht.sim.phase === "command", undefined, { timeout: 14000 });
  await assertCanvasPainted(page, "desktop resolved");
  await assertHudLayout(page, "desktop resolved", [".topbar", ".roster", ".commandbar", ".log"]);
  await page.screenshot({ path: join(OUT, "8-resolved.png") });

  const state = await page.evaluate(() => {
    const enemyTank = window.__rht.sim.entity("e-tank-1");
    const enemySoldier = window.__rht.sim.entity("e-soldier-1");
    const cover = window.__rht.sim.entities
      .filter((entity) => entity.kind === "cover")
      .map((entity) => ({ id: entity.id, hp: entity.parts[0]?.hp }));
    return {
      phase: window.__rht.sim.phase,
      tankTreadHp: enemyTank?.parts.find((p) => p.id === "right-tread")?.hp,
      tankDamagedParts: enemyTank?.parts.filter((p) => p.hp < p.maxHp).map((p) => p.id) ?? [],
      soldierRifleHp: enemySoldier?.parts.find((p) => p.id === "rifle")?.hp,
      soldierDamagedParts: enemySoldier?.parts.filter((p) => p.hp < p.maxHp).map((p) => p.id) ?? [],
      cover,
      log: window.__rht.sim.log.slice(),
    };
  });

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  if (state.phase !== "command") throw new Error(`Expected command phase after resolve, got ${state.phase}`);
  if (!state.tankDamagedParts.length) {
    throw new Error(`Expected tank damage, got ${JSON.stringify(state)}`);
  }
  if (!state.soldierDamagedParts.length) {
    throw new Error(`Expected soldier damage, got ${JSON.stringify(state, null, 2)}`);
  }
  await page.evaluate(() => {
    const template = window.__rht.sim.turnReports[0];
    if (!template) return;
    for (let index = 0; index < 8; index += 1) {
      window.__rht.sim.turnReports.push({
        ...template,
        turn: 80 + index,
        entries: template.entries.map((entry, entryIndex) => ({ ...entry, id: `smoke-scroll-${index}-${entryIndex}` })),
        notes: [`Scroll smoke report ${index}`, ...template.notes],
      });
    }
  });
  await page.locator(".log-toggle").click();
  await page.waitForSelector(".compact-log.expanded .battle-log-panel");
  const expandedLog = await page.evaluate(() => ({
    rect: document.querySelector(".compact-log.expanded")?.getBoundingClientRect().toJSON(),
    reportCount: document.querySelectorAll(".compact-log.expanded .turn-report").length,
    damageCardCount: document.querySelectorAll(".compact-log.expanded .damage-card").length,
    playerSections: document.querySelectorAll(".compact-log.expanded .damage-section.team-player").length,
    enemySections: document.querySelectorAll(".compact-log.expanded .damage-section.team-enemy").length,
    sectionLabels: Array.from(document.querySelectorAll(".compact-log.expanded .damage-section-head strong")).map((node) => node.textContent?.trim()),
    lineCount: document.querySelectorAll(".compact-log.expanded .log-lines span").length,
    text: document.querySelector(".compact-log.expanded")?.textContent,
  }));
  if ((expandedLog.rect?.width ?? 0) < 760 || (expandedLog.rect?.left ?? 0) < 180 || (expandedLog.rect?.right ?? 0) > 1420) {
    throw new Error(`Expanded log should use the main middle screen: ${JSON.stringify(expandedLog)}`);
  }
  if (expandedLog.reportCount < 1 || expandedLog.damageCardCount < 1 || expandedLog.lineCount < 3 || !expandedLog.text?.match(/Battle Log|Turn \d|-\d+ HP|Disabled|damage|destroyed/i)) {
    throw new Error(`Expanded log should show concise grouped turn damage: ${JSON.stringify(expandedLog)}`);
  }
  if (expandedLog.playerSections < 1 || expandedLog.enemySections < 1 || !expandedLog.sectionLabels.includes("Your Squad Hit") || !expandedLog.sectionLabels.includes("Enemy Force Hit")) {
    throw new Error(`Expanded log should separate player and enemy damage sections: ${JSON.stringify(expandedLog)}`);
  }
  const beforeExpandedLogWheel = await page.evaluate(() => ({
    scrollTop: document.querySelector(".compact-log.expanded .turn-report-list")?.scrollTop ?? 0,
    scrollHeight: document.querySelector(".compact-log.expanded .turn-report-list")?.scrollHeight ?? 0,
    clientHeight: document.querySelector(".compact-log.expanded .turn-report-list")?.clientHeight ?? 0,
    zoom: window.__rht.camera().zoom,
  }));
  await page.locator(".compact-log.expanded .turn-report-list").hover();
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(120);
  const afterExpandedLogWheel = await page.evaluate(() => ({
    scrollTop: document.querySelector(".compact-log.expanded .turn-report-list")?.scrollTop ?? 0,
    zoom: window.__rht.camera().zoom,
  }));
  if (beforeExpandedLogWheel.scrollHeight > beforeExpandedLogWheel.clientHeight + 1 && !(afterExpandedLogWheel.scrollTop > beforeExpandedLogWheel.scrollTop + 8)) {
    throw new Error(`Wheel over expanded battle log should scroll the log list: before=${JSON.stringify(beforeExpandedLogWheel)} after=${JSON.stringify(afterExpandedLogWheel)}`);
  }
  if (Math.abs(afterExpandedLogWheel.zoom - beforeExpandedLogWheel.zoom) > 0.001) {
    throw new Error(`Wheel over expanded battle log should not zoom the map: before=${JSON.stringify(beforeExpandedLogWheel)} after=${JSON.stringify(afterExpandedLogWheel)}`);
  }
  await page.screenshot({ path: join(OUT, "8-expanded-log.png") });
  await page.locator(".log-toggle").click();
  await page.waitForFunction(() => !document.querySelector(".compact-log.expanded"));

  await page.evaluate(() => {
    window.__rht.sim.turnReports.unshift({
      turn: 99,
      phase: "complete",
      entries: [{
        id: "smoke-neutral-damage",
        actorName: "Hammer 1",
        targetName: "Concrete Wall",
        targetTeam: "neutral",
        partLabel: "Wall",
        amount: 24,
        remainingHp: 46,
        maxHp: 70,
        killed: false,
        destroyed: false,
        source: "smoke",
      }],
      notes: ["Hammer 1 damages Concrete Wall"],
    });
  });
  await page.locator(".log-toggle").click();
  await page.waitForSelector(".compact-log.expanded .damage-section.team-neutral");
  const neutralLog = await page.evaluate(() => ({
    labels: Array.from(document.querySelectorAll(".compact-log.expanded .damage-section-head strong")).map((node) => node.textContent?.trim()),
    neutralCards: document.querySelectorAll(".compact-log.expanded .damage-card.team-neutral").length,
    text: document.querySelector(".compact-log.expanded .damage-section.team-neutral")?.textContent,
  }));
  if (!neutralLog.labels.includes("Neutral Objects Hit") || neutralLog.neutralCards < 1 || !neutralLog.text?.includes("Concrete Wall")) {
    throw new Error(`Expanded log should separate neutral object damage: ${JSON.stringify(neutralLog)}`);
  }
  await page.locator(".log-toggle").click();
  await page.waitForFunction(() => !document.querySelector(".compact-log.expanded"));

  await page.evaluate(() => {
    const api = window.__rht;
    api.reset();
    for (const entity of api.sim.entities) {
      if (entity.team === "neutral") {
        entity.position.x = 16;
        entity.position.z = 10;
      }
    }
    const grenadier = api.sim.entity("p-grenadier-1");
    const target = api.sim.entity("e-soldier-1");
    if (grenadier) {
      grenadier.position.x = 0;
      grenadier.position.z = 2;
    }
    if (target) {
      target.position.x = 0;
      target.position.z = 8;
    }
    const start = { x: 0, z: 4.55 };
    const projectile = {
      id: "smoke-rolling-grenade",
      orderId: "smoke-rolling-order",
      actorId: "p-grenadier-1",
      targetId: "e-soldier-1",
      targetPartId: "body",
      aim: "center",
      kind: "grenade",
      position: { ...start },
      previous: { ...start },
      origin: { ...start },
      direction: { x: 0, z: 1 },
      verticalSlope: -0.55,
      travel: 0,
      maxTravel: 10,
      aimPoint: { x: 0, z: 9 },
      intendedPoint: { x: 0, z: 8 },
      height: 0.2,
      previousHeight: 0.2,
      originHeight: 0.2,
      speed: 2,
      age: 0,
      maxAge: 5,
      color: 0xffbf69,
      accuracy: "terrible",
      spreadRadians: 0.14,
      yawErrorRadians: 0.14,
      pitchErrorRadians: -0.12,
      arcHeight: 0,
      arcDistance: 1,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    api.sim.orders.push({
      id: "smoke-rolling-order",
      actorId: "p-grenadier-1",
      kind: "shoot",
      targetId: "e-soldier-1",
      targetPartId: "body",
      aim: "center",
      elapsed: 0,
      duration: 0.95,
      fired: true,
      done: false,
      projectileId: projectile.id,
    });
    api.sim.projectiles.push(projectile);
    api.sim.phase = "resolve";
  });
  await page.waitForFunction(() => window.__rht.sim.projectiles.some((projectile) => projectile.state === "rolling"), undefined, { timeout: 3000 });
  const rollingState = await page.evaluate(() => ({
    projectiles: window.__rht.sim.projectiles.map((projectile) => ({ kind: projectile.kind, state: projectile.state, height: projectile.height })),
    log: window.__rht.sim.log.slice(),
  }));
  if (!rollingState.log.some((line) => line.includes("grenade skips and rolls"))) {
    throw new Error(`Rolling grenade did not communicate ground skip: ${JSON.stringify(rollingState)}`);
  }
  await page.screenshot({ path: join(OUT, "9-rolling-grenade.png") });
  await page.waitForFunction(() => !window.__rht.sim.projectiles.length && window.__rht.sim.log.some((line) => line.includes("grenade rolls and explodes")), undefined, { timeout: 5000 });
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  await assertCanvasPainted(page, "mobile");
  await assertHudLayout(page, "mobile", [".topbar", ".roster", ".commandbar"]);
  const mobileDrawerState = await page.evaluate(() => ({
    targetPanel: Boolean(document.querySelector(".target-panel")),
    unitDetail: Boolean(document.querySelector(".unit-detail-panel")),
    rosterWidth: document.querySelector(".roster")?.getBoundingClientRect().width,
    viewportWidth: window.innerWidth,
  }));
  if (mobileDrawerState.targetPanel || mobileDrawerState.unitDetail) {
    throw new Error(`Mobile default view should keep drawers closed: ${JSON.stringify(mobileDrawerState)}`);
  }
  if ((mobileDrawerState.rosterWidth ?? 0) > 220) {
    throw new Error(`Mobile roster should remain compact by default: ${JSON.stringify(mobileDrawerState)}`);
  }
  const beforeRosterWheel = await page.evaluate(() => ({
    rosterTop: document.querySelector(".roster")?.scrollTop ?? 0,
    zoom: window.__rht.camera().zoom,
  }));
  await page.locator(".roster").hover();
  await page.mouse.wheel(0, 460);
  await page.waitForTimeout(120);
  const afterRosterWheel = await page.evaluate(() => ({
    rosterTop: document.querySelector(".roster")?.scrollTop ?? 0,
    zoom: window.__rht.camera().zoom,
  }));
  if (!(afterRosterWheel.rosterTop > beforeRosterWheel.rosterTop + 8)) {
    throw new Error(`Wheel over roster should scroll the menu: before=${JSON.stringify(beforeRosterWheel)} after=${JSON.stringify(afterRosterWheel)}`);
  }
  if (Math.abs(afterRosterWheel.zoom - beforeRosterWheel.zoom) > 0.001) {
    throw new Error(`Wheel over scrollable HUD should not zoom the map: before=${JSON.stringify(beforeRosterWheel)} after=${JSON.stringify(afterRosterWheel)}`);
  }
  await page.mouse.move(382, 420);
  await page.waitForFunction(() => !document.querySelector(".hud-tooltip.visible"));
  await page.screenshot({ path: join(OUT, "10-mobile.png") });

  await browser.close();
  console.log("Smoke passed");
} finally {
  if (server) server.kill();
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still starting
    }
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}

async function isServerReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  if (!existsSync(root)) throw new Error(`Missing Playwright browser cache: ${root}`);

  const matches = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(root, name, "chrome-win64", "chrome.exe"))
    .filter((path) => existsSync(path))
    .sort();

  if (!matches.length) throw new Error(`No cached Chromium executable under ${root}`);
  return matches[matches.length - 1];
}

function angleDelta(a, b) {
  let delta = Math.abs((a - b) % (Math.PI * 2));
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  return delta;
}

async function assertCanvasPainted(page, label) {
  const sample = await page.evaluate(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { ok: false, reason: "missing webgl context" };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const size = 18;
    const x = Math.max(0, Math.floor(width / 2 - size / 2));
    const y = Math.max(0, Math.floor(height / 2 - size / 2));
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) lit += 1;
    }
    return { ok: lit > 20, lit, width, height };
  });
  if (!sample.ok) throw new Error(`Canvas pixel check failed for ${label}: ${JSON.stringify(sample)}`);
}

async function assertHudLayout(page, label, selectors) {
  const result = await page.evaluate((items) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const boxes = items.map((selector) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) return { selector, missing: true };
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        selector,
        missing: false,
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewport: { vw, vh },
      };
    });
    const issues = boxes.filter((box) => {
      if (box.missing || !box.visible) return true;
      return box.left < -2 || box.top < -2 || box.right > vw + 2 || box.bottom > vh + 2;
    });
    return { boxes, issues };
  }, selectors);
  if (result.issues.length) throw new Error(`HUD layout check failed for ${label}: ${JSON.stringify(result, null, 2)}`);
}

async function assertNoOverlap(page, label, selectorA, selectorB, gap = 0) {
  const result = await page.evaluate(([a, b, minGap]) => {
    const first = document.querySelector(a);
    const second = document.querySelector(b);
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) return { missing: true, a, b };
    const ra = first.getBoundingClientRect();
    const rb = second.getBoundingClientRect();
    const horizontalOverlap = ra.left < rb.right + minGap && ra.right + minGap > rb.left;
    const verticalOverlap = ra.top < rb.bottom + minGap && ra.bottom + minGap > rb.top;
    return {
      missing: false,
      overlap: horizontalOverlap && verticalOverlap,
      first: { left: ra.left, right: ra.right, top: ra.top, bottom: ra.bottom, width: ra.width, height: ra.height },
      second: { left: rb.left, right: rb.right, top: rb.top, bottom: rb.bottom, width: rb.width, height: rb.height },
      gap: minGap,
    };
  }, [selectorA, selectorB, gap]);
  if (result.missing || result.overlap) throw new Error(`HUD overlap check failed for ${label}: ${JSON.stringify(result, null, 2)}`);
}
