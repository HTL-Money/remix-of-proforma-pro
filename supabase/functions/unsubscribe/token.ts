// Signed unsubscribe tokens.
//
// The one-click endpoint has to be callable with no authentication at all —
// mailbox providers POST to it on the recipient's behalf, carrying no session.
// So the URL itself must be the authorisation, or anyone could suppress any
// address they liked (trivially: unsubscribe a competitor's whole book, or a
// recruiter's own inbox, and silence outreach without anyone noticing).
//
// Each URL therefore carries the address plus an HMAC-SHA256 of it, keyed on a
// server-only secret. Tokens do NOT expire: CAN-SPAM requires an opt-out
// mechanism to keep working for at least 30 days after a send, and there is no
// upside to it ever ceasing to work — an old email is exactly when someone
// reaches for unsubscribe.
//
// Pure and Deno-free apart from Web Crypto (available in both Deno and Node 18+),
// so vitest covers it directly.

const enc = new TextEncoder();

/** URL-safe base64 without padding — survives being a query parameter. */
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

const hmac = async (secret: string, message: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
};

/** Addresses are compared and stored lowercased — email_suppressions is keyed
 *  that way, and a token minted for Foo@x.com must match a click on foo@x.com. */
export const canonical = (email: string): string => email.trim().toLowerCase();

/** `<b64url(email)>.<b64url(hmac)>` — opaque enough not to invite tampering,
 *  and self-contained so the endpoint needs no lookup table. */
export const mintUnsubscribeToken = async (email: string, secret: string): Promise<string> => {
  const e = canonical(email);
  return `${b64url(enc.encode(e))}.${b64url(await hmac(secret, e))}`;
};

/** Returns the address the token authorises, or null if it doesn't verify.
 *  Never throws — malformed input is just an invalid token. */
export const verifyUnsubscribeToken = async (token: string, secret: string): Promise<string | null> => {
  try {
    const [ePart, sigPart] = token.split(".");
    if (!ePart || !sigPart) return null;
    const email = new TextDecoder().decode(fromB64url(ePart));
    if (!email || !email.includes("@")) return null;
    const expected = await hmac(secret, canonical(email));
    const got = fromB64url(sigPart);
    // Constant-time compare: length first, then every byte regardless of an
    // early mismatch, so timing can't be used to forge a signature byte by byte.
    if (got.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0 ? canonical(email) : null;
  } catch {
    return null;
  }
};
