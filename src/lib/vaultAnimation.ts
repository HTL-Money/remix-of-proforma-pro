// The recap email's hero animation: a 10-second story told inside a bank
// vault, rendered frame-by-frame onto a Canvas 2D context from the recap's
// two headline numbers (current-platform annual vs. Hometown Lending annual).
//
//   Phase 1 (0–3.5s)   Grayscale. Bills flutter down onto a steel table and
//                      settle into a neat stack sized to CURRENT earnings.
//   Phase 2 (3.5–5s)   The stack tips off the table edge; the camera rides
//                      DOWN with the tumbling bills, which pick up green as
//                      they fall. A second, lower vault level rises into view.
//   Phase 3 (5–10s)    The first paper-banded Hometown stack SLAMS onto the
//                      lower table — the whole scene snaps to color. More
//                      heavy stacks land; the original bills merge into the
//                      pile. The last second holds a closing card with both
//                      dollar amounts (the only text in the animation).
//
// Everything here is a pure function of (t, params): no Date.now, no
// Math.random — the tumble paths come from a seeded PRNG derived from the
// dollar amounts, so the same pro forma always renders the identical GIF
// (mirrors renderRecapChartPng's "a resend paints exactly the same image"
// guarantee) and every frame is unit-testable.
import { BRAND } from "../../supabase/functions/send-recap/template";

export const VAULT_W = 600;
export const VAULT_H = 338;
export const VAULT_DURATION = 10; // seconds

// The story's beat sheet. Exported so tests (and the GIF encoder's key-frame
// selection) agree with the renderer about when each phase happens.
export const VAULT_PHASES = {
  stackDone: 3.4, // phase-1 stack fully settled
  descentStart: 3.5, // stack tips off the table; camera starts down
  impact: 5.0, // first banded stack lands; color snaps here
  pileDone: 7.6, // last banded stack has landed
  cardStart: 8.9, // closing card fades in
  end: VAULT_DURATION,
} as const;

export interface VaultAnimParams {
  /** Annual comp on the current platform (calc.currentPlatformAnnual). */
  currentAnnual: number;
  /** Annual comp at Hometown Lending (calc.finalLoNetComp). */
  htlAnnual: number;
  /** Pre-formatted dollar strings for the closing card (fmtUSD output). */
  currentLabel: string;
  htlLabel: string;
}

// ---------------------------------------------------------------------------
// Stack sizing — the "≥25% visible difference" rule
// ---------------------------------------------------------------------------

// Visual budget inside the 338px-tall frame.
const MIN_STACK_PX = 18;
const MAX_CURRENT_PX = 110;
const MAX_HTL_PX = 150;
// When the amounts differ at all, the taller pile must read at least 25%
// taller. Extreme ratios are compressed so both stacks stay in frame.
const MIN_VISUAL_RATIO = 1.25;
const MAX_VISUAL_RATIO = 3.0;

export interface StackHeights {
  currentH: number;
  htlH: number;
}

/** Pixel heights for the two piles. Honest proportions where possible,
 *  clamped to [1.25x, 3x] so small gains still register and huge ones fit. */
export const stackHeights = (currentAnnual: number, htlAnnual: number): StackHeights => {
  const safe = (v: number) => (isFinite(v) && v > 0 ? v : 0);
  const cur = safe(currentAnnual);
  const htl = safe(htlAnnual);

  if (cur === 0 && htl === 0) return { currentH: MIN_STACK_PX, htlH: MIN_STACK_PX };
  if (cur === 0) return { currentH: MIN_STACK_PX, htlH: MAX_HTL_PX };
  if (htl === 0) return { currentH: MAX_CURRENT_PX, htlH: MIN_STACK_PX };

  const ratio = htl / cur;
  // "Equal" within half a percent renders equal — a rounding-noise difference
  // shouldn't fabricate a visual gap.
  if (Math.abs(ratio - 1) < 0.005) return { currentH: 96, htlH: 96 };

  if (ratio > 1) {
    const display = Math.min(MAX_VISUAL_RATIO, Math.max(MIN_VISUAL_RATIO, ratio));
    return { currentH: Math.max(MIN_STACK_PX, MAX_HTL_PX / display), htlH: MAX_HTL_PX };
  }
  // Current out-earns HTL (rare, but the calculator allows it) — mirror the rule.
  const display = Math.min(MAX_VISUAL_RATIO, Math.max(MIN_VISUAL_RATIO, 1 / ratio));
  return { currentH: MAX_CURRENT_PX, htlH: Math.max(MIN_STACK_PX, MAX_CURRENT_PX / display) };
};

