import { useEffect, useState } from "react";
import { CheckCircle2, Cloud, Download, Loader2, Mail, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { ModelState, calculate } from "@/lib/proforma";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/auth";
import { buildRecapPayload, sendRecap, isValidEmail, RecapPayload } from "@/lib/recapEmail";
import { renderRecapChartPng } from "@/lib/recapChart";
import { buildRecapDocxBase64 } from "@/lib/recapDocx";
import { autoAdvanceOnRecap } from "@/lib/pipeline";
import { hashRecap } from "@/lib/recapLink";
import { enqueueRecapPresentation } from "@/lib/gammaPresentation";
import {
  ProformaSummary, listProformas, loadProforma, saveProforma, updateProforma, deleteProforma,
} from "@/lib/proformaStore";

interface CloudSaveProps {
  state: ModelState;
  onLoad: (state: ModelState) => void;
}

export const CloudSave = ({ state, onLoad }: CloudSaveProps) => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProformaSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [deleteArmId, setDeleteArmId] = useState<string | null>(null);
  // Post-save confirmation step: verify where the recap email should go.
  // The payload is prepared when the step is entered (from the just-saved
  // state, or from a cloud save for a resend) so sending never depends on
  // what's currently loaded in the editor.
  interface PendingRecap {
    name: string;
    payload: RecapPayload;
    source: "save" | "resend";
  }
  const [step, setStep] = useState<"save" | "confirm">("save");
  const [pendingRecap, setPendingRecap] = useState<PendingRecap | null>(null);
  const [recapEmail, setRecapEmail] = useState("");
  const [sending, setSending] = useState(false);

  const enterConfirmStep = (pending: PendingRecap) => {
    setPendingRecap(pending);
    setRecapEmail(user?.email ?? "");
    setDeleteArmId(null); // an armed delete must not survive the round-trip back to the list
    setStep("confirm");
  };

  const handleSendRecap = async () => {
    if (!pendingRecap || sending) return; // Enter in the email field must not double-send
    const to = recapEmail.trim();
    if (!isValidEmail(to)) {
      toast({ title: "Check the email address", description: "That doesn't look like a valid email.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      // Null chart (no comparison, or no canvas) just means the email keeps
      // its HTML comparison cells — never a blocked send. Same posture for
      // the Word report: null = email without it.
      const chartPng = renderRecapChartPng(pendingRecap.payload);
      const docx = await buildRecapDocxBase64(pendingRecap.payload);
      // Queue the deck before sending so it can be attached — same ordering
      // and same non-fatal posture as the public flow.
      const presentationHash = hashRecap(pendingRecap.payload);
      try {
        await enqueueRecapPresentation(presentationHash, pendingRecap.payload);
      } catch (e) {
        console.warn("Presentation could not be queued; sending without it:", e);
      }
      await sendRecap(to, pendingRecap.payload, chartPng ?? undefined, { docx, presentationHash });
      // Light pipeline automation: a sent recap advances the matching target
      // LO to "Pro Forma Sent" (forward only; never throws).
      autoAdvanceOnRecap(pendingRecap.payload.nmls);
      toast({ title: "Recap sent", description: `The full recap is on its way to ${to}.` });
      const wasResend = pendingRecap.source === "resend";
      setPendingRecap(null);
      setStep("save");
      if (!wasResend) setOpen(false); // a resend returns to the list instead
    } catch (e) {
      toast({ title: "Couldn't send the recap", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const handleResend = async (item: ProformaSummary) => {
    setBusy(true);
    try {
      // Load the saved copy directly — the editor's state is untouched.
      const { name, state: loaded } = await loadProforma(item.id);
      enterConfirmStep({ name, payload: buildRecapPayload(name, loaded, calculate(loaded), item.id), source: "resend" });
    } catch (e) {
      toast({ title: "Couldn't prepare the recap", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!supabase) return;
    setListLoading(true);
    try {
      setItems(await listProformas());
    } catch (e) {
      toast({ title: "Couldn't load cloud saves", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setStep("save");
      setPendingRecap(null);
      setDeleteArmId(null);
      setSaveName(prev => prev || currentName || state.recruitName || "");
      refresh();
    }
  }, [open]); // eslint-disable-line

  const handleSaveNew = async () => {
    const name = saveName.trim() || "Untitled Pro Forma";
    setBusy(true);
    try {
      const id = await saveProforma(name, state);
      setCurrentId(id);
      setCurrentName(name);
      toast({ title: "Saved to cloud", description: `“${name}” is saved.` });
      refresh();
      enterConfirmStep({ name, payload: buildRecapPayload(name, state, calculate(state), id), source: "save" });
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!currentId) return;
    const name = saveName.trim() || currentName || "Untitled Pro Forma";
    setBusy(true);
    try {
      await updateProforma(currentId, name, state);
      setCurrentName(name);
      toast({ title: "Updated", description: `“${name}” now has your latest inputs.` });
      refresh();
      enterConfirmStep({ name, payload: buildRecapPayload(name, state, calculate(state), currentId), source: "save" });
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleLoad = async (item: ProformaSummary) => {
    setBusy(true);
    try {
      const { name, state: loaded } = await loadProforma(item.id);
      onLoad(loaded);
      setCurrentId(item.id);
      setCurrentName(name);
      setSaveName(name);
      setOpen(false);
      toast({ title: "Loaded from cloud", description: `“${name}” is now active.` });
    } catch (e) {
      toast({ title: "Load failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item: ProformaSummary) => {
    setBusy(true);
    try {
      await deleteProforma(item.id);
      if (currentId === item.id) { setCurrentId(null); setCurrentName(null); }
      toast({ title: "Deleted", description: `“${item.name}” was removed from the cloud.` });
      setDeleteArmId(null);
      refresh();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {currentName && (
        <span className="hidden md:inline-flex items-center rounded-full border border-accent/40 px-3 py-1 text-xs text-primary-foreground/85">
          <Cloud className="h-3 w-3 mr-1.5 text-accent" />{currentName}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="Cloud saves"
            title="Cloud saves"
            className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground rounded-full"
          >
            <Cloud className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {step === "confirm" ? (pendingRecap?.source === "resend" ? "Resend the Recap" : "Saved — Send the Recap?") : "Cloud Saves"}
            </DialogTitle>
          </DialogHeader>
          {!supabase ? (
            <p className="text-sm text-muted-foreground py-2">
              Supabase isn't configured. Copy <code>.env.example</code> to <code>.env</code>, add your project URL and anon key, then restart the app.
            </p>
          ) : step === "confirm" ? (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm">
                <CheckCircle2 className="h-4 w-4 mt-0.5 text-success shrink-0" />
                <span>
                  <span className="font-medium">“{pendingRecap?.name ?? "Untitled Pro Forma"}”</span>
                  {pendingRecap?.source === "resend"
                    ? " — re-sending the saved copy from the cloud. Your current inputs aren't affected."
                    : " is saved — a copy is stored in the database."}
                </span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="recap-email">Email the full recap to</Label>
                <Input
                  id="recap-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={recapEmail}
                  onChange={e => setRecapEmail(e.target.value)}
                  placeholder="name@example.com"
                  onKeyDown={e => { if (e.key === "Enter") handleSendRecap(); }}
                />
                <p className="text-xs text-muted-foreground">
                  Verify this address — the recap goes here. If it isn't right, type the email it should be sent to.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    const wasResend = pendingRecap?.source === "resend";
                    setPendingRecap(null);
                    setStep("save");
                    if (!wasResend) setOpen(false); // resend: back to the list
                  }}
                >
                  {pendingRecap?.source === "resend" ? "Back" : "Skip"}
                </Button>
                <Button onClick={handleSendRecap} disabled={sending} className="gold-accent text-accent-foreground hover:opacity-90">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Mail className="h-4 w-4 mr-1" />}
                  {sending ? "Sending…" : "Send Recap"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5 py-2">
              <div className="space-y-2">
                <Label className="text-xs">Name</Label>
                <div className="flex gap-2">
                  <Input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="e.g. Jane Smith — 90% split" />
                  {currentId && (
                    <Button onClick={handleUpdate} disabled={busy} className="gold-accent text-accent-foreground hover:opacity-90 shrink-0">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Update
                    </Button>
                  )}
                  <Button onClick={handleSaveNew} disabled={busy} variant={currentId ? "outline" : "default"} className={currentId ? "shrink-0" : "gold-accent text-accent-foreground hover:opacity-90 shrink-0"}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} {currentId ? "Save as New" : "Save"}
                  </Button>
                </div>
                {currentName && <p className="text-xs text-muted-foreground">Currently loaded: <span className="font-medium text-foreground">{currentName}</span></p>}
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Saved Pro Formas</Label>
                {listLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-secondary/30 px-4 py-6 text-sm text-muted-foreground text-center">
                    Nothing saved yet. Name this pro forma and click <span className="font-medium text-foreground">Save</span>.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                    {items.map(item => (
                      <div key={item.id} className={`flex items-center gap-2 rounded-md border px-3 py-2 ${item.id === currentId ? "border-accent/60 bg-accent/10" : "border-border bg-secondary/30"}`}>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{item.name}</p>
                          <p className="text-[11px] text-muted-foreground">Updated {new Date(item.updated_at).toLocaleString()}</p>
                        </div>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => handleLoad(item)}>
                          <Download className="h-3.5 w-3.5 mr-1" /> Load
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={busy}
                          onClick={() => handleResend(item)}
                          aria-label={`Resend recap for ${item.name}`}
                          title="Resend recap"
                          className="shrink-0"
                        >
                          <Mail className="h-4 w-4" />
                        </Button>
                        {deleteArmId === item.id ? (
                          <Button variant="destructive" size="sm" disabled={busy} onClick={() => handleDelete(item)}>
                            Confirm
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" disabled={busy} onClick={() => setDeleteArmId(item.id)} className="text-destructive hover:bg-destructive/10 shrink-0">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
