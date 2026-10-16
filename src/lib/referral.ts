// Recruit-PURL plumbing shared by the visitor flow (capture ?ref=, remember
// it for the session, attach it to the send) and the team's /links page
// (build the URL to hand out). The token itself is minted by the DB
// (referral_links, encode(gen_random_bytes(8),'hex')) and resolved to its
// creating LO server-side in send-recap — the client only ever carries it.

/** Mirror of the server's REFERRAL_TOKEN_RE (sourcing.ts): 16 lowercase hex. */
export const REFERRAL_TOKEN_RE = /^[0-9a-f]{16}$/;

const REF_KEY = "htl_ref_token_v1";
// sessionStorage is per tab: a recruit who comes back later, or whose mail app
// opened the link in a webview and then handed it to the browser, arrived with
// no attribution. The token is mirrored to localStorage with a TTL as the
// fallback — long enough to cover "I'll look at this next week", short enough
// that a shared machine doesn't credit one LO forever.
const REF_LOCAL_KEY = "htl_ref_token_v2";
export const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Validates and stashes a ?ref= value for the session (and, with a TTL, for
 *  later visits). Bad shapes are dropped silently — a mangled link still gets
 *  a working calculator. */
export const storeReferralToken = (raw: string | null, nowMs: number = Date.now()): void => {
  if (raw && REFERRAL_TOKEN_RE.test(raw)) {
    try { sessionStorage.setItem(REF_KEY, raw); } catch { /* storage disabled — un-referred visit */ }
    try { localStorage.setItem(REF_LOCAL_KEY, JSON.stringify({ t: raw, exp: nowMs + REF_TTL_MS })); } catch { /* same */ }
  }
};

export const getReferralToken = (nowMs: number = Date.now()): string | null => {
  try {
    const t = sessionStorage.getItem(REF_KEY);
    if (t && REFERRAL_TOKEN_RE.test(t)) return t;
  } catch { /* fall through to the mirror */ }
  try {
    const raw = localStorage.getItem(REF_LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: unknown; exp?: unknown };
    if (typeof parsed.t === "string" && REFERRAL_TOKEN_RE.test(parsed.t) && typeof parsed.exp === "number" && parsed.exp > nowMs) {
      return parsed.t;
    }
    return null;
  } catch {
    return null;
  }
};

/** The canonical public host, independent of whichever one the LO happens to be
 *  signed in through. The app answers on the Vercel deployment URL as well as
 *  the real domain, and a PURL built from `window.location.origin` would then
 *  hand a recruit a `*.vercel.app` link — which reads as untrustworthy and puts
 *  the brand on the wrong hostname. Matches the APP_ORIGIN the send-recap
 *  function stamps into emailed links, so both channels agree. */
export const CANONICAL_ORIGIN =
  (import.meta.env?.VITE_APP_ORIGIN as string | undefined)?.replace(/\/$/, "") || "https://htlrecruit.broker";

/** The link an LO hands to a recruit. Lands on `/` — Home already forwards
 *  query params to /calculator, and the gate flow takes it from there. Pass
 *  CANONICAL_ORIGIN for anything a recruit will see; the parameter stays explicit
 *  so tests and local development can point it elsewhere. */
export const buildReferralUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/$/, "")}/?ref=${token}`;
