import { Switch, Route, Redirect, useSearch } from "wouter";
import { queryClient, apiRequest } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { GoogleReCaptchaProvider } from "react-google-recaptcha-v3";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import CheckEmailPage from "@/pages/check-email";
import VerifyEmailPage from "@/pages/verify-email";
import SubscribePage from "@/pages/subscribe";
import DashboardPage from "@/pages/dashboard";
import ProjectsPage from "@/pages/projects";
import ProjectDetailPage from "@/pages/project-detail";
import PhotosPage from "@/pages/photos";
import MapPage from "@/pages/map";
import TeamPage from "@/pages/team";
import SettingsPage from "@/pages/settings";
import ChecklistsPage from "@/pages/checklists";
import ReportsPage from "@/pages/reports";
import GalleryPage from "@/pages/gallery";
import TasksPage from "@/pages/tasks";
import AnalyticsPage from "@/pages/analytics";
import CalendarPage from "@/pages/calendar";

function SubscriptionLapsedBanner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const accessLevel = (user as any)?.accessLevel;

  if (accessLevel !== "read_only") return null;

  const handleUpdatePaymentMethod = async () => {
    try {
      const res = await apiRequest("POST", "/api/create-portal-session", {});
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast({
          title: "Error",
          description: "Could not open billing portal",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Could not open billing portal",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="w-full flex items-center gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-100 border-b border-amber-200 dark:border-amber-800"
      data-testid="banner-subscription-lapsed"
    >
      <AlertTriangle className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
      <p className="flex-1 text-sm" data-testid="text-subscription-lapsed-message">
        Payment failed. Your account is in read-only mode. Update your payment method to restore full access.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={handleUpdatePaymentMethod}
        className="border-amber-300 dark:border-amber-700 bg-white dark:bg-amber-900 hover:bg-amber-100 dark:hover:bg-amber-800 text-amber-900 dark:text-amber-100"
        data-testid="button-update-payment-method"
      >
        Update payment method
      </Button>
    </div>
  );
}

function AuthenticatedLayout() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden">
      <SubscriptionLapsedBanner />
      <SidebarProvider
        style={style as React.CSSProperties}
        className="!min-h-0 flex-1"
      >
      <div className="flex h-full w-full overflow-x-hidden">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0 overflow-x-hidden">
          <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b bg-background">
            <SidebarTrigger data-testid="button-mobile-menu" />
            <span className="text-sm font-medium text-foreground">Field View</span>
          </div>
          <main className="flex-1 overflow-auto">
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/login"><Redirect to="/" /></Route>
              <Route path="/register"><Redirect to="/" /></Route>
              <Route path="/signup"><Redirect to="/" /></Route>
              <Route path="/forgot-password"><Redirect to="/" /></Route>
              <Route path="/reset-password" component={ResetPasswordPage} />
              <Route path="/projects" component={ProjectsPage} />
              <Route path="/projects/:id">
                {(params) => <ProjectDetailPage id={params.id} />}
              </Route>
              <Route path="/tasks" component={TasksPage} />
              <Route path="/photos" component={PhotosPage} />
              <Route path="/checklists" component={ChecklistsPage} />
              <Route path="/reports" component={ReportsPage} />
              <Route path="/analytics" component={AnalyticsPage} />
              <Route path="/calendar" component={CalendarPage} />
              <Route path="/map" component={MapPage} />
              <Route path="/team" component={TeamPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
      </SidebarProvider>
    </div>
  );
}

function SubscriptionGate() {
  const { user } = useAuth();

  if (!user) return null;

  const accessLevel = (user as any).accessLevel || "locked";

  if (accessLevel === "full" || accessLevel === "read_only") {
    return <AuthenticatedLayout />;
  }

  return <SubscribePage />;
}

function CatchAllRedirect() {
  const search = useSearch();
  const target = search ? `/signup?${search}` : `/signup`;
  return <Redirect to={target} />;
}

function AppContent() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-md" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/signup" component={RegisterPage} />
        <Route path="/register" component={RegisterPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/check-email" component={CheckEmailPage} />
        <Route>
          <CatchAllRedirect />
        </Route>
      </Switch>
    );
  }

  return <SubscriptionGate />;
}

function App() {
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

  const inner = (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Switch>
            <Route path="/gallery/:token">
              {(params) => <GalleryPage token={params.token} />}
            </Route>
            <Route path="/verify-email" component={VerifyEmailPage} />
            <Route>
              <AppContent />
            </Route>
          </Switch>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );

  if (!recaptchaSiteKey) {
    return inner;
  }

  return (
    <GoogleReCaptchaProvider
      reCaptchaKey={recaptchaSiteKey}
      scriptProps={{ async: true, defer: true, appendTo: "head" }}
    >
      {inner}
    </GoogleReCaptchaProvider>
  );
}

export default App;
