import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const fmtUSD = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n ?? 0);

const fmtPct = (n: number, d = 2) => `${(n ?? 0).toFixed(d)}%`;

function buildEmailHtml(loName: string, state: Record<string, unknown>, results: Record<string, unknown>, hasChart: boolean): string {
  const name = loName || "Loan Officer";
  const currentAnnual = results.currentPlatformAnnual as number | null;
  const currentMonthly = results.currentPlatformMonthly as number | null;
  const htlAnnual = results.htlAnnual as number;
  const htlMonthly = results.htlMonthly as number;
  const diffAnnual = results.diffAnnual as number | null;
  const diffMonthly = results.diffMonthly as number | null;
  const currentSplit = state.currentSplit as number | null;
  const loSplit = state.loSplit as number;
  const annualVolume = state.annualVolume as number;
  const annualFiles = state.annualFiles as number;
  const grossSplit = results.totals as Record<string, number>;
  const gainColor = (diffAnnual ?? 0) >= 0 ? "#4F8F77" : "#dc2626";
  const gainSign = (diffAnnual ?? 0) >= 0 ? "+" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HTL LO Pro Forma — ${name}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Inter,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(19,41,75,0.13);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#13294B 0%,#1a3660 60%,#2d6b54 100%);padding:32px 36px;">
            <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#4F8F77;">Hometown Lending</p>
            <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;line-height:1.15;">LO Pro Forma</h1>
            <p style="margin:6px 0 0 0;font-size:14px;color:rgba(255,255,255,0.75);">Compensation comparison for <strong style="color:#ffffff;">${name}</strong></p>
          </td>
        </tr>

        ${hasChart ? `
        <!-- 3D comparison scene — inline PNG snapshot of exactly what the LO saw in the app -->
        <tr>
          <td style="background:#ffffff;padding:24px 36px 0;">
            <img src="cid:htl-comparison" alt="Annual net compensation: Current Platform vs Hometown Lending" width="528" style="display:block;width:100%;max-width:528px;border-radius:10px;" />
          </td>
        </tr>
        ` : ""}

        <!-- Production snapshot -->
        <tr>
          <td style="background:#ffffff;padding:24px 36px 8px;">
            <p style="margin:0 0 12px 0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b7a99;">Production Snapshot</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:33%;padding-right:8px;">
                  <div style="background:#f4f6f9;border-radius:8px;padding:12px 14px;">
                    <p style="margin:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7a99;">Annual Volume</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#13294B;">${fmtUSD(annualVolume)}</p>
                  </div>
                </td>
                <td style="width:33%;padding-right:8px;">
                  <div style="background:#f4f6f9;border-radius:8px;padding:12px 14px;">
                    <p style="margin:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7a99;">Annual Files</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#13294B;">${annualFiles}</p>
                  </div>
                </td>
                <td style="width:33%;">
                  <div style="background:#f4f6f9;border-radius:8px;padding:12px 14px;">
                    <p style="margin:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7a99;">HTL LO Split</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#13294B;">${loSplit}%</p>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Comparison table -->
        <tr>
          <td style="background:#ffffff;padding:24px 36px;">
            <p style="margin:0 0 14px 0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#6b7a99;">Compensation Comparison</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;border-collapse:separate;">
              <!-- Head row -->
              <tr>
                <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;color:#6b7a99;background:#f8fafc;border-bottom:1px solid #e2e8f0;width:38%;">Metric</th>
                <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:600;color:#6b7a99;background:#f8fafc;border-bottom:1px solid #e2e8f0;width:31%;">Current Platform${currentSplit != null ? `<br/><span style="font-weight:400;">${Math.round((currentSplit as number) * 100)} BPS</span>` : ""}</th>
                <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:700;color:#4F8F77;background:#f0faf6;border-bottom:1px solid #e2e8f0;width:31%;">Hometown Lending<br/><span style="font-weight:400;">${loSplit}% split</span></th>
              </tr>
              ${currentSplit != null ? `
              <tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:10px 14px;font-size:13px;color:#374151;">Annual Net Comp</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;font-weight:600;color:#374151;">${fmtUSD(currentAnnual ?? 0)}</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;font-weight:700;color:#4F8F77;background:#f8fffe;">${fmtUSD(htlAnnual)}</td>
              </tr>
              <tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:10px 14px;font-size:13px;color:#374151;">Monthly Net Comp</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;color:#374151;">${fmtUSD(currentMonthly ?? 0)}</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;font-weight:600;color:#4F8F77;background:#f8fffe;">${fmtUSD(htlMonthly)}</td>
              </tr>
              ` : `
              <tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:10px 14px;font-size:13px;color:#374151;">Annual Net Comp</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;color:#94a3b8;">—</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;font-weight:700;color:#4F8F77;background:#f8fffe;">${fmtUSD(htlAnnual)}</td>
              </tr>
              <tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:10px 14px;font-size:13px;color:#374151;">Monthly Net Comp</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;color:#94a3b8;">—</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;font-weight:600;color:#4F8F77;background:#f8fffe;">${fmtUSD(htlMonthly)}</td>
              </tr>
              `}
              <tr style="border-bottom:1px solid #e2e8f0;">
                <td style="padding:10px 14px;font-size:13px;color:#374151;">Gross LO Split</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;color:#374151;">${currentSplit != null ? fmtPct(currentSplit as number, 2) : "—"}</td>
                <td style="padding:10px 14px;text-align:right;font-size:13px;color:#4F8F77;background:#f8fffe;">${fmtUSD(grossSplit?.loGrossSplit ?? 0)}</td>
              </tr>
            </table>
          </td>
        </tr>

        ${diffAnnual != null ? `
        <!-- Your Gain -->
        <tr>
          <td style="background:#ffffff;padding:0 36px 28px;">
            <div style="background:linear-gradient(135deg,#4F8F77 0%,#3a7a64 100%);border-radius:12px;padding:24px 28px;text-align:center;">
              <p style="margin:0 0 4px 0;font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.8);">Your Gain at Hometown Lending</p>
              <p style="margin:8px 0 4px 0;font-size:40px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;">${gainSign}${fmtUSD(diffAnnual)}</p>
              <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85);">${gainSign}${fmtUSD(diffMonthly ?? 0)} per month more in your pocket</p>
            </div>
          </td>
        </tr>
        ` : ""}

        <!-- Footer -->
        <tr>
          <td style="background:#13294B;padding:20px 36px;text-align:center;">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.5);">Hometown Lending · LO Recruiting Pro Forma · All figures are illustrative estimates.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { state, results, loEmail, chartPng } = await req.json();

    if (!state || !results) {
      return new Response(JSON.stringify({ error: "Missing state or results in request body." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const recruiterEmail = Deno.env.get("RECRUITER_EMAIL");
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase credentials are not configured on the function.");
    if (!resendKey || !recruiterEmail) throw new Error("RESEND_API_KEY / RECRUITER_EMAIL secrets are not set.");

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from("proforma_submissions")
      .insert({
        lo_name: state?.recruitName ?? null,
        lo_email: loEmail ?? null,
        state_json: state,
        results_json: results,
      })
      .select("id")
      .single();

    if (error) throw error;

    // Chart snapshot arrives as a data URL; Resend wants raw base64 for attachments.
    const chartBase64 = typeof chartPng === "string" && chartPng.startsWith("data:image/png;base64,")
      ? chartPng.slice("data:image/png;base64,".length)
      : null;

    const loName = state?.recruitName || "Loan Officer";
    const html = buildEmailHtml(loName, state, results, chartBase64 != null);

    const to: string[] = [recruiterEmail];
    if (loEmail) to.push(loEmail);

    let emailed = false;
    let emailError: string | undefined;
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Hometown Lending Pro Forma <noreply@htlmoney.com>",
          to,
          subject: `HTL Pro Forma — ${loName}`,
          html,
          ...(chartBase64
            ? {
                attachments: [{
                  filename: "htl-comparison.png",
                  content: chartBase64,
                  content_type: "image/png",
                  content_id: "htl-comparison",
                }],
              }
            : {}),
        }),
      });
      if (emailRes.ok) {
        emailed = true;
      } else {
        emailError = `Resend ${emailRes.status}: ${(await emailRes.text()).slice(0, 300)}`;
      }
    } catch (e) {
      emailError = (e as Error).message;
    }

    return new Response(JSON.stringify({ id: data.id, emailed, ...(emailError ? { emailError } : {}) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
