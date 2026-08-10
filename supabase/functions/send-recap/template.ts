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
  corrActive: boolean;
  current: { annual: number | null; monthly: number | null };
  htl: { annual: number; monthly: number };
  gain: { annual: number | null; monthly: number | null };
  buckets: RecapBucketRow[];
  totals: {
    loNetBeforeHoldback: number;
    brokerPaidTotal: number;
    finalLoNetComp: number;
  };
  proformaId?: string;
  /** One personalized opening paragraph, written per recruit. Carries NO
   *  figures by construction — every number in this email is rendered from the
   *  fields above, so the comp claims stay deterministic and reviewable.
   *  Generated best-effort (see narrativePrompt.ts + index.ts); absent whenever
   *  generation failed, timed out, or produced text that broke the rules. */
  narrative?: string;
  /** Months the production figures cover (the RETR pull window). 12 = a true
   *  year. Optional for backward-compat with older payloads → defaults to 12. */
  periodMonths?: number;
  /** True when the production figures were typed in by the recipient instead
   *  of pulled from RETR (the manual-entry fallback). Renders an honest
   *  "self-reported" note so a hand-entered pro forma is never mistaken for
   *  verified data. Optional for backward-compat → old payloads are RETR-era. */
  selfReported?: boolean;
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

// Public business identity — printed in the signature + CAN-SPAM footer, so
// these are shown to recipients and are NOT secrets: baked in, not env vars.
export const COMPANY = {
  name: "HomeTown Lending",
  nmls: "2712965",
  address: "5050 Quorum Drive, Ste. 600, Dallas, TX 75254",
} as const;
export const RECRUITER = {
  name: "Aryan Jafarzadeh",
  title: "Founder / CEO",
  nmls: "1989264",
  phone: "(972) 322-4472",
  email: "aryanj@hometownlend.com",
} as const;
// CAN-SPAM unsubscribe target (a monitored inbox).
export const UNSUBSCRIBE_EMAIL = "marketing@hometownlend.com";

// Period labels, inlined so this module keeps zero app imports (it runs under
// both Deno and vitest). Mirrors src/lib/retrApi.ts periodLabel/periodLabelTitle.
const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
  7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
};
const periodLabel = (months: number): string => {
  if (months === 12) return "annual";
  if (months < 12) {
    const w = NUMBER_WORDS[months] ?? String(months);
    return `previous ${w} month${months === 1 ? "" : "s"}`;
  }
  if (months % 12 === 0) {
    const y = months / 12;
    const w = NUMBER_WORDS[y] ?? String(y);
    return `${w} year${y === 1 ? "" : "s"}`;
  }
  return `${months} months`;
};
const periodTitle = (months: number): string =>
  periodLabel(months).replace(/\b\w/g, c => c.toUpperCase());
const tel = (phone: string) => phone.replace(/[^\d+]/g, "");

// Duplicated (intentionally) from src/lib/recapLink.ts's encodeRecap — this
// file has zero app imports by design (portable across Deno and vitest), so
// the encoder is small enough to keep here rather than reach across runtimes.
// Must stay byte-for-byte identical to recapLink.ts's algorithm so a link
// built here decodes correctly on the client (see recap.test.ts's
// cross-implementation round-trip test).
const toB64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const encodeRecapToken = (r: RecapPayload): string => toB64Url(JSON.stringify(r));

