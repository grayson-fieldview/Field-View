import { Switch, Route, Redirect, useSearch, useLocation } from "wouter";
import { queryClient, apiRequest } from "./lib/queryClient";
// Session 3 Commit B: MONTHLY_PRICE_ID + throw removed (was used only by
// BillingBanner.startCheckout). Trial-active and trial-expired Add Card
// CTAs now route to /subscribe (plan picker) instead of POSTing directly
// to /api/create-checkout-session. Past-due banner still uses apiRequest
// → /api/create-portal-session, so the apiRequest import stays.
import { QueryClientProvider } from "@tanstack/react-query";
import { GoogleReCaptchaProvider } from "react-google-recaptcha-v3";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, CreditCard } from "lucide-react";
import { useEffect, useRef } from "react";
import { registerTrialExpiredHandler } from "@/lib/queryClient";
import "@/lib/meta-pixel";
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
import ChecklistTemplateEditPage from "@/pages/checklist-template-edit";
import GalleryPage from "@/pages/gallery";
import PublicReportPage from "@/pages/public-report";
import PublicProjectPage from "@/pages/public-project";
import TasksPage from "@/pages/tasks";
import AnalyticsPage from "@/pages/analytics";
import CalendarPage from "@/pages/calendar";

function BillingBanner() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
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

  // Session 3 Commit B: trial Add Card CTAs route to /subscribe (plan
  // picker) instead of opening Stripe Checkout directly with a hardcoded
  // monthly single-seat line item. Lets users pick monthly/annual + team
  // size before committing a card. Past-due banner still uses openPortal
  // → Stripe Customer Portal (correct destination for failed payment).
  const goToSubscribe = () => setLocation("/subscribe");

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
          onClick={goToSubscribe}
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
          onClick={goToSubscribe}
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
          {/* Session 3 BUG 4 fix: BillingBanner moved INSIDE the main
              content column (after AppSidebar, inside the flex-1 main
              column) so the sidebar — which uses position:fixed in its
              mobile/collapsed state — can never overlap the banner's
              left edge. Previously the banner was a sibling of
              SidebarProvider, which let the sidebar's fixed-position
              chrome overlay it on smaller viewports, hiding the
              "Your trial ends in X days. Add a" prefix. */}
          <BillingBanner />
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
              <Route path="/checklist-templates/:id/edit">
                {(params) => <ChecklistTemplateEditPage id={params.id} />}
              </Route>
              <Route path="/analytics" component={AnalyticsPage} />
              <Route path="/calendar" component={CalendarPage} />
              <Route path="/map" component={MapPage} />
              <Route path="/team" component={TeamPage} />
              <Route path="/manager/timesheets" component={ManagerTimesheetsPage} />
              <Route path="/settings" component={SettingsPage} />
              {/* Session 3 Commit B: /subscribe is now a real route inside
                  AuthenticatedLayout. Previously SubscribePage rendered
                  only via SubscriptionGate's locked-access fallback, so
                  any setLocation("/subscribe") from a trialing user
                  (accessLevel: "full") fell through to NotFound. */}
              <Route path="/subscribe" component={SubscribePage} />
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

// PR 3: Meta Pixel SPA PageView tracker. The base pixel + initial PageView
// fire from initMetaPixel() in main.tsx. This effect fires an additional
// PageView every time the wouter location changes — skipping the first
// render so we don't double-count the initial load. Mounted inside the
// inner JSX of App() so it has access to wouter context and covers every
// route (public gallery/report/p included).
function MetaPixelRouteTracker() {
  const [location] = useLocation();
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    if (typeof window !== "undefined" && window.fbq) {
      window.fbq("track", "PageView");
    }
  }, [location]);
  return null;
}

function CatchAllRedirect() {
  const search = useSearch();
  const [loc] = useLocation();
  const target = search ? `/signup?${search}` : `/signup`;
  // [DIAG] Session 3 BUG 2 instrumentation
  console.log("[catchall] render", { fromLocation: loc, redirectingTo: target });
  return <Redirect to={target} />;
}

function AppContent() {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

  // [DIAG] Session 3 BUG 2 instrumentation — every render of the auth gate
  console.log("[appcontent] render", {
    location,
    isLoading,
    hasUser: !!user,
    userId: (user as any)?.id ?? null,
    profileCompletedAt: (user as any)?.profileCompletedAt ?? null,
    emailVerified: (user as any)?.emailVerified ?? null,
    accessLevel: (user as any)?.accessLevel ?? null,
    subscriptionStatus: (user as any)?.subscriptionStatus ?? null,
  });

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
    console.log("[appcontent] gate=unauthenticated", { location });
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
    if (location !== "/welcome") {
      console.log("[appcontent] gate=needs-welcome → redirect /welcome", { location });
      return <Redirect to="/welcome" />;
    }
    console.log("[appcontent] gate=needs-welcome → render WelcomePage");
    return <WelcomePage />;
  }
  if (location === "/welcome") {
    console.log("[appcontent] gate=profile-done & on /welcome → redirect /");
    return <Redirect to="/" />;
  }

  if (!(user as any).emailVerified) {
    if (location !== "/verify-email") {
      console.log("[appcontent] gate=needs-verify → redirect /verify-email", { location });
      return <Redirect to="/verify-email" />;
    }
    console.log("[appcontent] gate=needs-verify → render VerifyEmailPage");
    return <VerifyEmailPage />;
  }
  if ((user as any).emailVerified && location === "/verify-email") {
    console.log("[appcontent] gate=verified & on /verify-email → redirect /");
    return <Redirect to="/" />;
  }

  console.log("[appcontent] gate=passthrough → SubscriptionGate");
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
          <MetaPixelRouteTracker />
          <ErrorBoundary>
            <Switch>
              <Route path="/gallery/:token">
                {(params) => <GalleryPage token={params.token} />}
              </Route>
              <Route path="/report/:token">
                {(params) => <PublicReportPage token={params.token} />}
              </Route>
              <Route path="/p/:token">
                {(params) => <PublicProjectPage token={params.token} />}
              </Route>
              <Route>
                <AppContent />
              </Route>
            </Switch>
          </ErrorBoundary>
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
