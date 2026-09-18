// ============================================================================
//  uiAudit — deterministic HUD checks, run in the real browser.
// ----------------------------------------------------------------------------
//  Three UI bugs shipped in this repo inside one session and every one was found
//  by a human squinting at a screenshot: the target panel opened on top of the
//  Menu button, the roster clipped its last card in half, and the battle-log line
//  cut off mid-word. None of them is a judgement call — each is a geometric fact
//  about two rectangles or about scrollWidth exceeding clientWidth. So they get a
//  test instead of an opinion.
//
//  Three-free and DOM-only, so it is portable to any game in the family unchanged.
//  It must run in a REAL browser (jsdom has no layout, so every rect is 0x0).
// ============================================================================

export interface UiFinding {
  /** Which check failed. */
  rule: "truncated" | "overlap" | "offscreen" | "clipped" | "occluded";
  /** A CSS-ish path to the offending element, for the failure message. */
  sel: string;
  detail: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** Elements opted out of the audit (transient pools, deliberately stacked chrome). */
const IGNORE = "[data-audit-ignore]";
const ALLOW_OVERLAP = "data-allow-overlap";

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120);
}

function boxOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
}

/** Leaf elements that actually paint text — the only ones an overlap check is meaningful for. */
function textLeaves(root: Element): Element[] {
  const out: Element[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.closest(IGNORE)) continue;
    if (el.tagName === "CANVAS" || el.tagName === "SVG") continue;
    if (el.closest("[inert]")) continue; // the HUD under a modal: covered on purpose, unreachable
    if (!visible(el)) continue;
    // A leaf for this purpose is an element whose own text is not further wrapped.
    const hasElementChild = Array.from(el.children).some((c) => visible(c));
    if (hasElementChild) continue;
    if (!(el.textContent ?? "").trim()) continue;
    out.push(el);
  }
  return out;
}

/**
 * The element's rect INTERSECTED with every clipping ancestor — i.e. the pixels it actually
 * occupies on screen. Returns null when it is fully clipped away. Without this, a roster card
 * scrolled out of its panel still reports its raw rect, which happily "overlaps" the treasury bar
 * two hundred pixels below: the audit's first run produced ten such false positives and no real
 * ones. Every rule works on this box, never on the raw rect.
 */
function visibleBox(el: Element, root: Element): { x: number; y: number; w: number; h: number } | null {
  let box = boxOf(el);
  let parent = el.parentElement;
  while (parent && parent !== root.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflow !== "visible" || style.overflowY !== "visible" || style.overflowX !== "visible") {
      const p = boxOf(parent);
      const x = Math.max(box.x, p.x);
      const y = Math.max(box.y, p.y);
      const right = Math.min(box.x + box.w, p.x + p.w);
      const bottom = Math.min(box.y + box.h, p.y + p.h);
      if (right - x < 1 || bottom - y < 1) return null;
      box = { x, y, w: right - x, h: bottom - y };
    }
    parent = parent.parentElement;
  }
  return box;
}

/** The nearest ancestor that actually scrolls, if any. */
function scrollableAncestor(el: Element, root: Element): Element | null {
  let parent = el.parentElement;
  while (parent && parent !== root) {
    const style = getComputedStyle(parent);
    const scrolls = /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX);
    if (scrolls && parent.scrollHeight > parent.clientHeight + 1) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function intersects(a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>, inset = 1): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - inset * 2;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - inset * 2;
  return w > 2 && h > 2 ? w * h : 0;
}

/**
 * Audit the live HUD. Returns every finding; an empty array is the assertion.
 * Call only after `document.fonts.ready` — text metrics before the webfont lands are a
 * different layout, and the truncation rule reads them.
 */
