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
  rule: "truncated" | "overlap" | "offscreen" | "clipped" | "occluded" | "small-text" | "contrast" | "no-owned-surface";
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
    // "Wrapped" means a laid-out child, whatever its opacity: a toast mid fade-in must not turn
    // its container into a leaf that then reads as bare text over the board.
    const hasElementChild = Array.from(el.children).some((c) => getComputedStyle(c).display !== "none");
    // An element that paints its OWN text beside a child (a faction name next to its colour pip)
    // is a leaf too — the first sheet missed "Vanguard" running into "14 troops" because the
    // <strong> holding the name had a child and so was never compared with its sibling.
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim());
    if (hasElementChild && !ownText) continue;
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

// ---------------------------------------------------------------------------
//  Readability: size + contrast. Both are measurements, not taste.
//  * small-text: computed font-size under 12px (13px for body copy — a <p> or a run of prose).
//  * contrast: the text colour against the surface it actually sits on, found by walking up
//    to the nearest ancestor whose composited background is opaque enough to own the pixels
//    (alpha-blending translucent layers on the way), WCAG 4.5:1 (3:1 for large text).
//  * no-owned-surface: text with NO opaque ancestor is text over the live 3D canvas, whose
//    lighting is uncontrolled — it must carry a halo (text-shadow / text-stroke) or a plate.
// ---------------------------------------------------------------------------

export const MIN_TEXT_PX = 12;
export const MIN_BODY_PX = 13;
export const MIN_CONTRAST = 4.5;
export const MIN_CONTRAST_LARGE = 3;
/** An ancestor whose composited background alpha reaches this owns the pixels behind the text. */
const OPAQUE_ALPHA = 0.85;

type Rgba = [number, number, number, number];

function parseColor(s: string): Rgba | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(s);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith("%")) a /= 100;
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

/** Composite `top` over `under` (both premultiplied by their own alpha on the way). */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a <= 0) return [0, 0, 0, 0];
  const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Does this text paint its own halo (shadow or stroke) so it survives any backdrop? */
function hasHalo(style: CSSStyleDeclaration): boolean {
  if (style.textShadow && style.textShadow !== "none") return true;
  const stroke = parseFloat(style.webkitTextStrokeWidth || "0");
  return stroke > 0;
}

/**
 * The surface behind an element: its ancestors' background colours composited bottom-up until
 * the stack is opaque enough to own the pixels, plus the product of opacities on the way (an
 * element inside a 0.6-opacity disabled card is 0.6 as visible as its colour says).
 * Returns null when nothing opaque is found before the root — that is text over the canvas.
 */
function surfaceBehind(el: Element): { bg: Rgba; opacity: number } | null {
  const layers: Rgba[] = [];
  let opacity = 1;
  let node: Element | null = el;
  // The walk stops short of <body>: the page background is under the canvas, not over it.
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    // The element's OWN fill counts (a cyan badge is the surface behind its ink). A
    // background-image (the dot-screen tone on overlays, a striped classified node) is drawn
    // on top of the colour; it can only darken a dark tone, so the colour stands in for it.
    const c = parseColor(style.backgroundColor);
    if (c && c[3] > 0) layers.push(c);
    let acc: Rgba = [0, 0, 0, 0];
    for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc);
    if (acc[3] >= OPAQUE_ALPHA) return { bg: acc, opacity };
    const op = Number(style.opacity);
    if (Number.isFinite(op)) opacity *= op;
    node = node.parentElement;
  }
  // The page's own background closes the stack only when no live canvas is painted under the
  // DOM — with the 3D view up, whatever is behind the text is the scene, not the page colour.
  const canvas = document.querySelector("canvas");
  if (canvas && visible(canvas)) return null;
  const pageBg = parseColor(getComputedStyle(document.body).backgroundColor) ?? parseColor(getComputedStyle(document.documentElement).backgroundColor);
  if (pageBg && pageBg[3] >= OPAQUE_ALPHA) {
    let acc: Rgba = pageBg;
    for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc);
    return { bg: acc, opacity };
  }
  return null;
}

function isBodyCopy(el: Element): boolean {
  if (el.tagName === "P") return true;
  return (el.textContent ?? "").trim().length >= 60;
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

  // --- small-text / contrast / no-owned-surface: can the words be read? ---
  for (const el of leaves) {
    if (el.closest("[data-audit-ignore-text]")) continue;
    const style = getComputedStyle(el);
    const px = parseFloat(style.fontSize);
    const body = isBodyCopy(el);
    const floor = body ? MIN_BODY_PX : MIN_TEXT_PX;
    const sample = `"${(el.textContent ?? "").trim().slice(0, 32)}"`;
    if (px < floor - 0.05) {
      findings.push({ rule: "small-text", sel: describe(el), detail: `${px.toFixed(1)}px ${body ? "body copy" : "text"} (floor ${floor}px): ${sample}`, rect: boxOf(el) });
    }
    const fill = parseColor(style.webkitTextFillColor || style.color) ?? parseColor(style.color);
    if (!fill) continue;
    const surface = surfaceBehind(el);
    if (!surface) {
      if (!hasHalo(style)) {
        findings.push({ rule: "no-owned-surface", sel: describe(el), detail: `text over the canvas with no plate, shadow or stroke: ${sample}`, rect: boxOf(el) });
      }
      continue;
    }
    // Opacity on the way up (a 0.6 disabled card) fades the ink toward the surface.
    const alpha = Math.min(1, fill[3] * surface.opacity);
    const effective = over([fill[0], fill[1], fill[2], alpha], surface.bg);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? MIN_CONTRAST_LARGE : MIN_CONTRAST;
    const ratio = contrastRatio(effective, surface.bg);
    if (ratio < need - 0.01) {
      const hex = (c: Rgba) => "#" + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      findings.push({ rule: "contrast", sel: describe(el), detail: `${ratio.toFixed(2)}:1 (${hex(effective)} on ${hex(surface.bg)}, need ${need}:1 at ${px.toFixed(0)}px): ${sample}`, rect: boxOf(el) });
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
