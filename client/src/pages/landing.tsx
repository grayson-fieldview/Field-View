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
  Eye,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

const features = [
  {
    icon: Camera,
    title: "Photo Documentation",
    description: "Capture and organize photos with automatic timestamps, GPS location, and annotations for every job site visit.",
  },
  {
    icon: FolderKanban,
    title: "Project Management",
    description: "Create projects, assign tasks, track progress with timelines, and keep your entire field team aligned.",
  },
  {
    icon: MapPin,
    title: "Interactive Map View",
    description: "View all your projects on an interactive map. Click markers to see project details and recent media.",
  },
  {
    icon: Users,
    title: "Team Collaboration",
    description: "Comment on photos, assign tasks, and keep everyone on the same page with real-time project updates.",
  },
  {
    icon: Shield,
    title: "Secure & Reliable",
    description: "Enterprise-grade security for your project data. Role-based access ensures the right people see the right information.",
  },
  {
    icon: Zap,
    title: "Fast & Mobile Ready",
    description: "Built for the field. Works seamlessly on phones and tablets so your team can document on the go.",
  },
];

const trustItems = [
  "Free to get started",
  "No credit card required",
  "Unlimited projects",
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Eye className="h-5 w-5" />
              </div>
              <span className="text-lg font-semibold tracking-tight" data-testid="text-landing-logo">Field View</span>
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

      <section className="relative pt-32 pb-20 overflow-hidden">
        <div className="absolute inset-0 opacity-5">
          <img
            src="/images/pattern-bg.png"
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-8">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
                  <Zap className="h-3.5 w-3.5" />
                  Built for field teams
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-serif font-bold tracking-tight leading-tight" data-testid="text-hero-title">
                  Document Every Detail from the{" "}
                  <span className="text-primary">Field</span>
                </h1>
                <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
                  The all-in-one platform for field service teams to capture photos, manage projects, and collaborate in real time. Never miss a detail again.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" asChild data-testid="button-get-started">
                  <a href="/api/login" className="gap-2">
                    Get Started Free
                    <ArrowRight className="h-4 w-4" />
                  </a>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                {trustItems.map((item) => (
                  <div key={item} className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="relative hidden lg:block">
              <div className="relative rounded-md overflow-hidden ring-1 ring-border">
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent z-10" />
                <img
                  src="/images/hero-construction.png"
                  alt="Construction site documentation"
                  className="w-full h-auto object-cover transition-transform duration-700 hover:scale-105"
                />
                <div className="absolute bottom-4 left-4 right-4 z-20">
                  <div className="flex items-center gap-3 text-white">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white/20 backdrop-blur-sm">
                      <Camera className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">248 Photos Captured</p>
                      <p className="text-xs text-white/70">Across 12 active projects</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 bg-card/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-4 mb-16">
            <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight" data-testid="text-features-title">
              Everything your field team needs
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Powerful tools designed specifically for construction crews, inspectors, and maintenance workers.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="p-6 hover-elevate transition-all duration-300"
                data-testid={`card-feature-${feature.title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="space-y-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <feature.icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-lg font-semibold">{feature.title}</h3>
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="relative rounded-md overflow-hidden ring-1 ring-border">
              <img
                src="/images/hero-worker.png"
                alt="Field worker using tablet"
                className="w-full h-auto object-cover"
              />
            </div>
            <div className="space-y-6">
              <h2 className="text-3xl sm:text-4xl font-serif font-bold tracking-tight">
                Built for the way you work
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Field View understands the unique challenges of field work. Upload photos right from the job site, tag them with project details, and share progress with your entire team instantly.
              </p>
              <ul className="space-y-3">
                {[
                  "GPS-tagged photos with automatic timestamps",
                  "Organize media by project, date, or custom tags",
                  "Interactive map showing all project locations",
                  "Task management with assignments and due dates",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-5 w-5 text-primary mt-0.5 shrink-0" />
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
        </div>
      </section>

      <footer className="border-t py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Eye className="h-4 w-4" />
              </div>
              <span className="text-sm font-semibold">Field View</span>
            </div>
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} Field View. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