// ---------------------------------------------------------------------------
// Deterministic choreography
// ---------------------------------------------------------------------------

/** mulberry32 — tiny seeded PRNG so tumble paths are reproducible. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface FallingBill {
  spawnT: number;
  fallDur: number;
  x0: number; // spawn x
  x1: number; // landing x (stack-centered)
  swayPhase: number;
  swayAmp: number;
  spin: number;
}

interface TumbleBill {
  releaseT: number;
  landT: number;
  x0: number;
  x1: number; // landing x on the HTL pile
  hoverY: number; // screen-space band the bill tumbles in during the descent
  swayPhase: number;
  spinSpeed: number;
  spinDir: number;
}

interface Brick {
  landT: number;
  col: number; // -1 | 0 | 1 (x offset multiplier)
  row: number; // 0 = table surface
  w: number;
  xJitter: number;
}

interface Choreography {
  heights: StackHeights;
  p1Bills: FallingBill[];
  tumble: TumbleBill[];
  bricks: Brick[];
  colHeights: [number, number, number]; // final px height per pile column
}

const TABLE1_Y = 232; // table-1 surface, world coords
const DESCENT = 420; // camera travel between levels
const TABLE2_Y = TABLE1_Y + DESCENT; // table-2 surface lines up like table 1
const STACK_X = 300; // both piles are centered
const BRICK_H = 24;
const COL_X = [-98, 0, 98] as const;

const buildChoreography = (params: VaultAnimParams): Choreography => {
  const heights = stackHeights(params.currentAnnual, params.htlAnnual);
  const rand = mulberry32(
    (Math.round(params.currentAnnual) * 7919 + Math.round(params.htlAnnual) * 104729 + 1) | 0,
  );

  // Phase 1: fourteen bill sprites; the stack's height eases up as they land.
  const p1Bills: FallingBill[] = [];
  const N1 = 14;
  for (let i = 0; i < N1; i++) {
    p1Bills.push({
      spawnT: 0.15 + (i * 2.15) / N1 + rand() * 0.08,
      fallDur: 0.95 + rand() * 0.25,
      x0: STACK_X + (rand() - 0.5) * 150,
      x1: STACK_X + (rand() - 0.5) * 10,
      swayPhase: rand() * Math.PI * 2,
      swayAmp: 10 + rand() * 10,
      spin: (rand() - 0.5) * 0.9,
    });
  }

  // Phase 2: ten bills tumble off the edge and ride down with the camera,
  // landing ON the growing Hometown pile (they merge in — "plus some").
  const tumble: TumbleBill[] = [];
  const N2 = 10;
  for (let i = 0; i < N2; i++) {
    const releaseT = 3.55 + (i * 0.6) / N2 + rand() * 0.06;
    tumble.push({
      releaseT,
      landT: 5.05 + i * 0.07 + rand() * 0.1,
      x0: STACK_X + 20 + (rand() - 0.5) * 30,
      x1: STACK_X + (rand() - 0.5) * 120,
      hoverY: 62 + rand() * 130,
      swayPhase: rand() * Math.PI * 2,
      spinSpeed: 3 + rand() * 3,
      spinDir: rand() > 0.5 ? 1 : -1,
    });
  }

  // Phase 3: banded bricks in three columns. The center column carries the
  // full height; the flanks ~70% — a pile silhouette rather than a wall.
  const colHeights: [number, number, number] = [
    Math.max(BRICK_H, Math.round(heights.htlH * 0.68)),
    Math.round(heights.htlH),
    Math.max(BRICK_H, Math.round(heights.htlH * 0.72)),
  ];
  const bricks: Brick[] = [];
  colHeights.forEach((h, ci) => {
    const rows = Math.max(1, Math.round(h / BRICK_H));
    for (let r = 0; r < rows; r++) {
      bricks.push({
        landT: 0, // scheduled below
        col: ci - 1,
        row: r,
        w: 88 + rand() * 10,
        xJitter: (rand() - 0.5) * 8,
      });
    }
  });
  // The very first landing is the center column's base brick — the SLAM that
  // snaps the scene to color. The rest follow bottom-row-first so nothing
  // ever lands beneath an already-landed brick.
  bricks.sort((a, b) => a.row - b.row || Math.abs(a.col) - Math.abs(b.col) || a.col - b.col);
  const span = VAULT_PHASES.pileDone - VAULT_PHASES.impact - 0.3;
  bricks.forEach((b, i) => {
    b.landT =
      i === 0
        ? VAULT_PHASES.impact
        : VAULT_PHASES.impact + 0.22 + ((i - 1) * span) / Math.max(1, bricks.length - 1) + rand() * 0.05;
  });

  return { heights, p1Bills, tumble, bricks, colHeights };
};

// Choreography is pure-by-params; cache the last one so a 150-frame encode
// doesn't rebuild it per frame.
let choreoCache: { key: string; c: Choreography } | null = null;
const getChoreography = (params: VaultAnimParams): Choreography => {
  const key = `${params.currentAnnual}|${params.htlAnnual}`;
  if (!choreoCache || choreoCache.key !== key) choreoCache = { key, c: buildChoreography(params) };
  return choreoCache.c;
};

// ---------------------------------------------------------------------------
// Color: one palette, two moods
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (a: number, b: number, t: number) => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const easeInQuad = (t: number) => clamp01(t) * clamp01(t);

const hexRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
/** Mix a grayscale hex with its full-color hex by s∈[0,1]. */
const mix = (gray: string, color: string, s: number): string => {
  if (s <= 0) return gray;
  if (s >= 1) return color;
  const g = hexRgb(gray);
  const c = hexRgb(color);
  const ch = (i: number) => Math.round(g[i] + (c[i] - g[i]) * s);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
};

