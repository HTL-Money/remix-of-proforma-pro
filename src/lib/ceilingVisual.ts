// "Your ceiling just moved." — the full-body comparison visual for the recap
// email: the recruit's pay today on the left, what the same production earns
// at Hometown Lending on the right. The artwork at /email/ceiling-template.jpg
// is the owner's TEMPLATE and is never modified: headline, column headings,
// captions, the gold gain bubble, the mountains, and the disclaimer are all
// baked into the file. This module only drops the recruit's NUMBERS (RETR-fed)
// into the template's empty value boxes on an in-memory canvas copy — nothing
// else is drawn.
//
// JPEG, not PNG: the artwork is photographic (brushed-gold and low-poly
// gradients), where PNG cost 2.7 MB against 440 KB for a visually identical
// q92 JPEG. Only the template's encoding changed — the rendered email image
// this module returns is still PNG.
//
// Same contract as recapChart.ts: pure function of the RecapPayload, client-
// side canvas, returns base64 PNG (no "data:" prefix) or null, never throws,
// never blocks a send. Null falls back to the classic comparison chart at the
// call sites, so a missing/unreadable artwork file degrades gracefully.
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { FONT, fillTextFit } from "@/lib/recapChart";
import { fmtUSD } from "@/lib/proforma";

export const CEILING_SRC = "/email/ceiling-template.jpg";
export const CEILING_WIDTH = 600; // CSS px — matches the email's 600px container

// The true gold amber of the template's right column, and the dark ink used
// inside its gold gain bubble.
const GOLD = "#F0A81F";
const INK_ON_GOLD = "#231a05";
const WHITE = "#f2f2f2";

// send-recap/index.ts caps chartPng at MAX_CHART_B64_CHARS = 2_000_000 b64
// chars and rejects anything larger with a 400, so stay under that here and
// step the scale down rather than fail at send time.
//
// This artwork is photographic, so its PNG is heavy: measured in Chromium at
// 600 CSS px wide, the rungs come out at 4.11M (2x), 2.58M (1.5x), 1.92M
// (1.25x) and 1.31M (1x) b64 chars. Only the bottom two fit, and the margin
// below is set to admit 1.25x — a sharper image on high-DPI screens — while
// staying clear of the function's hard limit. Overshooting is harmless: the
// ladder just falls through to 1x.
const MAX_B64_CHARS = 1_950_000;
const SCALE_LADDER = [2, 1.5, 1.25, 1];

// ── Value slots ──────────────────────────────────────────────────────────
// One entry per number the template expects, as FRACTIONS of the artwork's
// width/height so the same table works at any render scale. These are the
// empty box interiors of the committed template; when the owner exports a new
// template, this table is the ONLY thing to recalibrate. Measured off the
// 2160x3840 master by detecting each box's text band, so a value lands on the
// same baseline the placeholder occupied.
interface Slot { x: number; y: number; w: number; h: number; color: string }
const SLOTS: Record<keyof CeilingData, Slot> = {
  gain:          { x: 0.57870, y: 0.16302, w: 0.35880, h: 0.02786, color: INK_ON_GOLD },
  currentIncome: { x: 0.11898, y: 0.73438, w: 0.24352, h: 0.01615, color: WHITE },
  volume:        { x: 0.11898, y: 0.78125, w: 0.24352, h: 0.01745, color: WHITE },
  currentBps:    { x: 0.11898, y: 0.82812, w: 0.24352, h: 0.01667, color: WHITE },
  htlIncome:     { x: 0.58426, y: 0.62448, w: 0.33611, h: 0.02318, color: GOLD },
  htlVolume:     { x: 0.58426, y: 0.68854, w: 0.33611, h: 0.02370, color: GOLD },
  htlBps:        { x: 0.58426, y: 0.75156, w: 0.33611, h: 0.02448, color: GOLD },
  monthlyGain:   { x: 0.58426, y: 0.81406, w: 0.33611, h: 0.02318, color: GOLD },
};

export interface CeilingData {
  currentIncome: string;
  htlIncome: string;
  volume: string;
  htlVolume: string;
  currentBps: string;
  htlBps: string;
  gain: string;
  /** The annual gain restated per month — the template's fourth right-hand
   *  box, which shipped bordered but empty. */
  monthlyGain: string;
}

