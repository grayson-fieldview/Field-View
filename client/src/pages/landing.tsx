import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/components/theme-provider";
import {
  Camera,
  FolderKanban,
  MapPin,
  Users,
  Shield,
  Sun,
  Moon,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Share2,
  Eye,
  BarChart3,
  Clock,
} from "lucide-react";

const features = [
  {
    icon: Camera,
    title: "Photo Documentation",
    description: "Capture and organize jobsite photos with GPS tagging, timestamps, and powerful annotation tools.",
  },
  {
    icon: FolderKanban,
    title: "Project Management",
    description: "Track every job from start to finish. Assign tasks, monitor progress, and keep your team aligned.",
  },
  {
    icon: MapPin,
    title: "Site Mapping",
    description: "View all active job sites on an interactive map. Access project details with a single click.",
  },
  {
    icon: ClipboardCheck,
    title: "Inspections & Checklists",
    description: "Build reusable inspection templates and safety checklists. Apply them across projects instantly.",
  },
  {
    icon: Share2,
    title: "Client Sharing",
    description: "Generate shareable photo galleries for clients and stakeholders. Control exactly what they see.",
  },
  {
    icon: BarChart3,
    title: "Reports & Analytics",
    description: "Create professional reports with photos and data. Track project timelines and team performance.",
  },
];

const benefits = [
  {
    icon: Clock,
    value: "10x",
    label: "Faster Documentation",
    description: "Eliminate manual photo sorting and reporting",
  },
  {
    icon: Shield,
    value: "100%",
    label: "Cloud Backed Up",
    description: "Never lose a jobsite photo again",
  },
  {
    icon: Users,
    value: "Real-time",
    label: "Team Collaboration",
    description: "Everyone stays on the same page",
  },
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-sidebar">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <div className="flex items-center gap-2.5">
              <Eye className="h-6 w-6 text-primary" />
              <span className="text-lg font-bold tracking-tight text-sidebar-foreground" data-testid="text-landing-logo">Field View</span>
            </div>
            <div className="flex items-center gap-3">
              <Button size="icon" variant="ghost" onClick={toggleTheme} className="text-sidebar-foreground/70" data-testid="button-theme-toggle">
                {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              </Button>
              <a href="/api/login" className="text-sm font-medium text-sidebar-foreground/80 transition-colors" data-testid="link-login">
                Log in
              </a>
              <Button asChild data-testid="button-login">
                <a href="/api/login">Request Demo</a>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <section className="pt-16">
        <div className="bg-muted">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
            <div className="grid lg:grid-cols-2 gap-12 items-start">
              <div className="space-y-8">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Jobsite Photo Documentation
                  </span>
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-serif font-bold tracking-tight leading-[1.1] text-foreground" data-testid="text-hero-title">
                  Document every detail, deliver with confidence
                </h1>
                <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
                  Manage your field projects from first photo to final report with the tools you need to maximize efficiency, accountability, and team coordination.
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <Button asChild size="lg" data-testid="button-get-started">
                    <a href="/api/login" className="gap-2">
                      Get Started Free
                    </a>
                  </Button>
                  <a href="#features" className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors" data-testid="link-see-features">
                    See it in action
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
              <div className="hidden lg:block">
                <div className="grid grid-cols-2 gap-4">
                  {benefits.map((b) => (
                    <Card key={b.label} className="p-5 first:col-span-2">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                          <b.icon className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-foreground">{b.value}</p>
                          <p className="text-sm font-medium text-foreground">{b.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{b.description}</p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="py-20 sm:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-16">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-green-600 dark:bg-green-500" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Platform
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight mb-4" data-testid="text-features-title">
              One platform for your entire field operation
            </h2>
            <p className="text-muted-foreground text-lg leading-relaxed">
              From photo capture to final report, Field View connects your entire team with the tools that matter.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="p-6 hover-elevate transition-all duration-300"
                data-testid={`card-feature-${feature.title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="space-y-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="text-base font-semibold">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 sm:py-24 bg-sidebar">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-foreground/50">
                Why Field View
              </span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight text-sidebar-foreground">
              Built for crews who build things
            </h2>
            <p className="text-sidebar-foreground/60 text-lg leading-relaxed max-w-2xl mx-auto">
              Construction teams, inspectors, and maintenance crews trust Field View to keep their projects documented and on track.
            </p>
            <ul className="grid sm:grid-cols-2 gap-4 text-left max-w-lg mx-auto pt-4">
              {[
                "GPS-tagged photos with timestamps",
                "Advanced photo annotation tools",
                "Interactive map of all job sites",
                "Task management with priorities",
                "Reusable checklist templates",
                "Shareable client galleries",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                  <span className="text-sidebar-foreground/80">{item}</span>
                </li>
              ))}
            </ul>
            <div className="pt-4">
              <Button asChild size="lg" data-testid="button-cta-bottom">
                <a href="/api/login" className="gap-2">
                  Start Documenting
                  <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-primary" />
              <span className="text-sm font-bold">Field View</span>
            </div>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} Field View. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
