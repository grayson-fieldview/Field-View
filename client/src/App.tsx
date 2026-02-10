import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
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
import AnalyticsPage from "@/pages/analytics";

function AuthenticatedLayout() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <main className="flex-1 overflow-auto">
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/projects" component={ProjectsPage} />
              <Route path="/projects/:id">
                {(params) => <ProjectDetailPage id={params.id} />}
              </Route>
              <Route path="/photos" component={PhotosPage} />
              <Route path="/checklists" component={ChecklistsPage} />
              <Route path="/reports" component={ReportsPage} />
              <Route path="/analytics" component={AnalyticsPage} />
              <Route path="/map" component={MapPage} />
              <Route path="/team" component={TeamPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
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
    return <LandingPage />;
  }

  return <AuthenticatedLayout />;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Switch>
            <Route path="/gallery/:token">
              {(params) => <GalleryPage token={params.token} />}
            </Route>
            <Route>
              <AppContent />
            </Route>
          </Switch>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
