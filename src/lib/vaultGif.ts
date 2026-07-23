// Renders the vault animation (vaultAnimation.ts) to an animated GIF in the
// browser, for inline embedding at the top of the recap email.
//
// Same contract as renderRecapChartPng: pure function of the recap numbers,
// returns null whenever rendering isn't possible (no DOM, no 2D context) —
// the email then simply goes out without the hero animation. A send is never
// blocked by the GIF.
//
// Email constraints drive the encoding choices:
//  - Graph's sendMail caps the whole message around 4MB, and base64 inflates
//    bytes ~1.37x, so the GIF gets a hard 2MB budget. If a render exceeds it,
//    we retry down a quality ladder (fewer fps, then narrower) until it fits.
//  - The user-approved behavior is "play ~3 times, then hold on the closing
//    card": NETSCAPE loop count 2 = two repeats after the first play, and the
//    final frame carries a long delay so each pass rests on the numbers.
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import {
  drawVaultFrame,
  VAULT_W,
  VAULT_H,
  VAULT_DURATION,
  type VaultAnimParams,
} from "@/lib/vaultAnimation";
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { fmtUSD } from "@/lib/proforma";

/** Animation params from a recap, or null when there's no comparison story to
 *  tell — same eligibility rule as the chart (prepareChartData): the vault
 *  narrative IS the current-vs-HTL comparison, so no comparison, no GIF. */
export const vaultParamsFromRecap = (r: RecapPayload): VaultAnimParams | null => {
  if (r.currentBps == null || r.current.annual == null) return null;
  const cur = r.current.annual;
  const htl = r.htl.annual;
  if (!isFinite(cur) || !isFinite(htl) || cur <= 0 || htl <= 0) return null;
  return { currentAnnual: cur, htlAnnual: htl, currentLabel: fmtUSD(cur), htlLabel: fmtUSD(htl) };
};

export const GIF_BYTE_BUDGET = 2 * 1024 * 1024; // hard cap, see above
/** Quality ladder, best first. Every rung keeps the full 10-second story. */
const LADDER: ReadonlyArray<{ fps: number; width: number }> = [
  { fps: 15, width: 600 },
  { fps: 12, width: 600 },
  { fps: 12, width: 540 },
  { fps: 10, width: 480 },
];
const REPEAT_COUNT = 2; // NETSCAPE ext: 2 extra plays ≈ "play 3x, then hold"
const FINAL_FRAME_HOLD_MS = 2200; // rest on the closing card each pass

/** Encode one rung of the ladder. Throws only on unexpected encoder errors. */
const encodeAt = (params: VaultAnimParams, fps: number, width: number): Uint8Array => {
  const height = Math.round((width / VAULT_W) * VAULT_H);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(width / VAULT_W, height / VAULT_H);

  const gif = GIFEncoder();
  const frameCount = Math.round(VAULT_DURATION * fps);
  const delayMs = Math.round(1000 / fps);

  for (let i = 0; i < frameCount; i++) {
    const t = (i / (frameCount - 1)) * VAULT_DURATION;
    // The renderer treats the canvas as 600×338; the ctx scale maps it down.
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, VAULT_W, VAULT_H);
    drawVaultFrame(ctx, Math.min(t, VAULT_DURATION), params);
    ctx.restore();

    const { data } = ctx.getImageData(0, 0, width, height);
    // Per-frame palettes: the scene is grayscale for half the story and
    // vibrant for the rest — one global palette would starve both halves.
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    const isLast = i === frameCount - 1;
    gif.writeFrame(index, width, height, {
      palette,
      delay: isLast ? FINAL_FRAME_HOLD_MS : delayMs,
      // repeat is written with the first frame's control block
      ...(i === 0 ? { repeat: REPEAT_COUNT } : {}),
    });
  }
  gif.finish();
  return gif.bytes();
};

/** Animated GIF bytes for the recap hero, or null. Never throws. */
export const renderVaultGif = (params: VaultAnimParams): Uint8Array | null => {
  if (typeof document === "undefined") return null;
  try {
    for (const rung of LADDER) {
      const bytes = encodeAt(params, rung.fps, rung.width);
      if (bytes.byteLength <= GIF_BYTE_BUDGET) return bytes;
    }
    // Even the smallest rung blew the budget — ship the email without it.
    return null;
  } catch {
    return null;
  }
};

/** Base64 (no data: prefix) for the Edge Function payload, or null. */
export const renderVaultGifBase64 = (params: VaultAnimParams): string | null => {
  const bytes = renderVaultGif(params);
  if (!bytes) return null;
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack limits on multi-MB arrays
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};
