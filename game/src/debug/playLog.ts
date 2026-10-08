// ============================================================================
//  PlayLog — a plain-text trail of a play session, for "what happened when I
//  tested" (owner 2026-10-01: logs to a file so later references are understood).
// ----------------------------------------------------------------------------
//  Every line goes to console.info with a "[play]" prefix; the Electron shell
//  (electron-main.cjs) copies the whole console to game/logs/ when the game runs
//  from the repo. What it records: every button pressed (its label + data-*),
//  ground clicks with what was armed, battle starts, the sim's own log lines
//  (orders, refusals and their reasons, kills), toasts and uncaught errors.
//  Read-only: it never touches the sim.
// ============================================================================

export function play(text: string): void {
  console.info(`[play] ${text}`);
}

/** The button/control a click landed on, as one readable line ("Barrel Stack $70 [build=barrels]"). */
function describe(el: Element): string {
  const control = el.closest("button, a, [data-select], [data-tech], [data-map], [data-faction], [data-faction2], input, select, label") ?? el;
  const text = (control.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const data = control instanceof HTMLElement
    ? Object.entries(control.dataset).filter(([k]) => k !== "tip").map(([k, v]) => (v ? `${k}=${v}` : k)).join(" ")
    : "";
  const disabled = control instanceof HTMLButtonElement && control.disabled || control.getAttribute("data-disabled") === "true" ? " DISABLED" : "";
  return `${control.tagName.toLowerCase()} "${text}"${data ? ` [${data}]` : ""}${disabled}`;
}

export function installPlayLog(): void {
  // Capture phase: logged even when a handler stops the event.
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.tagName !== "CANVAS") play(`click ${describe(target)}`);
  }, true);
  window.addEventListener("error", (event) => play(`ERROR ${event.message} @ ${event.filename}:${event.lineno}`));
  window.addEventListener("unhandledrejection", (event) => play(`ERROR (promise) ${String(event.reason)}`));
}