// [grayscale, full-color] pairs. The color side leans on the email's brand
// palette (BRAND.navy walls, dollar-bill green, gold bands) so the GIF and
// the HTML below it feel like one artifact.
const P = {
  wallTop: ["#33363b", "#1a3157"],
  wallBot: ["#26282c", BRAND.navy],
  panel: ["#3d4046", "#22406e"],
  door: ["#54585e", "#3a5f8c"],
  floor: ["#1d1f22", "#0e1d36"],
  slab: ["#101113", "#0a1526"],
  tableTop: ["#8e949b", "#a9bccb"],
  tableEdge: ["#6d737a", "#7f96a9"],
  tableLeg: ["#4c5157", "#54677a"],
  billBody: ["#c2c4c2", "#cfe3c0"],
  billInk: ["#7c7f7c", "#4f8a55"],
  billEdge: ["#9a9d9a", "#a4c495"],
  band: ["#a9a9a9", "#d9b25f"],
  bandEdge: ["#8a8a8a", "#b28f3e"],
} as const;
const DOOR_RING: readonly [string, string] = ["#6a6f76", "#5b79a4"];

// ---------------------------------------------------------------------------
// Primitive painters
// ---------------------------------------------------------------------------

const roundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

const BILL_W = 62;
const BILL_H = 26;

/** One dollar bill, centered on (x, y), rotated. g = its own gray→green mix. */
const drawBill = (ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, g: number) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  roundedRect(ctx, -BILL_W / 2, -BILL_H / 2, BILL_W, BILL_H, 3);
  ctx.fillStyle = mix(P.billBody[0], P.billBody[1], g);
  ctx.fill();
  ctx.strokeStyle = mix(P.billInk[0], P.billInk[1], g);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-BILL_W / 2 + 4, -BILL_H / 2 + 4, BILL_W - 8, BILL_H - 8);
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = mix(P.billInk[0], P.billInk[1], g);
  ctx.fill();
  ctx.restore();
};

