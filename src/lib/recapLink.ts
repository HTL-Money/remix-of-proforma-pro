import type { RecapPayload } from "../../supabase/functions/send-recap/template";

// The hosted recap page (/r) carries its data IN THE LINK — a base64url of the
// recap JSON — rather than reading the database. Two reasons this is the right
// design here:
//   1. Anonymous visitors have zero read access to `proformas` by design (so
//      nobody can enumerate submissions); a self-contained link never needs to
//      weaken that.
//   2. The link stays valid when the recruit forwards the email — the numbers
//      travel with it, no expiring token, no server round-trip.
// The recap payload holds only shareable numbers (never employee comp), so
// carrying it in the URL exposes nothing the email didn't already contain.

const toB64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const encodeRecap = (recap: RecapPayload): string => toB64Url(JSON.stringify(recap));

/** Decodes the `?d=` param back to a recap. Returns null on any malformed
 *  input (truncated link, tampering, garbage) — the page shows a friendly
 *  "link isn't valid" state rather than crashing. */
export const decodeRecap = (param: string | null | undefined): RecapPayload | null => {
  if (!param) return null;
  try {
    const obj = JSON.parse(fromB64Url(param)) as RecapPayload;
    // Minimal shape check — enough to know it's a real recap, not a stray param.
    if (!obj || typeof obj !== "object" || !obj.htl || !obj.totals) return null;
    return obj;
  } catch {
    return null;
  }
};

export const buildRecapPageUrl = (recap: RecapPayload, origin: string): string =>
  `${origin.replace(/\/$/, "")}/r?d=${encodeRecap(recap)}`;
