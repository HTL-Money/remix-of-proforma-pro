// Catches render-time exceptions so a public visitor sees a recoverable
// message instead of a blank white screen. Internal team members previously
// tolerated "just refresh" since they knew the tool; a public-facing page
// shouldn't ask that of a stranger.
import { Component, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("Unhandled error in the app tree:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen hero-bg text-primary-foreground flex items-center justify-center px-4">
        <div className="max-w-sm text-center space-y-4">
          <AlertTriangle className="h-10 w-10 mx-auto" style={{ color: "hsl(var(--success))" }} />
          <h1 className="font-display font-bold text-2xl">Something went wrong</h1>
          <p className="text-sm text-primary-foreground/75">
            An unexpected error occurred. Refreshing the page usually fixes it.
          </p>
          <Button onClick={() => window.location.reload()} className="gold-accent text-accent-foreground hover:opacity-90">
            Refresh
          </Button>
        </div>
      </div>
    );
  }
}