/** The neat phase-1 stack: crisp bill-edge striations up to height h. */
const drawNeatStack = (ctx: CanvasRenderingContext2D, cx: number, surfaceY: number, h: number, g: number) => {
  if (h <= 0) return;
  const w = 78;
  const layers = Math.max(1, Math.floor(h / 3));
  for (let i = 0; i < layers; i++) {
    const jitter = Math.sin(i * 12.9898) * 1.6; // deterministic wobble
    ctx.fillStyle = i % 2 === 0 ? mix(P.billBody[0], P.billBody[1], g) : mix(P.billEdge[0], P.billEdge[1], g);
    ctx.fillRect(cx - w / 2 + jitter, surfaceY - (i + 1) * 3, w, 3);
  }
  // Top face: the visible bill lying on the pile.
  drawBill(ctx, cx, surfaceY - layers * 3 - BILL_H / 2 + 10, 0.02, g);
};

/** A heavy banded brick (side view), centered x, bottom edge at yBottom. */
const drawBrick = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  yBottom: number,
  w: number,
  s: number,
  squash: number,
) => {
  const h = BRICK_H * (1 - 0.18 * squash);
  const bw = w * (1 + 0.12 * squash);
  const x = cx - bw / 2;
  const y = yBottom - h;
  roundedRect(ctx, x, y, bw, h, 3);
  ctx.fillStyle = mix(P.billBody[0], P.billBody[1], s);
  ctx.fill();
  // bill striations
  ctx.strokeStyle = mix(P.billEdge[0], P.billEdge[1], s);
  ctx.lineWidth = 1;
  for (let ly = y + 4; ly < y + h - 3; ly += 3.2) {
    ctx.beginPath();
    ctx.moveTo(x + 2, ly);
    ctx.lineTo(x + bw - 2, ly);
    ctx.stroke();
  }
  // the paper band — the tell that this money came from a bank
  const bandW = 20;
  ctx.fillStyle = mix(P.band[0], P.band[1], s);
  ctx.fillRect(cx - bandW / 2, y - 1, bandW, h + 2);
  ctx.strokeStyle = mix(P.bandEdge[0], P.bandEdge[1], s);
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - bandW / 2, y - 1, bandW, h + 2);
};

/** Steel table with pedestal legs; surfaceY is the top surface line. */
const drawTable = (ctx: CanvasRenderingContext2D, surfaceY: number, halfW: number, s: number) => {
  const cx = STACK_X;
  // top surface (slight perspective trapezoid)
  ctx.beginPath();
  ctx.moveTo(cx - halfW + 14, surfaceY - 8);
  ctx.lineTo(cx + halfW - 14, surfaceY - 8);
  ctx.lineTo(cx + halfW, surfaceY);
  ctx.lineTo(cx - halfW, surfaceY);
  ctx.closePath();
  ctx.fillStyle = mix(P.tableTop[0], P.tableTop[1], s);
  ctx.fill();
  // front slab
  ctx.fillStyle = mix(P.tableEdge[0], P.tableEdge[1], s);
  ctx.fillRect(cx - halfW, surfaceY, halfW * 2, 10);
  // legs
  ctx.fillStyle = mix(P.tableLeg[0], P.tableLeg[1], s);
  ctx.fillRect(cx - halfW + 22, surfaceY + 10, 14, 52);
  ctx.fillRect(cx + halfW - 36, surfaceY + 10, 14, 52);
};

