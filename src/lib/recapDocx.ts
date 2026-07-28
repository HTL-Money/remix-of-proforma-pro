// Builds the Word (.docx) recap report attached to the recap email.
//
// Deliberately basic for now — the user has deferred report design to a later
// iteration; this ships the attachment mechanism with a clean, readable
// document. Content is the RecapPayload ONLY: the same numbers the email body
// shows. Employee compensation data never enters the payload (see
// buildRecapPayload in recapEmail.ts), so it can't leak into this file either.
//
// Same failure contract as the chart and the GIF: returns null when the
// document can't be produced — the email goes out without the attachment.
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { RecapPayload } from "../../supabase/functions/send-recap/template";
import { BRANDING_LINE } from "../../supabase/functions/send-recap/template";
import { fmtUSD } from "@/lib/proforma";

const NAVY = "13294B";
const GREEN = "4F8F77";
const GRAY = "7a7a7a";

const usd = (v: number | null | undefined) => fmtUSD(v != null && isFinite(v) ? v : 0);
const num = (v: number | null | undefined) =>
  new Intl.NumberFormat("en-US").format(Math.round(v != null && isFinite(v) ? v : 0));

const label = (text: string) =>
  new Paragraph({
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text, bold: true, color: NAVY, size: 24 })],
  });

const kv = (k: string, v: string) =>
  new TableRow({
    children: [
      new TableCell({
        width: { size: 55, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: k, color: GRAY, size: 21 })] })],
      }),
      new TableCell({
        width: { size: 45, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: v, bold: true, size: 21 })] })],
      }),
    ],
  });

const plainTable = (rows: TableRow[]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "e6e6e6" },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows,
  });

/** The .docx bytes for the recap report, or null. Never throws. */
export const buildRecapDocx = async (r: RecapPayload): Promise<Uint8Array | null> => {
  try {
    const gainAnnual = r.gain?.annual ?? null;
    const doc = new Document({
      creator: "Hometown Lending Pro Forma",
      title: `Pro Forma Recap — ${r.savedName}`,
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.TITLE,
              children: [new TextRun({ text: "Pro Forma Recap", color: NAVY })],
            }),
            new Paragraph({
              spacing: { after: 60 },
              children: [
                new TextRun({ text: r.savedName, bold: true, size: 26 }),
                ...(r.loName ? [new TextRun({ text: `  ·  ${r.loName}`, size: 26 })] : []),
                ...(r.nmls ? [new TextRun({ text: `  ·  NMLS #${r.nmls}`, color: GRAY, size: 22 })] : []),
              ],
            }),

            label("Production"),
            plainTable([
              kv("Annual volume", usd(r.volume)),
              kv("Annual files", num(r.files)),
              kv("Average loan amount", usd(r.avgLoan)),
            ]),

            label("Earnings Comparison"),
            plainTable([
              kv(
                r.currentBps != null ? `Current platform (${r.currentBps} bps)` : "Current platform",
                `${usd(r.current.annual)} / yr   ·   ${usd(r.current.monthly)} / mo`,
              ),
              kv(
                `Hometown Lending (${r.loSplit}% split${r.corrActive ? ", Broker + Correspondent" : ""})`,
                `${usd(r.htl.annual)} / yr   ·   ${usd(r.htl.monthly)} / mo`,
              ),
            ]),
            ...(gainAnnual != null && isFinite(gainAnnual) && gainAnnual > 0
              ? [
                  new Paragraph({
                    spacing: { before: 160 },
                    children: [
                      new TextRun({ text: "Your gain at Hometown: ", bold: true, size: 24 }),
                      new TextRun({
                        text: `+${usd(gainAnnual)} / yr  (+${usd(r.gain?.monthly)} / mo)`,
                        bold: true,
                        color: GREEN,
                        size: 24,
                      }),
                    ],
                  }),
                ]
              : []),

            label("Channel Breakdown"),
            plainTable([
              new TableRow({
                children: ["Channel", "Files", "Volume", "Comp %", "LO Net"].map(
                  h =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: GRAY, size: 20 })] })],
                    }),
                ),
              }),
              ...r.buckets.map(
                b =>
                  new TableRow({
                    children: [
                      b.label,
                      num(b.files),
                      usd(b.volume),
                      `${b.compPct}%`,
                      usd(b.loNet),
                    ].map(
                      v =>
                        new TableCell({
                          children: [new Paragraph({ children: [new TextRun({ text: v, size: 20 })] })],
                        }),
                    ),
                  }),
              ),
            ]),

            label("Totals"),
            plainTable([
              kv("LO net before payroll", usd(r.totals.loNetBeforeHoldback)),
              kv("Your team payroll cost", usd(r.totals.brokerPaidTotal)),
              kv("Final LO net comp", usd(r.totals.finalLoNetComp)),
            ]),

            // The report gets forwarded and detached from the email, so it
            // carries its own assumptions + disclaimer instead of relying on
            // the email footer. Specific assumptions build trust; a bare
            // "illustrative" reads as a fig leaf (persona-panel finding).
            new Paragraph({
              spacing: { before: 300 },
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: `Projection based on ${usd(r.volume)} annual volume, ${num(r.files)} files at a ${r.loSplit}/${100 - Number(r.loSplit)} split — the loan officer keeps ${r.loSplit}% of gross commission and Hometown Lending keeps ${100 - Number(r.loSplit)}%. Split bands are set by monthly funded volume: up to $2M/month is 80/20, $2M–$4M is 85/15, and above $4M is 90/10.${r.selfReported ? " Production figures were self-reported and have not been verified against RETR records." : ""} All figures are illustrative — not an offer of employment or compensation.`,
                  italics: true,
                  color: GRAY,
                  size: 18,
                }),
              ],
            }),
            new Paragraph({
              spacing: { before: 120 },
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: `Prepared${r.nmls ? ` from NMLS #${r.nmls} production data` : ""} by Hometown Lending.`,
                  italics: true,
                  color: GRAY,
                  size: 18,
                }),
              ],
            }),
          ],
        },
      ],
    });

    // toArrayBuffer works in browsers AND canvas-less test DOMs (jsdom's Blob
    // lacks .arrayBuffer(), so Packer.toBlob would fail there).
    return new Uint8Array(await Packer.toArrayBuffer(doc));
  } catch {
    return null;
  }
};

/** Base64 (no data: prefix) for the Edge Function payload, or null. */
export const buildRecapDocxBase64 = async (r: RecapPayload): Promise<string | null> => {
  const bytes = await buildRecapDocx(r);
  if (!bytes) return null;
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};
