// Rasterizes the earnings comparison (grayscale "current platform" on the
// left, larger brand-color Hometown Lending panel on the right) to a PNG for
// inline embedding in the recap email. A pure function of the RecapPayload
// numbers, so a resend paints exactly the image the original send did.
//
// Returns null whenever rendering isn't possible — no comparison entered, no
// DOM, or no canvas 2D context (jsdom) — and the email then falls back to its
// HTML comparison cells, so a send is never blocked by the chart.
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { BRAND } from "../../supabase/functions/send-recap/template";
import { fmtUSD } from "@/lib/proforma";

// Sized for phones: the <img> is fluid, so a 600-wide design renders at
// ~0.57x on a 360dp screen — fonts below are chosen to stay legible there.
export const CHART_WIDTH = 600; // CSS px — matches the email's 600px container
export const CHART_HEIGHT = 310;
export const CHART_SCALE = 2; // retina: physical canvas is 1200×620

export interface RecapChartPanel {
  title: string;
  subtitle: string;
  annual: string;
  monthly: string;
  /** Bar length as a share of the larger annual amount, clamped to [0.02, 1]. */
  barFrac: number;
}

export interface RecapChartData {
  current: RecapChartPanel;
  htl: RecapChartPanel;
}

/** Pure data prep, unit-testable without a canvas. Null = no comparison to draw. */
export const prepareChartData = (r: RecapPayload): RecapChartData | null => {
  if (r.currentBps == null || r.current.annual == null) return null;
  const safe = (v: number | null | undefined) => (v != null && isFinite(v) ? v : 0);
  const cur = safe(r.current.annual);
  const htl = safe(r.htl.annual);
  const max = Math.max(cur, htl, 1);
  const frac = (v: number) => Math.min(1, Math.max(0.02, v / max));
  return {
    current: {
      title: "CURRENT PLATFORM",
      subtitle: `${r.currentBps} BPS`,
      annual: fmtUSD(cur),
      monthly: `${fmtUSD(safe(r.current.monthly))} / month`,
      barFrac: frac(cur),
    },
    htl: {
      title: "HOMETOWN LENDING",
      subtitle: `${r.corrActive ? "Broker + Correspondent" : "Broker Only"} · ${r.loSplit}% split`,
      annual: fmtUSD(htl),
      monthly: `${fmtUSD(safe(r.htl.monthly))} / month`,
      barFrac: frac(htl),
    },
  };
};

const FONT = "Arial, Helvetica, sans-serif";

// Manual path instead of ctx.roundRect — older Safari lacks it.
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

// letterSpacing is Chromium-only; purely cosmetic elsewhere.
const setLetterSpacing = (ctx: CanvasRenderingContext2D, v: string) => {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = v;
};

// Shrinks the font until the text fits — eight-figure producers exist.
const fillTextFit = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, weight: string, basePx: number, maxW: number) => {
  let px = basePx;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (px > basePx * 0.6 && ctx.measureText(text).width > maxW) {
    px -= 1;
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  ctx.fillText(text, x, y);
};

const drawBar = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, track: string, fill: string) => {
  roundedRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = track;
  ctx.fill();
  const fw = Math.max(w * frac, h); // never thinner than its own end caps
  roundedRect(ctx, x, y, fw, h, h / 2);
  ctx.fillStyle = fill;
  ctx.fill();
};

/** Base64 PNG (no "data:" prefix), or null. Never throws. */
export const renderRecapChartPng = (r: RecapPayload): string | null => {
  const data = prepareChartData(r);
  if (!data) return null;
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = CHART_WIDTH * CHART_SCALE;
    canvas.height = CHART_HEIGHT * CHART_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null; // jsdom and other canvas-less DOMs
    ctx.scale(CHART_SCALE, CHART_SCALE);

    // Opaque white base so dark-mode email clients don't recolor the margins.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Left panel: current platform, strictly grayscale, deliberately smaller.
    roundedRect(ctx, 24, 45, 254, 220, 8);
    ctx.fillStyle = BRAND.grayBg;
    ctx.fill();
    const lcx = 24 + 254 / 2;
    setLetterSpacing(ctx, "1.5px");
    ctx.fillStyle = BRAND.grayMid;
    fillTextFit(ctx, data.current.title, lcx, 82, "bold", 16, 214);
    setLetterSpacing(ctx, "0px");
    ctx.font = `16px ${FONT}`;
    ctx.fillText(data.current.subtitle, lcx, 110);
    ctx.fillStyle = BRAND.grayDark;
    fillTextFit(ctx, data.current.annual, lcx, 150, "bold", 32, 214);
    ctx.fillStyle = BRAND.grayMid;
    ctx.font = `17px ${FONT}`;
    ctx.fillText(data.current.monthly, lcx, 182);
    drawBar(ctx, 44, 208, 214, 10, data.current.barFrac, "#e0e0e0", BRAND.grayMid);

    // Right panel: Hometown Lending, brand color, larger.
    roundedRect(ctx, 300, 19, 276, 272, 8);
    ctx.fillStyle = BRAND.navy;
    ctx.fill();
    const rcx = 300 + 276 / 2;
    setLetterSpacing(ctx, "1.5px");
    ctx.fillStyle = BRAND.mint;
    fillTextFit(ctx, data.htl.title, rcx, 62, "bold", 16, 236);
    setLetterSpacing(ctx, "0px");
    ctx.fillStyle = "#ffffff";
    fillTextFit(ctx, data.htl.subtitle, rcx, 92, "normal", 16, 236);
    ctx.fillStyle = BRAND.mint;
    fillTextFit(ctx, data.htl.annual, rcx, 146, "bold", 46, 236);
    ctx.fillStyle = "#d5ece2";
    ctx.font = `17px ${FONT}`;
    ctx.fillText(data.htl.monthly, rcx, 186);
    drawBar(ctx, 320, 222, 236, 12, data.htl.barFrac, "#24406e", BRAND.mint);

    const url = canvas.toDataURL("image/png");
    if (!url.startsWith("data:image/png;base64,")) return null;
    return url.slice("data:image/png;base64,".length);
  } catch {
    return null;
  }
};
