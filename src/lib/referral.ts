// Recruit-PURL plumbing shared by the visitor flow (capture ?ref=, remember
// it for the session, attach it to the send) and the team's /links page
// (build the URL to hand out). The token itself is minted by the DB
// (referral_links, encode(gen_random_bytes(8),'hex')) and resolved to its
// creating LO server-side in send-recap — the client only ever carries it.

/** Mirror of the server's REFERRAL_TOKEN_RE (sourcing.ts): 16 lowercase hex. */
export const REFERRAL_TOKEN_RE = /^[0-9a-f]{16}$/;

const REF_KEY = "htl_ref_token_v1";

/** Validates and stashes a ?ref= value for the session. Bad shapes are
 *  dropped silently — a mangled link still gets a working calculator. */
export const storeReferralToken = (raw: string | null): void => {
  if (raw && REFERRAL_TOKEN_RE.test(raw)) {
    try { sessionStorage.setItem(REF_KEY, raw); } catch { /* storage disabled — un-referred visit */ }
  }
};

export const getReferralToken = (): string | null => {
  try {
    const t = sessionStorage.getItem(REF_KEY);
    return t && REFERRAL_TOKEN_RE.test(t) ? t : null;
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
