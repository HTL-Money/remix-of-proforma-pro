// Clears app_metadata.must_set_password for the CALLER, once they have replaced
// the temporary password they were issued.
//
// Why a function at all: the flag has to live in app_metadata rather than
// user_metadata, because updateUser lets a user write their own user_metadata —
// a flag there would be self-clearable by the very person it constrains, which
// makes it decorative. app_metadata is service-role-only, and the service role
// must never reach the browser, so clearing it goes through here.
//
// The caller is resolved from their own access token, never from the body. There
// is deliberately no "which user" parameter: with one, any signed-in LO could
// clear the flag on somebody else's account.

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey || !anonKey) return json(500, { error: "Server not configured." });

  // verify_jwt only proves the token parses. Ask Auth who it actually belongs
  // to, so the identity comes from Supabase rather than from a decoded claim we
  // trusted ourselves.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "Not signed in." });

  let userId: string;
  try {
    const who = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authHeader },
      signal: AbortSignal.timeout(15_000),
    });
    if (!who.ok) return json(401, { error: "Not signed in." });
    const u = await who.json() as { id?: string };
    if (!u.id) return json(401, { error: "Not signed in." });
    userId = u.id;
  } catch (e) {
    console.error("caller lookup failed", e);
    return json(502, { error: "Could not verify your session." });
  }

  // Idempotent: clearing an already-clear flag is a no-op success, so the client
  // can safely retry after a partial failure.
  try {
    const r = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ app_metadata: { must_set_password: false } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      console.error("flag clear failed", r.status, await r.text().catch(() => ""));
      return json(502, { error: "Could not clear the flag." });
    }
  } catch (e) {
    console.error("flag clear threw", e);
    return json(502, { error: "Could not clear the flag." });
  }

  return json(200, { ok: true });
});
