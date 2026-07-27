import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LoginGate } from "@/components/LoginGate";
import { AppShell } from "@/components/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Dashboard from "./pages/Dashboard.tsx";
import Index from "./pages/Index.tsx";
import Targets from "./pages/Targets.tsx";
import SentEmails from "./pages/SentEmails.tsx";
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

// "/" used to be the calculator, and shared links like /?nmls=123 still point
// there — keep them working by forwarding to /calculator with the same params.
// A signed-out visitor lands on the calculator itself (no login wall); a
// signed-in team member lands on the dashboard.
const Home = () => {
  const [params] = useSearchParams();
  const { authRequired, loading, user } = useAuth();
  if (params.get("nmls") != null) return <Navigate to={`/calculator?${params.toString()}`} replace />;
  if (authRequired && loading) return <div className="min-h-screen hero-bg" />;
  if (authRequired && !user) return <Index />;
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
                      <Route path="/targets" element={<RequireAuth><Targets /></RequireAuth>} />
                      <Route path="/emails" element={<RequireAuth><SentEmails /></RequireAuth>} />
                      {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                      <Route path="*" element={<NotFound />} />
                    </Routes>
                  </AppShell>
                }
              />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
