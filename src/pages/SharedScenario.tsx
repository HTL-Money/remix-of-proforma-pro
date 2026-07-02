import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { defaultState, type ModelState } from "@/lib/proforma";
import Index from "./Index";
import { Button } from "@/components/ui/button";

interface ScenarioRow {
  recruit_name: string;
  state: ModelState;
  created_at: string;
}

const SharedScenario = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<ScenarioRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!shareId) { setError("Invalid link."); setLoading(false); return; }
      const { data, error } = await supabase
        .from("scenarios")
        .select("recruit_name, state, created_at")
        .eq("share_id", shareId)
        .maybeSingle();
      if (cancelled) return;
      if (error) { setError(error.message); }
      else if (!data) { setError("This shared pro forma could not be found."); }
      else { setRow(data as unknown as ScenarioRow); }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [shareId]);

  useEffect(() => {
    if (row) document.title = `Pro Forma — ${row.recruit_name}`;
  }, [row]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        Loading shared pro forma…
      </div>
    );
  }

  if (error || !row) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="premium-card p-8 max-w-md text-center space-y-4">
          <h1 className="text-2xl font-display font-bold text-primary">Link not available</h1>
          <p className="text-muted-foreground">{error ?? "Not found."}</p>
          <Button asChild><Link to="/">Go to LO Pro Forma</Link></Button>
        </div>
      </div>
    );
  }

  const initial: ModelState = { ...defaultState(), ...row.state };
  const savedAt = new Date(row.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return <Index initialState={initial} sharedMode sharedInfo={{ name: row.recruit_name, savedAt }} />;
};

export default SharedScenario;