/** Pure data prep, unit-testable without canvas. Null = no comparison
 *  (no BPS entered) — mirrors prepareChartData's eligibility exactly. */
export const prepareCeilingData = (r: RecapPayload): CeilingData | null => {
  if (r.currentBps == null || r.current.annual == null) return null;
  const safe = (v: number | null | undefined) => (v != null && isFinite(v) ? v : 0);
  const cur = safe(r.current.annual);
  const htl = safe(r.htl.annual);
  const vol = safe(r.volume);
  // Effective BPS on the HTL side: net ÷ volume, so the two BPS boxes compare
  // like-for-like against the BPS the recruit entered at the gate.
  const effBps = vol > 0 ? Math.round((htl / vol) * 10_000) : null;
  const volume = fmtUSD(vol, { compact: true });
  const gain = htl - cur;
  // Signed, because a recruit already paid above the HTL grid must not be shown
  // a bare number that reads as a raise. (send-recap suppresses those sends
  // outright; the visual still has to be honest if one ever renders.)
  const signed = (v: number) => `${v >= 0 ? "+" : "−"}${fmtUSD(Math.abs(v))}`;
  return {
    currentIncome: fmtUSD(cur),
    htlIncome: fmtUSD(htl),
    volume,
    htlVolume: volume,
    currentBps: `${safe(r.currentBps)} BPS`,
    htlBps: effBps == null ? "—" : `${effBps} BPS`,
    gain: signed(gain),
    monthlyGain: signed(gain / 12),
  };
};

const loadArtwork = (): Promise<HTMLImageElement | null> =>
  new Promise(resolve => {
    try {
      const img = new Image();
      // jsdom's Image never fires load OR error; a real browser can also
      // stall on a dropped connection. Either way: give up, render nothing,
      // let the call site fall back to the classic chart.
      const timer = setTimeout(() => resolve(null), 10_000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = CEILING_SRC;
    } catch {
      resolve(null);
    }
  });

/** Base64 PNG (no "data:" prefix), or null. Never throws, never blocks. */
export const renderCeilingVisualPng = async (r: RecapPayload): Promise<string | null> => {
  const data = prepareCeilingData(r);
  if (!data) return null;
  if (typeof document === "undefined") return null;
  try {
    // Probe canvas support BEFORE fetching artwork — jsdom (and any other
    // canvas-less DOM) fails this instantly, instead of waiting out the
    // image-load timeout for a render that could never happen.
    if (!document.createElement("canvas").getContext("2d")) return null;
    const art = await loadArtwork();
    if (!art || !art.naturalWidth || !art.naturalHeight) return null;

    const aspect = art.naturalHeight / art.naturalWidth;

    for (const scale of SCALE_LADDER) {
      const W = CEILING_WIDTH;
      const H = Math.round(W * aspect);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(W * scale);
      canvas.height = Math.round(H * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null; // jsdom
      ctx.scale(scale, scale);

      ctx.drawImage(art, 0, 0, W, H);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Numbers only — everything else is baked into the template. Each slot
      // is the text band the placeholder occupied, and the boxes are not all
      // one size (the gold gain bubble is much larger than a left-column box),
      // so the type size comes from the slot's own height rather than a single
      // constant: digits and "$" span about 0.78 em, hence the 1.28 factor.
      // fillTextFit still shrinks anything too wide for its box.
      for (const key of Object.keys(SLOTS) as Array<keyof CeilingData>) {
        const s = SLOTS[key];
        const x = s.x * W, y = s.y * H, w = s.w * W, h = s.h * H;
        ctx.fillStyle = s.color;
        fillTextFit(ctx, data[key], x + w / 2, y + h / 2, "bold", Math.round(h * 1.28), w - 16);
      }

      const url = canvas.toDataURL("image/png");
      if (!url.startsWith("data:image/png;base64,")) return null;
      const b64 = url.slice("data:image/png;base64,".length);
      // Within the function's validator budget → ship it. Otherwise try the
      // next rung down; a 600-wide @1x render is always comfortably under.
      if (b64.length <= MAX_B64_CHARS) return b64;
    }
    return null;
  } catch {
    return null;
  }
};
