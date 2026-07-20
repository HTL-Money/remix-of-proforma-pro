// Pure recap-email renderer. No Deno or browser APIs — imported by the
// send-recap Edge Function (Deno) and by vitest for template tests.
// Email-client-safe: tables + inline styles only, 600px container.

export interface RecapBucketRow {
  label: string;
  files: number;
  volume: number;
  compPct: number;
  loNet: number;
}

export interface RecapPayload {
  savedName: string;
  loName: string;
  nmls: string;
  volume: number;
  files: number;
  avgLoan: number;
  currentBps: number | null;
  loSplit: number;
  holdbackPct: number;
  corrActive: boolean;
  current: { annual: number | null; monthly: number | null };
  htl: { annual: number; monthly: number };
  gain: { annual: number | null; monthly: number | null };
  buckets: RecapBucketRow[];
  totals: {
    loNetBeforeHoldback: number;
    teamHoldback: number;
    brokerPaidTotal: number;
    finalLoNetComp: number;
  };
  proformaId?: string;
}

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    isFinite(n) ? n : 0,
  );
const num = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(isFinite(n) ? n : 0));

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Brand palette
const NAVY = "#13294B";
const GREEN = "#4F8F77";
const MINT = "#6FBF9E";
// Grayscale palette for the "current platform" side
const GRAY_BG = "#f2f2f2";
const GRAY_DARK = "#4a4a4a";
const GRAY_MID = "#7a7a7a";

export const BRANDING_LINE = "Hometown Lending: Your True Value Awaits.";

// Content-ID shared by the Resend attachment and the <img src="cid:..."> in
// the HTML, so the two can never drift apart (index.ts imports it too).
export const CHART_CID = "earnings-chart";

/** Palette exported so the client-side chart renderer (src/lib/recapChart.ts)
 *  paints the exact colors this template uses. */
export const BRAND = {
  navy: NAVY,
  green: GREEN,
  mint: MINT,
  grayBg: GRAY_BG,
  grayDark: GRAY_DARK,
  grayMid: GRAY_MID,
} as const;

export interface RenderOptions {
  /** When set, the earnings comparison renders as an inline CID image instead of HTML cells. */
  chartCid?: string;
  /**
   * When set, a "Book a recruiting call" button renders above the footer,
   * linking here (Microsoft Bookings / Calendly — the page shows live
   * availability when clicked, so the email itself never goes stale).
   * Unset = section omitted entirely; no dead links in real emails.
   */
  bookingUrl?: string;
}

const detailRow = (label: string, value: string) => `
  <tr>
    <td style="padding:6px 0;color:${GRAY_MID};font-size:13px;">${label}</td>
    <td align="right" style="padding:6px 0;color:${NAVY};font-size:13px;font-weight:600;">${value}</td>
  </tr>`;

