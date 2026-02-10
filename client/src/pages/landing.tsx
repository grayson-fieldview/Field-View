import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/components/theme-provider";
import {
  Camera,
  FolderKanban,
  MapPin,
  Users,
  Shield,
  Zap,
  Sun,
  Moon,
  Aperture,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Share2,
} from "lucide-react";

const features = [
  {
    icon: Camera,
    title: "Smart Photo Capture",
    description: "Auto-tag photos with GPS, timestamps, and project context. Annotate with shapes, arrows, and color-coded markups right on site.",
  },
  {
    icon: FolderKanban,
    title: "Project Hub",
    description: "Organize every job into a single workspace. Track tasks, assign team members, and monitor progress at a glance.",
  },
  {
    icon: MapPin,
    title: "Live Site Map",
    description: "See all your active jobs on an interactive map. Tap any pin to view project photos, tasks, and status updates.",
  },
  {
    icon: ClipboardCheck,
    title: "Checklists & Reports",
    description: "Create reusable inspection templates, safety checklists, and progress reports. Apply them across projects with one click.",
  },
  {
    icon: Share2,
    title: "Instant Sharing",
    description: "Generate shareable photo galleries with a link. Clients and stakeholders see exactly what you want them to see.",
  },
  {
    icon: Users,
    title: "Team Sync",
    description: "Everyone stays on the same page. Comment on photos, assign tasks, and get real-time updates from the field.",
  },
];

const stats = [
  { value: "10x", label: "Faster Documentation" },
  { value: "100%", label: "Cloud Backed Up" },
  { value: "0", label: "Photos Lost" },
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-14">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Aperture className="h-4 w-4" />
              </div>
              <span className="text-lg font-bold tracking-tight" data-testid="text-landing-logo">SiteSnap</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="ghost" onClick={toggleTheme} data-testid="button-theme-toggle">
                {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </Button>
              <Button asChild data-testid="button-login">
                <a href="/api/login">Sign In</a>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <section className="relative pt-28 pb-20 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/3" />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative">
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <div className="space-y-5">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
                <Zap className="h-3.5 w-3.5" />
                Purpose-built for field crews
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-serif font-bold tracking-tight leading-[1.1]" data-testid="text-hero-title">
                Your jobsite,{" "}
                <span className="text-primary">captured</span>{" "}
                and organized
              </h1>
              <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
                Photo documentation, task tracking, and team collaboration in one tool built for construction, inspection, and maintenance crews.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" asChild data-testid="button-get-started">
                <a href="/api/login" className="gap-2">
                  Get Started Free
                  <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
              {["Free to start", "No credit card", "Unlimited projects"].map((item) => (
                <div key={item} className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-14 grid grid-cols-3 gap-6 max-w-lg mx-auto">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-3xl font-bold text-primary">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-card/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-14">
            <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight" data-testid="text-features-title">
              Everything in one place
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Stop juggling apps. SiteSnap combines the tools your field team actually needs.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="p-5 hover-elevate transition-all duration-300"
                data-testid={`card-feature-${feature.title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="space-y-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <feature.icon className="h-4 w-4" />
                  </div>
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight">
              Ready to streamline your field work?
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Join teams who've ditched the clipboard and switched to SiteSnap. Upload photos from the job site, tag them with project details, and share progress with your entire team instantly.
            </p>
            <ul className="grid sm:grid-cols-2 gap-3 text-left max-w-md mx-auto">
              {[
                "GPS-tagged photos with timestamps",
                "Organize media by project or tags",
                "Interactive map of all job sites",
                "Task management with due dates",
                "Reusable checklist templates",
                "Shareable photo galleries",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <Button asChild size="lg" data-testid="button-cta-bottom">
              <a href="/api/login" className="gap-2">
                Start Documenting
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t py-6">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Aperture className="h-3 w-3" />
              </div>
              <span className="text-sm font-semibold">SiteSnap</span>
            </div>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} SiteSnap. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
