// "Your ceiling just moved." — the full-body comparison visual for the recap
// email. The artwork at /email/ceiling-blank.png is the owner's TEMPLATE and
// is never modified: headline, column headings, captions, the gold gain
// bubble, the mountain, and the disclaimer are all baked into the file. This
// module only drops the recruit's NUMBERS (RETR-fed) into the template's
// empty value boxes on an in-memory canvas copy — nothing else is drawn.
//
// Same contract as recapChart.ts: pure function of the RecapPayload, client-
// side canvas, returns base64 PNG (no "data:" prefix) or null, never throws,
// never blocks a send. Null falls back to the classic comparison chart at the
// call sites, so a missing/unreadable artwork file degrades gracefully.
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { FONT, fillTextFit } from "@/lib/recapChart";
import { fmtUSD } from "@/lib/proforma";

export const CEILING_SRC = "/email/ceiling-blank.png";
export const CEILING_WIDTH = 600; // CSS px — matches the email's 600px container

// The true gold amber of the template's right column, and the dark ink used
// inside its gold gain bubble.
const GOLD = "#F0A81F";
const INK_ON_GOLD = "#231a05";
const WHITE = "#f2f2f2";

// send-recap/index.ts caps chartPng at MAX_CHART_B64_CHARS = 2_000_000 b64
// chars (~1.5 MB decoded). Keep a safety margin; if a render overshoots we
// step the scale down rather than get 400'd at send time.
const MAX_B64_CHARS = 1_900_000;
const SCALE_LADDER = [2, 1.5, 1.25, 1];

// ── Value slots ──────────────────────────────────────────────────────────
// One entry per number the template expects, as FRACTIONS of the artwork's
// width/height so the same table works at any render scale. These are the
// empty box interiors of the committed template; when the owner exports a
// new template from Gamma, this table is the ONLY thing to recalibrate.
// `fill` (optional) repaints the slot's interior first — needed only if a
// template ships with placeholder text baked inside the boxes.
interface Slot { x: number; y: number; w: number; h: number; color: string; fill?: string }
const SLOTS: Record<keyof CeilingData, Slot> = {
  gain:          { x: 0.550,  y: 0.2661, w: 0.400, h: 0.0367, color: INK_ON_GOLD },
  currentIncome: { x: 0.0583, y: 0.5138, w: 0.400, h: 0.0569, color: WHITE },
  htlIncome:     { x: 0.5417, y: 0.5138, w: 0.400, h: 0.0569, color: GOLD },
  volume:        { x: 0.0583, y: 0.6330, w: 0.400, h: 0.0569, color: WHITE },
  htlVolume:     { x: 0.5417, y: 0.6330, w: 0.400, h: 0.0569, color: GOLD },
  currentBps:    { x: 0.0583, y: 0.7523, w: 0.400, h: 0.0569, color: WHITE },
  htlBps:        { x: 0.5417, y: 0.7523, w: 0.400, h: 0.0569, color: GOLD },
};

export interface CeilingData {
  currentIncome: string;
  htlIncome: string;
  volume: string;
  htlVolume: string;
  currentBps: string;
  htlBps: string;
  gain: string;
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
  return {
    currentIncome: fmtUSD(cur),
    htlIncome: fmtUSD(htl),
    volume,
    htlVolume: volume,
    currentBps: `${safe(r.currentBps)} BPS`,
    htlBps: effBps == null ? "—" : `${effBps} BPS`,
    gain: fmtUSD(htl - cur),
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
      ctx.font = `bold 26px ${FONT}`;

      // Numbers only — everything else is baked into the template.
      for (const key of Object.keys(SLOTS) as Array<keyof CeilingData>) {
        const s = SLOTS[key];
        const x = s.x * W, y = s.y * H, w = s.w * W, h = s.h * H;
        if (s.fill) {
          ctx.fillStyle = s.fill;
          ctx.fillRect(x, y, w, h);
        }
        ctx.fillStyle = s.color;
        fillTextFit(ctx, data[key], x + w / 2, y + h / 2, "bold", 26, w - 28);
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
