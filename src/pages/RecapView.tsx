import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarCheck, FileText } from "lucide-react";
import { decodeRecap, hashRecap } from "@/lib/recapLink";
import { periodLabelTitle } from "@/lib/retrApi";
import { renderVaultGifBase64, vaultParamsFromRecap } from "@/lib/vaultGif";
import { pollRecapPresentationStatus } from "@/lib/gammaPresentation";

const POLL_INTERVAL_MS = 4000;
const MAX_POLL_ATTEMPTS = 45; // ~3 minutes, matching the "send now, page auto-fills" design

// Aryan's live Microsoft Bookings page (same link used in the email + CTA).
const BOOKING_URL =
  "https://outlook.office.com/bookwithme/user/6ae2ff896ce64b4085b2e829a6228568@hometownlend.com?anonymous&ismsaljsauthenabled&ep=pcard";

const usd = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    typeof n === "number" && isFinite(n) ? n : 0,
  );
const num = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US").format(Math.round(typeof n === "number" && isFinite(n) ? n : 0));

const NAVY = "#13294B";
const GREEN = "#4F8F77";
const MINT = "#6FBF9E";

/**
 * Public, standalone hosted recap page (route: /r). Rendered OUTSIDE the team
 * AppShell — an external recruit opens it from their email. Reads the recap
 * from the `?d=` link param (see src/lib/recapLink.ts); no auth, no DB read.
 * The per-recruit cinematic video (Part K) will slot in above the numbers.
 */
