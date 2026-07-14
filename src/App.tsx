import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LoginGate } from "@/components/LoginGate";
import { AppShell } from "@/components/AppShell";
import Dashboard from "./pages/Dashboard.tsx";
import Index from "./pages/Index.tsx";
import Targets from "./pages/Targets.tsx";
import SentEmails from "./pages/SentEmails.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const { authRequired, loading, user } = useAuth();
  if (!authRequired) return <>{children}</>;
  if (loading) return <div className="min-h-screen hero-bg" />;
  if (!user) return <LoginGate />;
  return <>{children}</>;
};

// "/" used to be the calculator, and shared links like /?nmls=123 still point
// there — keep them working by forwarding to /calculator with the same params.
const Home = () => {
  const [params] = useSearchParams();
  if (params.get("nmls") != null) return <Navigate to={`/calculator?${params.toString()}`} replace />;
  return <Dashboard />;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/calculator" element={<Index />} />
                <Route path="/targets" element={<Targets />} />
                <Route path="/emails" element={<SentEmails />} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