/** One vault level's backdrop. worldTop = wall's top edge in world coords. */
const drawVaultLevel = (
  ctx: CanvasRenderingContext2D,
  camY: number,
  worldTop: number,
  s: number,
  doorCx: number,
) => {
  const y0 = worldTop - camY;
  const wallH = 340;
  // wall gradient
  const grad = ctx.createLinearGradient(0, y0, 0, y0 + wallH);
  grad.addColorStop(0, mix(P.wallTop[0], P.wallTop[1], s));
  grad.addColorStop(1, mix(P.wallBot[0], P.wallBot[1], s));
  ctx.fillStyle = grad;
  ctx.fillRect(0, y0, VAULT_W, wallH);
  // paneling seams
  ctx.strokeStyle = mix(P.panel[0], P.panel[1], s);
  ctx.lineWidth = 2;
  for (const px of [90, 510]) {
    ctx.beginPath();
    ctx.moveTo(px, y0 + 10);
    ctx.lineTo(px, y0 + wallH - 60);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(20, y0 + 48);
  ctx.lineTo(VAULT_W - 20, y0 + 48);
  ctx.stroke();
  // the vault door: concentric rings + spoke handle
  const dcy = y0 + 150;
  ctx.beginPath();
  ctx.arc(doorCx, dcy, 86, 0, Math.PI * 2);
  ctx.fillStyle = mix(P.door[0], P.door[1], s);
  ctx.fill();
  ctx.strokeStyle = mix(DOOR_RING[0], DOOR_RING[1], s);
  for (const [r, lw] of [
    [86, 4],
    [66, 3],
    [30, 3],
  ] as const) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(doorCx, dcy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3 + 0.35;
    ctx.beginPath();
    ctx.moveTo(doorCx - Math.cos(a) * 28, dcy - Math.sin(a) * 28);
    ctx.lineTo(doorCx + Math.cos(a) * 28, dcy + Math.sin(a) * 28);
    ctx.stroke();
  }
  // rivets along the top seam
  ctx.fillStyle = mix(DOOR_RING[0], DOOR_RING[1], s);
  for (let rx = 40; rx < VAULT_W - 20; rx += 65) {
    ctx.beginPath();
    ctx.arc(rx, y0 + 24, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // floor
  ctx.fillStyle = mix(P.floor[0], P.floor[1], s);
  ctx.fillRect(0, y0 + wallH - 44, VAULT_W, 44);
};

const FONT = "Arial, Helvetica, sans-serif";

const fillTextFit = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  weight: string,
  basePx: number,
  maxW: number,
) => {
  let px = basePx;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (px > basePx * 0.55 && ctx.measureText(text).width > maxW) {
    px -= 1;
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  ctx.fillText(text, x, y);
};

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** Paint the animation at time t (seconds, 0..VAULT_DURATION) onto ctx.
 *  The canvas is assumed to be VAULT_W × VAULT_H (caller may scale). */
export const drawVaultFrame = (ctx: CanvasRenderingContext2D, t: number, params: VaultAnimParams): void => {
  const { heights, p1Bills, tumble, bricks } = getChoreography(params);
  const T = VAULT_PHASES;

  // Camera: parked, then an eased descent, then parked on level 2 — with a
  // brief shake when the first heavy stack hits.
  let camY = DESCENT * easeInOutCubic((t - T.descentStart) / (T.impact - T.descentStart));
  if (t < T.descentStart) camY = 0;
  if (t >= T.impact) camY = DESCENT;
  let shake = 0;
  if (t >= T.impact && t < T.impact + 0.45) {
    const dt = t - T.impact;
    shake = 5 * Math.exp(-dt / 0.14) * Math.sin(dt * 55);
  }

  // Scene saturation: hard snap at impact (a fast ramp reads as a snap at
  // 15fps while dodging a single ugly half-toned frame).
  const sat = t < T.impact ? 0 : smoothstep(T.impact, T.impact + 0.18, t);

  ctx.save();
  ctx.clearRect(0, 0, VAULT_W, VAULT_H);
  ctx.translate(0, shake);

  // --- backdrop: two vault levels + the concrete slab that separates them
  drawVaultLevel(ctx, camY, -60, sat, 300); // level 1
  ctx.fillStyle = mix(P.slab[0], P.slab[1], sat); // passing floor slab
  ctx.fillRect(0, 280 + 44 - camY, VAULT_W, 60);
  drawVaultLevel(ctx, camY, 364, sat, 210); // level 2 (door offset — new room)

  // --- level 1 table + phase-1 stack
  const t1y = TABLE1_Y - camY;
  if (t1y > -80 && t1y < VAULT_H + 80) {
    drawTable(ctx, t1y, 150, sat);

    // How much of the neat stack is standing on the table right now?
    const landed = p1Bills.filter(b => t >= b.spawnT + b.fallDur).length;
    let stackH = heights.currentH * easeOutCubic(landed / p1Bills.length);
    // Phase 2: the stack slides right and tips off the edge.
    if (t >= T.descentStart) {
      const slide = easeInQuad((t - T.descentStart) / 0.45);
      if (slide < 1) {
        ctx.save();
        ctx.translate(STACK_X + slide * 150, t1y);
        ctx.rotate(slide * 0.5);
        drawNeatStack(ctx, 0, 0, heights.currentH * (1 - slide * 0.6), 0);
        ctx.restore();
        stackH = 0;
      } else {
        stackH = 0; // fully gone — its bills are the tumble sprites now
      }
    }
    if (stackH > 0) drawNeatStack(ctx, STACK_X, t1y, stackH, 0);

    // Phase-1 falling bills (screen-space above the table).
    if (t < T.descentStart) {
      for (const b of p1Bills) {
        const p = (t - b.spawnT) / b.fallDur;
        if (p <= 0 || p >= 1) continue;
        const fall = easeInQuad(p);
        const y = -30 + (t1y - BILL_H - -30) * fall;
        const x = b.x0 + (b.x1 - b.x0) * p + Math.sin(p * Math.PI * 3 + b.swayPhase) * b.swayAmp * (1 - p);
        drawBill(ctx, x, y, Math.sin(p * Math.PI * 2 + b.swayPhase) * b.spin * (1 - p * 0.6), 0);
      }
    }
  }

  // --- level 2 table + the Hometown pile
  const t2y = TABLE2_Y - camY;
  if (t2y > -80 && t2y < VAULT_H + 120) {
    drawTable(ctx, t2y, 170, sat);

    // Built height per column right now (for landing bills to sit on).
    const built: [number, number, number] = [0, 0, 0];
    for (const b of bricks) {
      if (t >= b.landT) built[b.col + 1] = Math.max(built[b.col + 1], (b.row + 1) * BRICK_H);
    }

    // Bricks: landed ones stacked; airborne ones streaking down.
    for (const b of bricks) {
      const cx = STACK_X + COL_X[b.col + 1] + b.xJitter;
      const bottom = t2y - b.row * BRICK_H;
      if (t >= b.landT) {
        const sinceLand = t - b.landT;
        const squash = sinceLand < 0.14 ? 1 - sinceLand / 0.14 : 0;
        drawBrick(ctx, cx, bottom, b.w, sat, squash);
      } else if (t >= b.landT - 0.3) {
        // 0.3s accelerating drop from above the frame
        const p = easeInQuad((t - (b.landT - 0.3)) / 0.3);
        const yStart = -40;
        const y = yStart + (bottom - yStart) * p;
        drawBrick(ctx, cx, y, b.w, 1, 0); // fully colored — it BRINGS the color into the gray vault
      }
    }

    // Impact flash + dust at the first slam.
    if (t >= T.impact && t < T.impact + 0.3) {
      const p = (t - T.impact) / 0.3;
      const flash = ctx.createRadialGradient(STACK_X, t2y - 20, 10, STACK_X, t2y - 20, 320);
      flash.addColorStop(0, `rgba(255,255,255,${0.55 * (1 - p)})`);
      flash.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = flash;
      ctx.fillRect(0, 0, VAULT_W, VAULT_H);
      // dust kicks
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - p)})`;
      ctx.lineWidth = 2;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(STACK_X + dir * 60, t2y - 4);
        ctx.lineTo(STACK_X + dir * (60 + 46 * p), t2y - 10 - 18 * p);
        ctx.stroke();
      }
    }

  }

  // --- tumbling bills (drawn outside the level-2 gate: they're on screen for
  // the whole descent, long before level 2's table scrolls into view)
  {
    // Built height per column (same math as the brick pass above).
    const built: [number, number, number] = [0, 0, 0];
    for (const b of bricks) {
      if (t >= b.landT) built[b.col + 1] = Math.max(built[b.col + 1], (b.row + 1) * BRICK_H);
    }
    for (const b of tumble) {
      if (t < b.releaseT) continue;
      const colIdx = b.x1 < STACK_X - 49 ? 0 : b.x1 > STACK_X + 49 ? 2 : 1;
      const restY = t2y - built[colIdx] - 3;
      if (t >= b.landT) {
        // resting on whatever its landing column has built so far
        drawBill(ctx, b.x1, restY, Math.sin(b.swayPhase) * 0.15, 1);
        continue;
      }
      const p = clamp01((t - b.releaseT) / (b.landT - b.releaseT));
      // The bills ride WITH the camera: they leave the table edge, then hold
      // a screen-space hover band — tumbling in place while the vault walls
      // streak past — and settle onto the pile once the camera parks. (The
      // "falling elevator" illusion: we fall together, so they appear to float.)
      const bandY = b.hoverY + Math.sin(p * Math.PI * 2.2 + b.swayPhase) * 10;
      const enterY = TABLE1_Y - camY - 14; // where it tipped off the table
      let y: number;
      if (p < 0.2) y = enterY + (bandY - enterY) * smoothstep(0, 0.2, p);
      else if (p < 0.72) y = bandY;
      else y = bandY + (restY - bandY) * easeInQuad((p - 0.72) / 0.28);
      const x = b.x0 + (b.x1 - b.x0) * smoothstep(0.15, 0.95, p) + Math.sin(p * Math.PI * 4 + b.swayPhase) * 26 * (1 - p);
      // gray → green as it falls: the bill carries the first color
      const g = Math.max(sat, smoothstep(0.25, 0.85, p));
      drawBill(ctx, x, y, (p * b.spinSpeed * b.spinDir) % (Math.PI * 2), g);
    }
  }

  // --- closing card
  if (t >= T.cardStart) {
    const a = smoothstep(T.cardStart, T.cardStart + 0.45, t);
    ctx.fillStyle = `rgba(8,14,26,${0.62 * a})`;
    ctx.fillRect(0, 0, VAULT_W, VAULT_H);

    ctx.globalAlpha = a;
    const panelW = 520;
    const panelH = 168;
    const px = (VAULT_W - panelW) / 2;
    const py = (VAULT_H - panelH) / 2 - 8;
    roundedRect(ctx, px, py, panelW, panelH, 12);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // divider
    ctx.strokeStyle = "#e4e7ec";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(VAULT_W / 2 - 30, py + 22);
    ctx.lineTo(VAULT_W / 2 - 30, py + panelH - 22);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // left: current, gray and smaller
    const lcx = px + (panelW / 2 - 30) / 2;
    ctx.fillStyle = BRAND.grayMid;
    fillTextFit(ctx, "CURRENT", lcx, py + 52, "bold", 15, 190);
    ctx.fillStyle = BRAND.grayDark;
    fillTextFit(ctx, params.currentLabel, lcx, py + 96, "bold", 32, 200);
    // right: Hometown, navy/mint and bigger
    const rcx = px + panelW / 2 - 30 + (panelW / 2 + 30) / 2;
    ctx.fillStyle = BRAND.green;
    fillTextFit(ctx, "AT HOMETOWN LENDING", rcx, py + 48, "bold", 15, 240);
    ctx.fillStyle = BRAND.navy;
    fillTextFit(ctx, params.htlLabel, rcx, py + 98, "bold", 44, 250);
    // The GIF travels without the email around it, so the closing card
    // carries its own disclaimer.
    ctx.fillStyle = BRAND.grayMid;
    ctx.font = `italic 11px ${FONT}`;
    ctx.fillText("All figures are illustrative.", VAULT_W / 2, py + panelH - 16);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
};