const RecapView = () => {
  const [params] = useSearchParams();
  const recap = useMemo(() => decodeRecap(params.get("d")), [params]);
  const [gifDataUrl, setGifDataUrl] = useState<string | null>(null);
  const [presentationState, setPresentationState] = useState<"idle" | "processing" | "completed" | "failed">("idle");
  const [presentationUrl, setPresentationUrl] = useState<string | null>(null);

  // Render the vault GIF client-side, immediately — the exact same renderer
  // the email used to use as its hero. It's no longer the email's hero (the
  // Gamma presentation is, per the single-deliverable decision), but it's
  // still a nice supporting visual on this page. (Hooks run unconditionally;
  // each guards internally on `recap` being present, so the invalid-link
  // early return below doesn't violate the rules of hooks.)
  useEffect(() => {
    if (!recap) return;
    const p = vaultParamsFromRecap(recap);
    if (!p) return;
    const gif = renderVaultGifBase64(p);
    if (gif) setGifDataUrl(`data:image/gif;base64,${gif}`);
  }, [recap]);

  // Poll for the Gamma presentation. Generation was kicked off at send time
  // (PublicRecapCta/CloudSave), so by the time a recruit opens this link it
  // may already be done — otherwise this polls until it is, or gives up
  // quietly after ~3 minutes and just leaves the numbers below showing.
  useEffect(() => {
    if (!recap) return;
    const hash = hashRecap(recap);
    let cancelled = false;
    let attempts = 0;
    setPresentationState("processing");
    const tick = async () => {
      if (cancelled) return;
      const result = await pollRecapPresentationStatus(hash);
      if (cancelled) return;
      if (result.status === "completed" && result.url) {
        setPresentationUrl(result.url);
        setPresentationState("completed");
        return;
      }
      if (result.status === "failed") {
        setPresentationState("failed");
        return;
      }
      attempts += 1;
      if (attempts >= MAX_POLL_ATTEMPTS) {
        setPresentationState("failed"); // give up quietly
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [recap]);

  if (!recap) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: NAVY }}>
        <div className="max-w-md text-center rounded-2xl bg-white/95 p-8 shadow-xl">
          <h1 className="text-xl font-bold" style={{ color: NAVY }}>
            This recap link isn’t valid
          </h1>
          <p className="mt-3 text-sm text-gray-600">
            The link may be incomplete or was copied incorrectly. Ask for a fresh recap, or book a call and we’ll walk
            through your numbers together.
          </p>
          <a
            href={BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold text-white"
            style={{ background: GREEN }}
          >
            <CalendarCheck className="h-4 w-4" /> Book a call with Aryan
          </a>
        </div>
      </div>
    );
  }

  const months = recap.periodMonths ?? 12;
  const periodTitle = periodLabelTitle(months);
  const hasComparison = recap.current.annual != null && recap.gain.annual != null;
  const gainAnnual = recap.gain.annual ?? 0;
  const gainSign = gainAnnual >= 0 ? "+" : "";

  return (
    <div className="min-h-screen pb-16" style={{ background: "#eef1f5" }}>
      {/* Header */}
      <header className="px-6 py-8 text-center" style={{ background: NAVY }}>
        <div className="text-2xl font-extrabold" style={{ color: MINT, fontFamily: "Georgia, serif" }}>
          Hometown Lending
        </div>
        <div className="mt-1 text-sm text-white/90">
          LO Pro Forma Recap{recap.loName ? ` — ${recap.loName}` : ""}
          {recap.nmls ? ` (NMLS ${recap.nmls})` : ""}
        </div>
      </header>

      <main className="mx-auto mt-6 w-full max-w-2xl px-4 space-y-5">
        {/* Presentation — the single deliverable. Always shown once a Gamma
            generation was kicked off at send time; this page just reflects
            whatever state it's actually in, no reload needed once ready. */}
        <section className="rounded-xl p-6 text-center shadow-sm" style={{ background: NAVY }}>
          <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: MINT }}>
            Your Personalized Presentation
          </div>
          {presentationState === "completed" && presentationUrl ? (
            <a
              href={presentationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-lg px-8 py-3.5 text-[15px] font-bold text-white"
              style={{ background: GREEN }}
            >
              <FileText className="h-4 w-4" /> View Your Presentation →
            </a>
          ) : presentationState === "failed" ? (
            <p className="mt-3 text-sm text-white/70">
              We couldn't generate your presentation this time — the numbers below are still exact.
            </p>
          ) : (
            <p className="mt-3 text-sm text-white/70">Preparing your presentation — this page will update automatically.</p>
          )}
        </section>

        {/* Supporting visual — the same vault animation the email used to
            lead with; not the star anymore, but still a nice touch here. */}
        {gifDataUrl && (
          <section className="overflow-hidden rounded-xl shadow-sm" style={{ background: "#101318" }}>
            <img src={gifDataUrl} alt="Your earnings animation" className="block w-full" />
          </section>
        )}

        {/* Comparison */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-[#f2f2f2] p-6 text-center">
            <div className="text-[11px] font-bold uppercase tracking-widest text-gray-500">Current Platform</div>
            {hasComparison ? (
              <>
                <div className="mt-1 text-xs text-gray-500">{num(recap.currentBps)} BPS</div>
                <div className="mt-2 text-3xl font-bold text-gray-700">{usd(recap.current.annual)}</div>
                <div className="mt-1 text-xs text-gray-500">{usd(recap.current.monthly)} / month</div>
              </>
            ) : (
              <div className="mt-3 text-sm text-gray-500">No current-platform comp entered</div>
            )}
          </div>
          <div className="rounded-xl p-6 text-center" style={{ background: NAVY }}>
            <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: MINT }}>
              Hometown Lending
            </div>
            <div className="mt-1 text-xs text-white/85">
              {recap.corrActive ? "Broker + Correspondent" : "Broker Only"} · {num(recap.loSplit)}% split
            </div>
            <div className="mt-2 text-4xl font-extrabold leading-none" style={{ color: MINT }}>
              {usd(recap.htl.annual)}
            </div>
            <div className="mt-1.5 text-[13px]" style={{ color: "#d5ece2" }}>
              {usd(recap.htl.monthly)} / month
            </div>
          </div>
        </section>

        {/* Gain */}
        {hasComparison && (
          <section className="rounded-xl p-5 text-center" style={{ background: GREEN }}>
            <div className="text-[11px] font-bold uppercase tracking-widest text-white/90">
              Your Gain at Hometown Lending
            </div>
            <div className="mt-1.5 text-3xl font-extrabold text-white">
              {gainSign}
              {usd(gainAnnual)}
            </div>
            <div className="mt-1 text-[13px] text-white/90">
              {(recap.gain.monthly ?? 0) >= 0 ? "+" : ""}
              {usd(recap.gain.monthly)} / month in modeled net comp
            </div>
          </section>
        )}

        {/* Production */}
        <section className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="border-b-2 pb-1.5 text-[15px] font-bold" style={{ color: NAVY, borderColor: GREEN }}>
            Production
          </h2>
          <dl className="mt-3 space-y-2 text-[13px]">
            <Row label={`${periodTitle} funded volume`} value={usd(recap.volume)} />
            <Row label={`${periodTitle} funded files`} value={num(recap.files)} />
            <Row label="Average loan amount" value={usd(recap.avgLoan)} />
            <Row label="HTL LO split" value={`${num(recap.loSplit)}/${100 - Number(recap.loSplit)} — you keep ${num(recap.loSplit)}%`} />
            <Row label="Channel strategy" value={recap.corrActive ? "Broker + Correspondent" : "Broker Only"} />
          </dl>
        </section>

        {/* Economics */}
        <section className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="border-b-2 pb-1.5 text-[15px] font-bold" style={{ color: NAVY, borderColor: GREEN }}>
            LO Economics
          </h2>
          <dl className="mt-3 space-y-2 text-[13px]">
            <Row label="LO net before payroll" value={usd(recap.totals.loNetBeforeHoldback)} />
            <Row label="Your team payroll cost" value={usd(recap.totals.brokerPaidTotal)} />
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm font-extrabold" style={{ color: NAVY }}>
                {months === 12 ? "Final LO net annual comp" : `Final LO net comp — ${periodTitle}`}
              </span>
              <span className="text-lg font-extrabold" style={{ color: GREEN }}>
                {usd(recap.totals.finalLoNetComp)}
              </span>
            </div>
          </dl>
        </section>

        {/* Booking CTA */}
        <section className="rounded-xl bg-white p-6 text-center shadow-sm">
          <div className="text-base font-bold" style={{ color: NAVY }}>
            Want to pressure-test these assumptions?
          </div>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-gray-500">
            No pitch, no commitment. Bring your numbers and poke holes in our math.
          </p>
          <a
            href={BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-lg px-8 py-3.5 text-[15px] font-bold text-white"
            style={{ background: GREEN }}
          >
            <CalendarCheck className="h-4 w-4" /> Book a confidential 15-min walkthrough
          </a>
        </section>

        <footer className="px-2 pt-2 text-center text-[11px] leading-relaxed text-gray-400">
          HomeTown Lending · NMLS #2712965 · 5050 Quorum Drive, Ste. 600, Dallas, TX 75254
          <br />
          All figures are illustrative and not a guarantee of income.
        </footer>
      </main>
    </div>
  );
};

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between">
    <dt className="text-gray-500">{label}</dt>
    <dd className="font-semibold" style={{ color: NAVY }}>
      {value}
    </dd>
  </div>
);

export default RecapView;