export const renderRecapHtml = (r: RecapPayload, opts: RenderOptions = {}): string => {
  const hasComparison = r.current.annual != null && r.gain.annual != null;
  const gainAnnual = r.gain.annual ?? 0;
  const gainSign = gainAnnual >= 0 ? "+" : "";

  // Alt text carries the dollar amounts so clients that block CID images
  // (plus the gain banner below) still tell the whole story.
  const chartAlt = hasComparison
    ? `Earnings comparison chart: Current platform ${usd(r.current.annual ?? 0)} per year (${usd(r.current.monthly ?? 0)} per month) vs. Hometown Lending ${usd(r.htl.annual)} per year (${usd(r.htl.monthly)} per month)`
    : `Hometown Lending projected earnings chart: ${usd(r.htl.annual)} per year (${usd(r.htl.monthly)} per month)`;

  const bucketRows = r.buckets
    .map(
      b => `
      <tr>
        <td style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${NAVY};font-size:13px;font-weight:600;">${esc(b.label)}</td>
        <td align="right" style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${GRAY_DARK};font-size:13px;">${num(b.files)}</td>
        <td align="right" style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${GRAY_DARK};font-size:13px;">${usd(b.volume)}</td>
        <td align="right" style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${GRAY_DARK};font-size:13px;">${b.compPct.toFixed(2)}%</td>
        <td align="right" style="padding:7px 8px;border-bottom:1px solid #e6e6e6;color:${GREEN};font-size:13px;font-weight:700;">${usd(b.loNet)}</td>
      </tr>`,
    )
    .join("");

  // Left column: current earnings, strictly grayscale.
  const currentCell = hasComparison
    ? `
    <td width="46%" valign="middle" style="background:${GRAY_BG};border-radius:8px;padding:20px 16px;text-align:center;">
      <div style="color:${GRAY_MID};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Current Platform</div>
      <div style="color:${GRAY_MID};font-size:12px;margin-top:4px;">${r.currentBps ?? 0} BPS</div>
      <div style="color:${GRAY_DARK};font-size:26px;font-weight:700;margin-top:10px;">${usd(r.current.annual ?? 0)}</div>
      <div style="color:${GRAY_MID};font-size:12px;margin-top:4px;">${usd(r.current.monthly ?? 0)} / month</div>
    </td>`
    : `
    <td width="46%" valign="middle" style="background:${GRAY_BG};border-radius:8px;padding:20px 16px;text-align:center;">
      <div style="color:${GRAY_MID};font-size:12px;">No current-platform comp entered</div>
    </td>`;

  // Right column: HTL amount, larger, full color.
  const htlCell = `
    <td width="50%" valign="middle" style="background:${NAVY};border-radius:8px;padding:26px 16px;text-align:center;">
      <div style="color:${MINT};font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Hometown Lending</div>
      <div style="color:#ffffff;font-size:12px;margin-top:4px;">${r.corrActive ? "Broker + Correspondent" : "Broker Only"} · ${r.loSplit}% split</div>
      <div style="color:${MINT};font-size:40px;font-weight:800;margin-top:10px;line-height:1;">${usd(r.htl.annual)}</div>
      <div style="color:#d5ece2;font-size:13px;margin-top:6px;">${usd(r.htl.monthly)} / month</div>
    </td>`;

  // The chart image spans the full 600px container (it paints its own 24px
  // margins, mirroring the row padding the HTML cells get). width="600" is
  // for Outlook desktop, which ignores CSS widths.
  const comparisonSection = opts.chartCid
    ? `
        <!-- Earnings comparison chart (inline CID image) -->
        <tr><td style="padding:24px 0 0 0;">
          <img src="cid:${esc(opts.chartCid)}" width="600" alt="${esc(chartAlt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
        </td></tr>`
    : `
        <!-- Side-by-side: grayscale current (left) vs larger color HTL (right) -->
        <tr><td style="padding:24px 24px 0 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${currentCell}
              <td width="4%">&nbsp;</td>
              ${htlCell}
            </tr>
          </table>
        </td></tr>`;

  const gainBanner = hasComparison
    ? `
    <tr><td style="padding:18px 24px 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GREEN};border-radius:8px;">
        <tr><td align="center" style="padding:18px 16px;">
          <div style="color:#eaf5f0;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Your Gain at Hometown Lending</div>
          <div style="color:#ffffff;font-size:30px;font-weight:800;margin-top:6px;">${gainSign}${usd(gainAnnual)}</div>
          <div style="color:#eaf5f0;font-size:13px;margin-top:4px;">${(r.gain.monthly ?? 0) >= 0 ? "+" : ""}${usd(r.gain.monthly ?? 0)} / month more in your pocket</div>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  // Bulletproof table-based button (no CSS-only tricks — Outlook-safe).
  const bookingCta = opts.bookingUrl
    ? `
    <tr><td style="padding:26px 24px 6px 24px;" align="center">
      <div style="color:${NAVY};font-size:16px;font-weight:700;">Like these numbers?</div>
      <div style="color:${GRAY_MID};font-size:13px;margin-top:4px;">Grab a time that works for you — the calendar always shows live availability.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px auto 0 auto;">
        <tr><td align="center" style="background:${GREEN};border-radius:8px;">
          <a href="${esc(opts.bookingUrl)}" target="_blank"
             style="display:inline-block;padding:14px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">
            Book a recruiting call
          </a>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 8px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="background:${NAVY};padding:26px 24px;text-align:center;">
          <div style="color:${MINT};font-size:26px;font-weight:800;font-family:Georgia,'Times New Roman',serif;">Hometown Lending</div>
          <div style="color:#ffffff;font-size:14px;margin-top:4px;">LO Pro Forma Recap${r.loName ? ` — ${esc(r.loName)}` : ""}${r.nmls ? ` (NMLS ${esc(r.nmls)})` : ""}</div>
        </td></tr>

        ${comparisonSection}

        ${gainBanner}

        <!-- Production summary -->
        <tr><td style="padding:22px 24px 0 24px;">
          <div style="color:${NAVY};font-size:15px;font-weight:700;border-bottom:2px solid ${GREEN};padding-bottom:6px;">Production</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            ${detailRow("Annual funded volume", usd(r.volume))}
            ${detailRow("Annual funded files", num(r.files))}
            ${detailRow("Average loan amount", usd(r.avgLoan))}
            ${detailRow("HTL LO split", `${r.loSplit}%`)}
            ${detailRow("Team-support holdback", `${r.holdbackPct}%`)}
            ${detailRow("Channel strategy", r.corrActive ? "Broker + Correspondent" : "Broker Only")}
            ${r.currentBps != null ? detailRow("Current platform comp", `${r.currentBps} BPS`) : ""}
          </table>
        </td></tr>

        <!-- Buckets -->
        ${
          r.buckets.length > 0
            ? `
        <tr><td style="padding:22px 24px 0 24px;">
          <div style="color:${NAVY};font-size:15px;font-weight:700;border-bottom:2px solid ${GREEN};padding-bottom:6px;">Production Buckets</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            <tr>
              <td style="padding:7px 8px;color:${GRAY_MID};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Bucket</td>
              <td align="right" style="padding:7px 8px;color:${GRAY_MID};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Files</td>
              <td align="right" style="padding:7px 8px;color:${GRAY_MID};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Volume</td>
              <td align="right" style="padding:7px 8px;color:${GRAY_MID};font-size:11px;text-transform:uppercase;letter-spacing:1px;">Comp</td>
              <td align="right" style="padding:7px 8px;color:${GRAY_MID};font-size:11px;text-transform:uppercase;letter-spacing:1px;">LO Net</td>
            </tr>
            ${bucketRows}
          </table>
        </td></tr>`
            : ""
        }

        <!-- Economics -->
        <tr><td style="padding:22px 24px 4px 24px;">
          <div style="color:${NAVY};font-size:15px;font-weight:700;border-bottom:2px solid ${GREEN};padding-bottom:6px;">LO Economics</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            ${detailRow("LO net before holdback", usd(r.totals.loNetBeforeHoldback))}
            ${detailRow("Team-support holdback", usd(r.totals.teamHoldback))}
            ${detailRow("Broker-paid team costs", usd(r.totals.brokerPaidTotal))}
            <tr>
              <td style="padding:10px 0 4px 0;color:${NAVY};font-size:14px;font-weight:800;">Final LO net annual comp</td>
              <td align="right" style="padding:10px 0 4px 0;color:${GREEN};font-size:18px;font-weight:800;">${usd(r.totals.finalLoNetComp)}</td>
            </tr>
          </table>
        </td></tr>

        ${bookingCta}

        <!-- Branding line -->
        <tr><td style="background:${NAVY};padding:20px 24px;text-align:center;margin-top:16px;">
          <div style="color:${MINT};font-size:16px;font-weight:700;font-family:Georgia,'Times New Roman',serif;font-style:italic;">${BRANDING_LINE}</div>
          <div style="color:#9fb1c8;font-size:11px;margin-top:8px;">Saved as “${esc(r.savedName)}” · All figures are illustrative.</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
};
