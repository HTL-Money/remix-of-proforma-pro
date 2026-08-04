import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LoginGate } from "@/components/LoginGate";
import { AppShell } from "@/components/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SpeedInsights } from "@vercel/speed-insights/react";
import Dashboard from "./pages/Dashboard.tsx";
import Index from "./pages/Index.tsx";
import Targets from "./pages/Targets.tsx";
import SentEmails from "./pages/SentEmails.tsx";
import Submissions from "./pages/Submissions.tsx";
import RecruitLinks from "./pages/RecruitLinks.tsx";
import NotFound from "./pages/NotFound.tsx";
import RecapView from "./pages/RecapView.tsx";

const queryClient = new QueryClient();

// Gates a single route to signed-in team members. The calculator is public
// and never wrapped in this — only the team data pages (dashboard, targets,
// sent emails) require a login.
const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const { authRequired, loading, user } = useAuth();
  if (!authRequired) return <>{children}</>;
  if (loading) return <div className="min-h-screen hero-bg" />;
  if (!user) return <LoginGate />;
  return <>{children}</>;
};

// Admin pages on top of RequireAuth: a signed-in LO who types /targets is
// sent to their own workspace instead. The database enforces the same split
// (is_admin() RLS), so this redirect is UX, not the security boundary.
const RequireAdmin = ({ children }: { children: React.ReactNode }) => {
  const { isAdmin } = useAuth();
  if (isAdmin === null) return <div className="min-h-screen hero-bg" />; // still resolving — don't bounce an admin
  if (!isAdmin) return <Navigate to="/links" replace />;
  return <>{children}</>;
};

// "/" used to be the calculator, and shared links like /?nmls=123 still point
// there — keep them working by forwarding to /calculator with the same params.
// A signed-out visitor lands on the calculator itself (no login wall); a
// signed-in team member lands on the dashboard.
const Home = () => {
  const [params] = useSearchParams();
  const { authRequired, loading, user, isAdmin } = useAuth();
  // ?ref= is a recruit PURL — always land it on the calculator (even for a
  // signed-in team member) so the referral flow is deterministic.
  if (params.get("nmls") != null || params.get("ref") != null) return <Navigate to={`/calculator?${params.toString()}`} replace />;
  if (authRequired && loading) return <div className="min-h-screen hero-bg" />;
  if (authRequired && !user) return <Index />;
  // The dashboard reads admin-gated tables (targets, recap_emails), so a
  // signed-in LO's home is their own workspace instead.
  if (isAdmin === null) return <div className="min-h-screen hero-bg" />;
  if (!isAdmin) return <Navigate to="/links" replace />;
  return <Dashboard />;
};

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              {/* Public hosted recap page for external recruits — rendered
                  OUTSIDE the team AppShell (no sidebar/chrome). Self-contained:
                  reads its data from the link, no auth, no DB. */}
              <Route path="/r" element={<RecapView />} />
              <Route
                path="*"
                element={
                  <AppShell>
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/calculator" element={<Index />} />
                      <Route path="/targets" element={<RequireAuth><RequireAdmin><Targets /></RequireAdmin></RequireAuth>} />
                      <Route path="/emails" element={<RequireAuth><RequireAdmin><SentEmails /></RequireAdmin></RequireAuth>} />
                      {/* Not RequireAdmin: LOs get this page too, scoped by RLS
                          to the pro formas they created ("own proformas"). */}
                      <Route path="/submissions" element={<RequireAuth><Submissions /></RequireAuth>} />
                      <Route path="/links" element={<RequireAuth><RecruitLinks /></RequireAuth>} />
                      {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                      <Route path="*" element={<NotFound />} />
                    </Routes>
                  </AppShell>
                }
              />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
        <SpeedInsights />
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
