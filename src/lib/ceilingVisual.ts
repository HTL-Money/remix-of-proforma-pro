// "Your ceiling just moved." — the full-body comparison visual for the recap
// email. Composites the recruit's numbers over the owner-supplied artwork at
// /email/ceiling-blank.png (mountain render, headline and disclaimer are baked
// into the artwork; the columns below are painted here from the labeled spec).
//
// Same contract as recapChart.ts: pure function of the RecapPayload, client-
// side canvas, returns base64 PNG (no "data:" prefix) or null, never throws,
// never blocks a send. Null falls back to the classic comparison chart at the
// call sites, so a missing/unreadable artwork file degrades gracefully.
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { FONT, roundedRect, fillTextFit, setLetterSpacing } from "@/lib/recapChart";
import { fmtUSD } from "@/lib/proforma";

export const CEILING_SRC = "/email/ceiling-blank.png";
export const CEILING_WIDTH = 600; // CSS px — matches the email's 600px container

// The true gold amber. Deliberately NOT the app's light-mode --accent (that
// resolves to green); this is the dark-theme brand amber, same as the gain
// bubble in the owner's artwork.
const GOLD = "#F0A81F";
const NAVY_BOX = "#111f3d"; // solid box fill over the artwork's right column
const GRAY_BOX = "#242424"; // solid box fill over the artwork's left column

// send-recap/index.ts caps chartPng at MAX_CHART_B64_CHARS = 2_000_000 b64
// chars (~1.5 MB decoded). Keep a safety margin; if a render overshoots we
// step the scale down rather than get 400'd at send time.
const MAX_B64_CHARS = 1_900_000;
const SCALE_LADDER = [2, 1.5, 1.25, 1];

// ── Layout ───────────────────────────────────────────────────────────────
// All coordinates are FRACTIONS of the artwork's width/height so the same
// table works at any render scale. Estimated against the supplied artwork;
// tune here (single table) during the live screenshot pass once the real
// file is committed.
const L = {
  colLeftX: 0.055, colWidth: 0.385, // left column boxes
  colRightX: 0.560,                 // right column boxes (same width)
  headingY: 0.225,                  // "Current Status" / "HTL Potential" row
  bubble: { x: 0.605, y: 0.265, w: 0.31, h: 0.075 }, // gold gain bubble
  rows: [0.40, 0.55, 0.70],         // three value rows per side (box tops)
  boxH: 0.075,
  captionPad: 0.018,                // caption sits this far under its box
} as const;

export interface CeilingData {
  currentIncome: string;
  htlIncome: string;
  volume: string;
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
  return {
    currentIncome: fmtUSD(cur),
    htlIncome: fmtUSD(htl),
    volume: fmtUSD(vol, { compact: true }),
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

    // The headline is serif in the artwork; match it for our column headings.
    // Playfair is already a page webfont — load it or fall back silently to
    // Georgia (canvas falls back on its own; this just avoids a flash-of-Arial
    // on the very first render).
    try {
      await document.fonts?.load('700 32px "Playfair Display"');
    } catch { /* Georgia fallback below */ }
    const SERIF = '"Playfair Display", Georgia, "Times New Roman", serif';

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

      const fx = (f: number) => f * W;
      const fy = (f: number) => f * H;
      const boxW = fx(L.colWidth);
      const boxH = fy(L.boxH);
      const leftCx = fx(L.colLeftX) + boxW / 2;
      const rightCx = fx(L.colRightX) + boxW / 2;

      // Column headings (spec puts them at the top).
      setLetterSpacing(ctx, "0.5px");
      ctx.font = `700 21px ${SERIF}`;
      ctx.fillStyle = "#9a9a9a";
      ctx.fillText("Current Status", leftCx, fy(L.headingY));
      ctx.fillStyle = GOLD;
      ctx.fillText("Hometown Lending Potential", rightCx, fy(L.headingY));
      setLetterSpacing(ctx, "0px");

      // Gold gain bubble with pointer.
      const b = { x: fx(L.bubble.x), y: fy(L.bubble.y), w: fx(L.bubble.w), h: fy(L.bubble.h) };
      roundedRect(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.fillStyle = GOLD;
      ctx.fill();
      ctx.beginPath(); // pointer tip
      ctx.moveTo(b.x + b.w / 2 - 10, b.y + b.h);
      ctx.lineTo(b.x + b.w / 2 + 10, b.y + b.h);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h + 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#231a05";
      fillTextFit(ctx, data.gain, b.x + b.w / 2, b.y + b.h * 0.38, "bold", 26, b.w - 24);
      ctx.font = `12px ${FONT}`;
      ctx.fillText("Headline one-year gain", b.x + b.w / 2, b.y + b.h * 0.74);

      // The three value rows per side, captions beneath (per the labeled spec).
      const rows: Array<{ value: string; caption: string; hValue: string; hCaption: string }> = [
        { value: data.currentIncome, caption: "Current annual income", hValue: data.htlIncome, hCaption: "Annual income at Hometown Lending" },
        { value: data.volume, caption: "Annual funded volume", hValue: data.volume, hCaption: "Annual funded volume" },
        { value: data.currentBps, caption: "Basis points", hValue: data.htlBps, hCaption: "Effective basis points" },
      ];
      rows.forEach((row, i) => {
        const y = fy(L.rows[i]);
        // Left: muted gray panel, white value, gray caption.
        roundedRect(ctx, fx(L.colLeftX), y, boxW, boxH, 6);
        ctx.fillStyle = GRAY_BOX;
        ctx.fill();
        ctx.fillStyle = "#f2f2f2";
        fillTextFit(ctx, row.value, leftCx, y + boxH / 2, "bold", 26, boxW - 28);
        ctx.fillStyle = "#9a9a9a";
        ctx.font = `14px ${FONT}`;
        ctx.fillText(row.caption, leftCx, y + boxH + fy(L.captionPad) + 8);

        // Right: navy panel with gold border, gold value, gold caption.
        roundedRect(ctx, fx(L.colRightX), y, boxW, boxH, 6);
        ctx.fillStyle = NAVY_BOX;
        ctx.fill();
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = GOLD;
        fillTextFit(ctx, row.hValue, rightCx, y + boxH / 2, "bold", 26, boxW - 28);
        ctx.font = `14px ${FONT}`;
        ctx.fillText(row.hCaption, rightCx, y + boxH + fy(L.captionPad) + 8);
      });

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
