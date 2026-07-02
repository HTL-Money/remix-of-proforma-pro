import { useState } from "react";
import { Share2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { ModelState } from "@/lib/proforma";

function makeShareId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export const SaveShareDialog = ({ state }: { state: ModelState }) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setName(""); setEmail(""); setPhone(""); setShareUrl(null); setCopied(false); setSaving(false);
  };

  const save = async () => {
    if (!name.trim() || !email.trim() || !phone.trim()) {
      toast({ title: "Missing info", description: "Name, email, and phone are required.", variant: "destructive" });
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      toast({ title: "Invalid email", description: "Please enter a valid email address.", variant: "destructive" });
      return;
    }
    setSaving(true);
    const share_id = makeShareId();
    const { error } = await supabase.from("scenarios").insert({
      share_id,
      recruit_name: name.trim().slice(0, 120),
      recruit_email: email.trim().slice(0, 254),
      recruit_phone: phone.trim().slice(0, 40),
      state: state as any,
    });
    setSaving(false);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
      return;
    }
    const url = `${window.location.origin}/s/${share_id}`;
    setShareUrl(url);
    toast({ title: "Scenario saved", description: "Share link ready to copy." });
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Copy the link manually.", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="bg-transparent border-accent/40 text-primary-foreground hover:bg-accent hover:text-accent-foreground gap-2"
        >
          <Share2 className="h-4 w-4" />
          Save & Share
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shareUrl ? "Scenario Saved" : "Save & Share Pro Forma"}</DialogTitle>
        </DialogHeader>

        {!shareUrl ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save this pro forma and get a link the recruit can revisit anytime.
            </p>
            <div className="space-y-2">
              <Label>Recruit Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" maxLength={120} />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@example.com" maxLength={254} />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567" maxLength={40} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save & Get Link"}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Share this link with {name}:</p>
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} className="font-mono text-sm" onFocus={e => e.currentTarget.select()} />
              <Button onClick={copy} variant="outline" size="icon" aria-label="Copy link">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone with the link can view and adjust the numbers. Changes they make won't overwrite this saved copy.
            </p>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