export function auditUI(root: Element = document.body): UiFinding[] {
  const findings: UiFinding[] = [];
  const viewport = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

  const leaves = textLeaves(root);

  // --- truncated: an ellipsis that actually fired, or text overflowing a clipped box ---
  for (const el of leaves) {
    const style = getComputedStyle(el);
    const clips = style.overflowX === "hidden" || style.overflowX === "clip" || style.textOverflow === "ellipsis";
    if (!clips) continue;
    // +1 absorbs sub-pixel layout rounding; a real truncation overflows by far more.
    if (el.scrollWidth > el.clientWidth + 1) {
      findings.push({
        rule: "truncated",
        sel: describe(el),
        detail: `text is ${el.scrollWidth}px in a ${el.clientWidth}px box: "${(el.textContent ?? "").trim().slice(0, 40)}"`,
        rect: boxOf(el),
      });
    }
  }

  // --- offscreen / clipped: a box outside the viewport or outside its scroll parent ---
  for (const el of leaves) {
    const box = boxOf(el);
    // Content inside a scroll container is legitimately off-viewport — that is what scrolling is.
    // The rule is about elements with no way to be reached, not about a list that is longer than
    // its panel.
    if (scrollableAncestor(el, root)) continue;
    if (box.x < -1 || box.y < -1 || box.x + box.w > viewport.w + 1 || box.y + box.h > viewport.h + 1) {
      findings.push({ rule: "offscreen", sel: describe(el), detail: `outside the ${viewport.w}x${viewport.h} viewport`, rect: box });
      continue;
    }
    // Partially clipped by a NON-scrolling ancestor: the row is cut in half with no way to reveal
    // it, which is the roster bug. A scroll container is exempt — that content is reachable.
    const shown = visibleBox(el, root);
    // Ratio AND absolute loss. A 9px-tall inline <em> can lose 15% of its area to integer rect
    // rounding alone, so a ratio-only rule reports chrome that is perfectly fine; 4px on an axis is
    // past any rounding and is a real cut.
    const lostW = shown ? box.w - shown.w : box.w;
    const lostH = shown ? box.h - shown.h : box.h;
    if (shown && !scrollableAncestor(el, root) && (lostW > 4 || lostH > 4)) {
      findings.push({
        rule: "clipped",
        sel: describe(el),
        detail: `loses ${lostW}x${lostH}px to a non-scrolling ancestor`,
        rect: box,
      });
    }
  }

  // --- overlap: two text leaves from DIFFERENT widgets sharing pixels ---
  const boxes = leaves
    .map((el) => ({ el, box: visibleBox(el, root) }))
    .filter((b): b is { el: Element; box: { x: number; y: number; w: number; h: number } } => b.box !== null);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el.closest(`[${ALLOW_OVERLAP}]`) || b.el.closest(`[${ALLOW_OVERLAP}]`)) continue;
      const area = intersects(a.box, b.box);
      if (!area) continue;
      findings.push({
        rule: "overlap",
        sel: describe(a.el),
        detail: `overlaps ${describe(b.el)} by ${Math.round(area)}px²`,
        rect: a.box,
      });
    }
  }

  // --- occluded: an interactive control something else sits on top of ---
  for (const el of root.querySelectorAll<HTMLElement>("button, [data-command], [data-select]")) {
    if (el.closest(IGNORE) || !visible(el)) continue;
    if (el.closest("[inert]")) continue; // deliberately unreachable (a menu is over it)
    const box = visibleBox(el, root);
    if (!box) continue;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) continue;
    if (hit === el || el.contains(hit) || hit.contains(el)) continue;
    // Covered by a full-screen overlay (a menu or modal over the live HUD) is not a layout bug —
    // that is what an overlay is for. Only a control buried under a SIBLING widget counts.
    const cover = boxOf(hit);
    if (cover.w * cover.h > viewport.w * viewport.h * 0.8) continue;
    findings.push({
      rule: "occluded",
      sel: describe(el),
      detail: `its centre hits ${describe(hit)} instead`,
      rect: box,
    });
  }

  return findings;
}
