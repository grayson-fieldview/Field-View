import { Switch, Route, Redirect, useSearch, useLocation } from "wouter";
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
import { AlertTriangle, Clock, CreditCard } from "lucide-react";
import { useEffect } from "react";
import { registerTrialExpiredHandler } from "@/lib/queryClient";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import WelcomePage from "@/pages/welcome";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import VerifyEmailPage from "@/pages/verify-email";
import SubscribePage from "@/pages/subscribe";
import DashboardPage from "@/pages/dashboard";
import ProjectsPage from "@/pages/projects";
import ProjectDetailPage from "@/pages/project-detail";
import PhotosPage from "@/pages/photos";
import MapPage from "@/pages/map";
import TeamPage from "@/pages/team";
import ManagerTimesheetsPage from "@/pages/manager-timesheets";
import SettingsPage from "@/pages/settings";
import ChecklistsPage from "@/pages/checklists";
import ReportsPage from "@/pages/reports";
import ReportEditPage from "@/pages/report-edit";
import TemplateEditPage from "@/pages/template-edit";
import GalleryPage from "@/pages/gallery";
import PublicReportPage from "@/pages/public-report";
import TasksPage from "@/pages/tasks";
import AnalyticsPage from "@/pages/analytics";
import CalendarPage from "@/pages/calendar";

// Session 2 trial-flow rework: monthly default plan for direct-Checkout
// CTAs from the trial banner. Annual upgrades stay in Settings → Billing.
const MONTHLY_PRICE_ID = "price_1TMaPlR1AnIJLf9qcJsFWa1w";

function BillingBanner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const accessLevel = (user as any)?.accessLevel;
  const status = (user as any)?.subscriptionStatus;
  const trialEndsAtRaw = (user as any)?.trialEndsAt;

  // Determine which of three modes (if any) to render.
  // - trial-active: status is trialing/trial AND access is full → orange,
  //   persistent for the entire trial. Direct-Checkout "Add Card" CTA.
  // - trial-expired: status is trialing/trial AND access is read_only →
  //   red, "Add a card to continue". Direct-Checkout CTA.
  // - past-due: access is read_only AND status past_due → amber, opens
  //   the existing Stripe Billing Portal (legacy payment-failed flow).
  // Invitees inherit the parent account's 'active' status, so the
  // status-based check naturally excludes them — they never see this
  // banner.
  const isTrial = status === "trialing" || status === "trial";
  const trialEndsAt = trialEndsAtRaw ? new Date(trialEndsAtRaw) : null;
  const daysLeft = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0;

  let mode: "trial-active" | "trial-expired" | "past-due" | null = null;
  if (isTrial && accessLevel === "full") mode = "trial-active";
  else if (isTrial && accessLevel === "read_only") mode = "trial-expired";
  else if (status === "past_due" && accessLevel === "read_only") mode = "past-due";

  const startCheckout = async () => {
    try {
      const res = await apiRequest("POST", "/api/create-checkout-session", {
        lineItems: [{ priceId: MONTHLY_PRICE_ID, quantity: 1 }],
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast({ title: "Error", description: "Could not open checkout", variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Could not open checkout", variant: "destructive" });
    }
  };

  const openPortal = async () => {
    try {
      const res = await apiRequest("POST", "/api/create-portal-session", {});
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else toast({ title: "Error", description: "Could not open billing portal", variant: "destructive" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Could not open billing portal", variant: "destructive" });
    }
  };

  if (!mode) return null;

  if (mode === "trial-active") {
    const label = daysLeft === 1 ? "1 day remaining" : `${daysLeft} days remaining`;
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full flex items-center gap-3 px-4 py-3 bg-orange-50 dark:bg-orange-950/30 text-orange-900 dark:text-orange-100 border-b border-orange-200 dark:border-orange-800"
        data-testid="banner-trial-active"
      >
        <Clock className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm" data-testid="text-trial-active-message">
          <span className="font-medium">Trial: {label}.</span>{" "}
          Add a card now to keep your team running after your trial ends.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={startCheckout}
          className="border-orange-300 dark:border-orange-700 bg-white dark:bg-orange-900 hover:bg-orange-100 dark:hover:bg-orange-800 text-orange-900 dark:text-orange-100"
          data-testid="button-add-card-trial"
        >
          <CreditCard className="h-4 w-4 mr-1.5" />
          Add Card
        </Button>
      </div>
    );
  }

  if (mode === "trial-expired") {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="w-full flex items-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-100 border-b border-red-200 dark:border-red-800"
        data-testid="banner-trial-expired"
      >
        <AlertTriangle className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm" data-testid="text-trial-expired-message">
          <span className="font-medium">Your trial has ended.</span>{" "}
          Your account is read-only — add a card to continue creating and editing.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={startCheckout}
          className="border-red-300 dark:border-red-700 bg-white dark:bg-red-900 hover:bg-red-100 dark:hover:bg-red-800 text-red-900 dark:text-red-100"
          data-testid="button-add-card-expired"
        >
          <CreditCard className="h-4 w-4 mr-1.5" />
          Add Card
        </Button>
      </div>
    );
  }

  // mode === "past-due"
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
        onClick={openPortal}
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
      <BillingBanner />
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
              <Route path="/reports/:id/edit">
                {(params) => <ReportEditPage id={params.id} />}
              </Route>
              <Route path="/templates/:id/edit">
                {(params) => <TemplateEditPage id={params.id} />}
              </Route>
              <Route path="/analytics" component={AnalyticsPage} />
              <Route path="/calendar" component={CalendarPage} />
              <Route path="/map" component={MapPage} />
              <Route path="/team" component={TeamPage} />
              <Route path="/manager/timesheets" component={ManagerTimesheetsPage} />
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

// Bridges the apiRequest 402 trial_expired interceptor (defined in
// queryClient.ts) into the React toast system. Mounted once near the
// top of the tree so non-React fetch wrappers can still surface a
// debounced toast when a write is rejected post-trial.
function TrialExpiredToastBridge() {
  const { toast } = useToast();
  useEffect(() => {
    registerTrialExpiredHandler((message) => {
      toast({
        title: "Trial ended",
        description: message,
        variant: "destructive",
      });
    });
    return () => registerTrialExpiredHandler(null);
  }, [toast]);
  return null;
}

function CatchAllRedirect() {
  const search = useSearch();
  const target = search ? `/signup?${search}` : `/signup`;
  return <Redirect to={target} />;
}

function AppContent() {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

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
        <Route>
          <CatchAllRedirect />
        </Route>
      </Switch>
    );
  }

  // Profile completion gate — fresh trial signups land here before reaching
  // the dashboard. Invitees have profileCompletedAt set at /api/register time
  // and skip this entirely.
  if (!(user as any).profileCompletedAt) {
    if (location !== "/welcome") return <Redirect to="/welcome" />;
    return <WelcomePage />;
  }
  if (location === "/welcome") return <Redirect to="/" />;

  if (!(user as any).emailVerified) {
    if (location !== "/verify-email") return <Redirect to="/verify-email" />;
    return <VerifyEmailPage />;
  }
  if ((user as any).emailVerified && location === "/verify-email") return <Redirect to="/" />;

  return <SubscriptionGate />;
}

function App() {
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

  const inner = (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <TrialExpiredToastBridge />
          <Switch>
            <Route path="/gallery/:token">
              {(params) => <GalleryPage token={params.token} />}
            </Route>
            <Route path="/report/:token">
              {(params) => <PublicReportPage token={params.token} />}
            </Route>
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
