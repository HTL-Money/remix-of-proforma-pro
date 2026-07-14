import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { ModelState, Calc } from "@/lib/proforma";
import { buildRecapPayload, sendRecap, isValidEmail } from "@/lib/recapEmail";
import { renderRecapChartPng } from "@/lib/recapChart";
import { submitPublicProforma } from "@/lib/proformaStore";

interface PublicRecapCtaProps {
  state: ModelState;
  calc: Calc;
}

// Anonymous visitors have no Cloud Save button — this is the one action
// available to them: email themselves the recap. The save (tagged
// source: 'public') and the email are independent best-effort steps, same
// as the rest of this app's save/snapshot pattern — one failing never
// blocks the other.
export const PublicRecapCta = ({ state, calc }: PublicRecapCtaProps) => {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

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
      await sendRecap(to, payload, chartPng ?? undefined);
      toast({ title: "Recap sent", description: `The full recap is on its way to ${to}.` });
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't send the recap", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
        >
          <Mail className="h-4 w-4 mr-1" /> Email me this recap
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email me this ProForma</DialogTitle>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
};
