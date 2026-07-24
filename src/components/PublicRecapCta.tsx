import { useState } from "react";
import { CalendarCheck, CheckCircle2, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { ModelState, Calc } from "@/lib/proforma";
import { buildRecapPayload, sendRecap, isValidEmail } from "@/lib/recapEmail";
import { renderRecapChartPng } from "@/lib/recapChart";
import { buildRecapDocxBase64 } from "@/lib/recapDocx";
import { submitPublicProforma } from "@/lib/proformaStore";
import { hashRecap } from "@/lib/recapLink";
import { enqueueRecapPresentation } from "@/lib/gammaPresentation";

// Aryan's live Microsoft Bookings page. The per-recruit cinematic video will
// live on the hosted recap page (Part K) — never embedded inline here.
const BOOKING_URL = "https://outlook.office.com/bookwithme/user/6ae2ff896ce64b4085b2e829a6228568@hometownlend.com?anonymous&ismsaljsauthenabled&ep=pcard";

interface PublicRecapCtaProps {
  state: ModelState;
  calc: Calc;
}

// Anonymous visitors have no Cloud Save button — this is the one action
// available to them: email themselves the recap. The save (tagged
// source: 'public') and the email are independent best-effort steps, same
// as the rest of this app's save/snapshot pattern — one failing never
// blocks the other. After a successful send, the dialog becomes the real
// CTA: AJ's video + the booking link.
export const PublicRecapCta = ({ state, calc }: PublicRecapCtaProps) => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"email" | "sent">("email");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setStep("email"); // fresh entry always starts at the email step
  };

  const handleSend = async () => {
    const to = email.trim();
    if (!isValidEmail(to)) {
      toast({ title: "Check the email address", description: "That doesn't look like a valid email.", variant: "destructive" });
      return;
    }
    setSending(true);
    const name = state.recruitName || "Untitled Pro Forma";
    try {
      const payload = buildRecapPayload(name, state, calc);
      try {
        await submitPublicProforma(name, state);
      } catch (e) {
        console.warn("Public submission not stored:", e);
      }
      const chartPng = renderRecapChartPng(payload);
      // Word report: best-effort (returns null rather than throws) — a
      // rendering hiccup never blocks the email. The presentation (Gamma) is
      // the single deliverable in the email body now — no separate graphic.
      const docx = await buildRecapDocxBase64(payload);
      await sendRecap(to, payload, chartPng ?? undefined, { docx });
      // Kick off the Gamma presentation (fire-and-forget — generation takes
      // time, never blocks this send). The email's presentation link points
      // at Gamma's own hosted URL once it's ready.
      void enqueueRecapPresentation(hashRecap(payload), payload);
      toast({ title: "Recap sent", description: `The full recap is on its way to ${to}.` });
      setStep("sent");
    } catch (e) {
      toast({ title: "Couldn't send the recap", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
        >
          <Mail className="h-4 w-4 mr-1" /> Email me this recap
        </Button>
      </DialogTrigger>
      <DialogContent className={step === "sent" ? "sm:max-w-xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>{step === "sent" ? "Recap sent — take the next step" : "Email me this ProForma"}</DialogTitle>
        </DialogHeader>
        {step === "sent" ? (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-success shrink-0" />
              <span>Your full recap is on its way to <span className="font-medium">{email.trim()}</span>.</span>
            </div>
            <Button asChild className="w-full gold-accent text-accent-foreground hover:opacity-90" size="lg">
              <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer">
                <CalendarCheck className="h-4 w-4 mr-2" /> Book a call with AJ
              </a>
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-2 py-2">
              <Label htmlFor="public-recap-email">Send the full recap to</Label>
              <Input
                id="public-recap-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="name@example.com"
                onKeyDown={e => { if (e.key === "Enter") handleSend(); }}
              />
            </div>
            <DialogFooter>
              <Button onClick={handleSend} disabled={sending} className="gold-accent text-accent-foreground hover:opacity-90">
                {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Mail className="h-4 w-4 mr-1" />}
                {sending ? "Sending…" : "Send Recap"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