// Content-ID shared by the Resend attachment and the <img src="cid:..."> in
// the HTML, so the two can never drift apart (index.ts imports it too).
export const CHART_CID = "earnings-chart";
// Same contract for the animated vault-hero GIF at the top of the email.
export const GIF_CID = "vault-hero";

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
  /**
   * The app's public origin (e.g. https://app.hometownlend.com). Retained for
   * absolute URLs elsewhere in the email; it no longer renders a presentation
   * link — the deck ships as an attachment instead.
   */
  appOrigin?: string;
  /**
   * Filename of the attached Gamma PDF (e.g. "Documented-Pro-Forma.pdf"). When
   * set, the closing "Documented Pro Forma" block renders and names this file.
   * Unset = block omitted, so the email never claims an attachment it lacks.
   */
  documentedProformaName?: string;
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
  const months = r.periodMonths ?? 12;
  // For 12mo this is literally "per year" — byte-identical to the old copy.
  const periodPhrase = months === 12 ? "per year" : `over the ${periodLabel(months)}`;

  // Alt text carries the dollar amounts INCLUDING the gain so clients that
  // block CID images still tell the whole story — the gain banner is
  // suppressed whenever the image rides along, so the alt is the only other
  // carrier of that number above the detail rows.
  const chartAlt = hasComparison
    ? `Earnings comparison: Current platform ${usd(r.current.annual ?? 0)} ${periodPhrase} (${usd(r.current.monthly ?? 0)} per month) vs. Hometown Lending ${usd(r.htl.annual)} ${periodPhrase} (${usd(r.htl.monthly)} per month) — a modeled gain of ${usd(r.gain.annual ?? 0)} ${periodPhrase}`
    : `Hometown Lending projected earnings chart: ${usd(r.htl.annual)} ${periodPhrase} (${usd(r.htl.monthly)} per month)`;

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
      <div style="color:${GRAY_MID};font-size:12px;margin-top:4px;">${Number(r.currentBps ?? 0)} BPS</div>
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
      <div style="color:#ffffff;font-size:12px;margin-top:4px;">${r.corrActive ? "Broker + Correspondent" : "Broker Only"} · ${Number(r.loSplit)}% split</div>
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

  // Presentation intro. The deck is DELIVERED AS AN ATTACHMENT, never as a
  // link — a recruit should not have to click through to a hosted page to see
  // it. So this is a plain framing headline with no button; the file itself is
  // announced by documentedProforma at the end of the body.
  const presentationHero = `
    <tr><td style="background:${NAVY};padding:32px 24px;text-align:center;">
      <div style="color:${MINT};font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Your Personalized Pro Forma</div>
      <div style="color:#ffffff;font-size:17px;font-weight:700;margin-top:10px;line-height:1.4;">
        You already know you're leaving money on the table.<br />Here's exactly how much.
      </div>
    </td></tr>`;

  // The personalized opening. Escaped like any other untrusted string — it is
  // model output, so it is treated as data, never as markup. Rendered above
  // every figure so it reads as the framing, not as a caption on the math.
  const narrativeBlock = r.narrative
    ? `
    <tr><td style="padding:22px 24px 0 24px;">
      <div style="color:${GRAY_DARK};font-size:15px;line-height:1.65;">${esc(r.narrative)}</div>
    </td></tr>`
    : "";

  // Closing block: names the attached PDF so the recruit knows the file in
  // their client IS the deliverable. Rendered only when a PDF actually rode
  // along, so the email can never promise an attachment that isn't there.
  const documentedProforma = opts.documentedProformaName
    ? `
    <tr><td style="padding:24px 24px 4px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${GREEN};border-radius:8px;">
        <tr><td style="padding:18px 20px;">
          <div style="color:${NAVY};font-size:15px;font-weight:800;">Documented Pro Forma</div>
          <div style="color:${GRAY_MID};font-size:13px;margin-top:6px;line-height:1.6;">
            It's attached as <strong style="color:${NAVY};">${esc(opts.documentedProformaName)}</strong> — the same
            numbers as above, in full, yours to keep.
          </div>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  // Suppressed when the comparison visual rides along: the image carries its
  // own gold gain bubble, and repeating the number in a second banner directly
  // beneath it reads as shouting. The figures still appear as real HTML text
  // in the detail rows below — that's the image-blocked/text fallback.
  const gainBanner = hasComparison && !opts.chartCid
    ? `
    <tr><td style="padding:18px 24px 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GREEN};border-radius:8px;">
        <tr><td align="center" style="padding:18px 16px;">
          <div style="color:#eaf5f0;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Your Gain at Hometown Lending</div>
          <div style="color:#ffffff;font-size:30px;font-weight:800;margin-top:6px;">${gainSign}${usd(gainAnnual)}</div>
          <div style="color:#eaf5f0;font-size:13px;margin-top:4px;">${(r.gain.monthly ?? 0) >= 0 ? "+" : ""}${usd(r.gain.monthly ?? 0)} / month in modeled net comp</div>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  // Bulletproof table-based button (no CSS-only tricks — Outlook-safe).
  const bookingCta = opts.bookingUrl
    ? `
    <tr><td style="padding:26px 24px 6px 24px;" align="center">
      <div style="color:${NAVY};font-size:16px;font-weight:700;">Want to pressure-test these assumptions?</div>
      <div style="color:${GRAY_MID};font-size:13px;margin-top:4px;">No pitch, no commitment — and nothing shared with anyone. Bring your numbers and poke holes in our math.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px auto 0 auto;">
        <tr><td align="center" style="background:${GREEN};border-radius:8px;">
          <a href="${esc(opts.bookingUrl)}" target="_blank"
             style="display:inline-block;padding:14px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">
            Book a confidential 15-min walkthrough
          </a>
        </td></tr>
      </table>
    </td></tr>`
    : "";

  // Recruiter signature — a real person to reply to. Reply-To is also set to
  // this address server-side, so a plain reply reaches Aryan directly.
  const signature = `
    <tr><td style="padding:22px 24px 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="border-top:1px solid #e6e6e6;padding-top:16px;">
          <div style="color:${NAVY};font-size:14px;font-weight:700;">${RECRUITER.name}</div>
          <div style="color:${GRAY_MID};font-size:12px;margin-top:2px;">${RECRUITER.title}, ${COMPANY.name} · NMLS #${RECRUITER.nmls}</div>
          <div style="color:${GRAY_MID};font-size:12px;margin-top:4px;">
            <a href="tel:${tel(RECRUITER.phone)}" style="color:${GREEN};text-decoration:none;">${RECRUITER.phone}</a>
            &nbsp;·&nbsp;
            <a href="mailto:${RECRUITER.email}" style="color:${GREEN};text-decoration:none;">${RECRUITER.email}</a>
          </div>
        </td></tr>
      </table>
    </td></tr>`;

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

        ${presentationHero}
        ${narrativeBlock}

        ${comparisonSection}

        ${gainBanner}

        <!-- Production summary -->
        <tr><td style="padding:22px 24px 0 24px;">
          <div style="color:${NAVY};font-size:15px;font-weight:700;border-bottom:2px solid ${GREEN};padding-bottom:6px;">Production</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            ${detailRow(`${periodTitle(months)} funded volume`, usd(r.volume))}
            ${detailRow(`${periodTitle(months)} funded files`, num(r.files))}
            ${detailRow("Average loan amount", usd(r.avgLoan))}
            ${detailRow("HTL LO split", `${Number(r.loSplit)}/${100 - Number(r.loSplit)} — you keep ${Number(r.loSplit)}%`)}
            ${detailRow("Channel strategy", r.corrActive ? "Broker + Correspondent" : "Broker Only")}
            ${r.currentBps != null ? detailRow("Current platform comp", `${Number(r.currentBps)} BPS`) : ""}
          </table>
          ${
            r.selfReported
              ? `<div style="color:${GRAY_MID};font-size:11px;margin-top:8px;">These production figures were entered by hand, not pulled from RETR records.</div>`
              : ""
          }
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
            ${detailRow("LO net before payroll", usd(r.totals.loNetBeforeHoldback))}
            ${detailRow("Your team payroll cost", usd(r.totals.brokerPaidTotal))}
            <tr>
              <td style="padding:10px 0 4px 0;color:${NAVY};font-size:14px;font-weight:800;">${months === 12 ? "Final LO net annual comp" : `Final LO net comp — ${periodTitle(months)}`}</td>
              <td align="right" style="padding:10px 0 4px 0;color:${GREEN};font-size:18px;font-weight:800;">${usd(r.totals.finalLoNetComp)}</td>
            </tr>
          </table>
        </td></tr>

        ${documentedProforma}

        ${bookingCta}

        ${signature}

        <!-- Branding line + CAN-SPAM footer -->
        <tr><td style="background:${NAVY};padding:20px 24px;text-align:center;margin-top:16px;">
          <div style="color:${MINT};font-size:16px;font-weight:700;font-family:Georgia,'Times New Roman',serif;font-style:italic;">${BRANDING_LINE}</div>
          <div style="color:#9fb1c8;font-size:11px;margin-top:12px;line-height:1.6;">
            ${COMPANY.name} · NMLS #${COMPANY.nmls}<br />
            ${COMPANY.address}<br />
            Saved as “${esc(r.savedName)}” · All figures are illustrative and not a guarantee of income.<br />
            You’re receiving this because a Pro Forma recap was requested for you.
            <a href="mailto:${UNSUBSCRIBE_EMAIL}?subject=Unsubscribe" style="color:#9fb1c8;text-decoration:underline;">Unsubscribe</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
};
