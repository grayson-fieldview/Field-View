import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  BarChart3,
  Pencil,
  SlidersHorizontal,
  CalendarDays,
  FileText,
  Zap,
  Layers,
  Globe,
  Smartphone,
  Menu,
  X,
  ChevronRight,
  Minus,
  Plus,
  DollarSign,
  Flame,
  Paintbrush,
  Wrench,
  TreePine,
  Droplets,
  Building2,
  HardHat,
  Plug,
  Hammer,
  Wind,
  Truck,
  Construction,
} from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";
import painterImg from "@assets/stock_images/painter_working.jpg";
import plumberImg from "@assets/stock_images/plumber_working.jpg";
import electricianImg from "@assets/stock_images/electrician_working_1.jpg";
import constructionTeamImg from "@assets/stock_images/construction_phone_2.jpg";
import hvacTechImg from "@assets/stock_images/hvac_technician.jpg";

const features = [
  {
    icon: Camera,
    title: "Photo Documentation",
    description:
      "Capture, organize, and tag jobsite photos with automatic GPS coordinates, timestamps, and project association. Never lose a photo again.",
    bullets: [
      "Automatic GPS & timestamp",
      "Project-based organization",
      "Search & filter across all jobs",
    ],
  },
  {
    icon: Pencil,
    title: "Photo Annotations",
    description:
      "Mark up photos on-site with 5 drawing tools, 8 colors, and adjustable stroke widths. Highlight defects, mark measurements, or add notes.",
    bullets: [
      "Freehand, arrow, circle, rectangle, line",
      "8 color options with adjustable width",
      "Save annotated versions instantly",
    ],
  },
  {
    icon: FolderKanban,
    title: "Task Management",
    description:
      "Create, assign, and track tasks per project. Set priorities, due dates, and statuses. Get overdue alerts right on your dashboard.",
    bullets: [
      "Priority levels: Low to Urgent",
      "Due dates with overdue tracking",
      "Status workflow: To Do, In Progress, Done",
    ],
  },
  {
    icon: MapPin,
    title: "Interactive Site Map",
    description:
      "See every active project pinned on a live map. Click any marker to jump straight into project details, photos, and tasks.",
    bullets: [
      "All job sites at a glance",
      "Click-to-navigate markers",
      "Dashboard mini-map widget",
    ],
  },
  {
    icon: ClipboardCheck,
    title: "Checklists & Inspections",
    description:
      "Build reusable inspection and safety checklist templates. Apply them to any project with one click and track completion in real time.",
    bullets: [
      "Reusable checklist templates",
      "Per-project tracking",
      "Completion status at a glance",
    ],
  },
  {
    icon: FileText,
    title: "Reports & Daily Logs",
    description:
      "Generate professional inspection, safety, and progress reports. Auto-generate daily logs with photos, tasks, and comments for any date.",
    bullets: [
      "5 report types (inspection, safety, progress, incident, daily)",
      "Reusable report templates",
      "Auto-generated daily activity logs",
    ],
  },
  {
    icon: Share2,
    title: "Client Gallery Sharing",
    description:
      "Create branded, shareable photo galleries for clients and stakeholders. Control what they see with configurable metadata and descriptions.",
    bullets: [
      "Shareable links, no login required",
      "Configurable display options",
      "Professional client-ready presentation",
    ],
  },
  {
    icon: BarChart3,
    title: "Analytics Dashboard",
    description:
      "Monitor team performance and project progress with 7 stat cards, charts by user, project, and time period, plus a photo location map.",
    bullets: [
      "Photos by user, project & time",
      "Task status breakdown",
      "Custom date ranges (7d to all-time)",
    ],
  },
  {
    icon: SlidersHorizontal,
    title: "Before & After Comparisons",
    description:
      "Drag a slider to compare two project photos side by side. Show clients the transformation or document progress over time.",
    bullets: [
      "Side-by-side drag slider",
      "Select any two project photos",
      "Perfect for progress documentation",
    ],
  },
  {
    icon: Users,
    title: "Team Collaboration",
    description:
      "Invite your crew, assign tasks, comment on photos, and track everyone's contributions. Real-time activity feeds keep your whole team aligned.",
    bullets: [
      "Per-photo commenting",
      "Real-time activity feed",
      "Team member directory",
    ],
  },
  {
    icon: Zap,
    title: "Command Center Dashboard",
    description:
      "Your home base. See KPIs, overdue task alerts, recent photos, a project location mini-map, and an activity feed all in one view.",
    bullets: [
      "KPI strip with live counts",
      "Overdue task alerts",
      "Mini-map & recent photos",
    ],
  },
  {
    icon: Globe,
    title: "Google Maps Integration",
    description:
      "Type an address and get autocomplete suggestions from Google Places. Latitude and longitude are captured automatically for map features.",
    bullets: [
      "Google Places autocomplete",
      "Auto-populated coordinates",
      "Integrated with site mapping",
    ],
  },
];

const industries = [
  {
    icon: Flame,
    name: "HVAC",
    description:
      "Document installations, track maintenance schedules, and share progress photos with commercial clients.",
  },
  {
    icon: HardHat,
    name: "Roofing",
    description:
      "Capture before/after roof inspections, annotate damage areas, and generate insurance-ready photo reports.",
  },
  {
    icon: TreePine,
    name: "Landscaping",
    description:
      "Photograph completed work, manage recurring maintenance tasks, and share project galleries with property owners.",
  },
  {
    icon: Paintbrush,
    name: "Painting",
    description:
      "Document color selections, track room-by-room progress, and create shareable galleries for design approvals.",
  },
  {
    icon: Droplets,
    name: "Plumbing",
    description:
      "Photo-document pipe runs, track inspection checklists, and generate daily logs for commercial builds.",
  },
  {
    icon: Plug,
    name: "Electrical",
    description:
      "Annotate panel photos, manage inspection checklists, and keep your entire crew aligned on job progress.",
  },
  {
    icon: Building2,
    name: "General Contractors",
    description:
      "Oversee multiple sub-trades, track tasks across job sites, and share client-facing photo galleries.",
  },
  {
    icon: Construction,
    name: "Construction",
    description:
      "Full project lifecycle documentation from groundbreaking to punch list with daily logs and analytics.",
  },
  {
    icon: Hammer,
    name: "Remodeling",
    description:
      "Before/after comparisons, room-by-room task tracking, and professional photo presentations for homeowners.",
  },
  {
    icon: Wind,
    name: "Insulation",
    description:
      "Document coverage areas, manage safety checklists, and track project progress across multiple crews.",
  },
  {
    icon: Wrench,
    name: "Maintenance",
    description:
      "Log recurring work orders, photograph completed repairs, and build a searchable history of every job.",
  },
  {
    icon: Truck,
    name: "Property Management",
    description:
      "Track maintenance requests, document unit conditions, and share inspection galleries with owners and tenants.",
  },
];

const checklistItems = [
  "GPS-tagged photos with timestamps",
  "5 annotation drawing tools",
  "Task management with priorities & due dates",
  "Reusable checklist & report templates",
  "Shareable client photo galleries",
  "Interactive project site map",
  "Before & after photo comparisons",
  "Auto-generated daily activity logs",
  "Real-time analytics dashboard",
  "Team collaboration & activity feed",
  "Google Maps address autocomplete",
  "Dark mode for field use at night",
];

export default function LandingPage() {
  const { theme, toggleTheme } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [annual, setAnnual] = useState(true);
  const [teamSize, setTeamSize] = useState(3);

  const handleSignup = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      setSubmitted(true);
      setEmail("");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 bg-sidebar border-b border-sidebar-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <div className="flex items-center gap-2.5 shrink-0" data-testid="img-landing-logo">
              <img src={faviconImg} alt="Field View" className="h-9 w-9 rounded-md" />
              <span className="text-lg font-bold tracking-tight text-sidebar-foreground">Field View</span>
            </div>

            <div className="hidden md:flex items-center gap-6">
              <a
                href="#features"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector("#features")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
                data-testid="link-nav-features"
              >
                Features
              </a>
              <a
                href="#industries"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector("#industries")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
                data-testid="link-nav-industries"
              >
                Industries
              </a>
              <a
                href="#why"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector("#why")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
                data-testid="link-nav-why"
              >
                Why Field View
              </a>
              <a
                href="#pricing"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector("#pricing")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
                data-testid="link-nav-pricing"
              >
                Pricing
              </a>
              <a
                href="#signup"
                onClick={(e) => {
                  e.preventDefault();
                  document.querySelector("#signup")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="text-sm text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
                data-testid="link-nav-signup"
              >
                Get Started
              </a>
            </div>

            <div className="flex items-center gap-2 sm:gap-3">
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleTheme}
                className="text-sidebar-foreground/70"
                data-testid="button-theme-toggle"
              >
                {theme === "light" ? (
                  <Moon className="h-4 w-4" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
              </Button>
              <a
                href="/api/login"
                className="hidden sm:inline text-sm font-medium text-sidebar-foreground/80 transition-colors"
                data-testid="link-login"
              >
                Log in
              </a>
              <Button asChild className="hidden sm:inline-flex" data-testid="button-login">
                <a href="/api/login">Start Free</a>
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="md:hidden text-sidebar-foreground/70"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                data-testid="button-mobile-menu"
              >
                {mobileMenuOpen ? (
                  <X className="h-5 w-5" />
                ) : (
                  <Menu className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-sidebar border-t border-sidebar-border">
            <div className="px-4 py-4 space-y-3">
              <a
                href="#features"
                className="block text-sm text-sidebar-foreground/80 py-2"
                onClick={() => setMobileMenuOpen(false)}
                data-testid="link-mobile-features"
              >
                Features
              </a>
              <a
                href="#industries"
                className="block text-sm text-sidebar-foreground/80 py-2"
                onClick={() => setMobileMenuOpen(false)}
                data-testid="link-mobile-industries"
              >
                Industries
              </a>
              <a
                href="#why"
                className="block text-sm text-sidebar-foreground/80 py-2"
                onClick={() => setMobileMenuOpen(false)}
                data-testid="link-mobile-why"
              >
                Why Field View
              </a>
              <a
                href="#pricing"
                className="block text-sm text-sidebar-foreground/80 py-2"
                onClick={() => setMobileMenuOpen(false)}
                data-testid="link-mobile-pricing"
              >
                Pricing
              </a>
              <a
                href="#signup"
                className="block text-sm text-sidebar-foreground/80 py-2"
                onClick={() => setMobileMenuOpen(false)}
                data-testid="link-mobile-signup"
              >
                Get Started
              </a>
              <div className="flex items-center gap-3 pt-2 border-t border-sidebar-border">
                <a
                  href="/api/login"
                  className="text-sm font-medium text-sidebar-foreground/80"
                  data-testid="link-mobile-login"
                >
                  Log in
                </a>
                <Button asChild size="sm" data-testid="button-mobile-start">
                  <a href="/api/login">Start Free</a>
                </Button>
              </div>
            </div>
          </div>
        )}
      </nav>

      <section className="pt-16">
        <div className="bg-muted">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24 lg:py-32">
            <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
              <div className="space-y-6 sm:space-y-8">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Field Intelligence Platform
                  </span>
                </div>
                <h1
                  className="text-3xl sm:text-4xl md:text-5xl lg:text-[3.5rem] font-serif font-bold tracking-tight leading-[1.1] text-foreground"
                  data-testid="text-hero-title"
                >
                  Your field command center for photos, tasks & insights
                </h1>
                <p className="text-base sm:text-lg text-muted-foreground max-w-lg leading-relaxed">
                  Go beyond basic photo apps. Field View combines photo
                  documentation, structured task management, interactive maps,
                  real-time analytics, and team collaboration into one powerful
                  platform built for field service pros.
                </p>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <Button asChild size="lg" data-testid="button-get-started">
                    <a href="/api/login" className="gap-2">
                      Get Started Free
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </Button>
                  <a
                    href="#features"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors"
                    data-testid="link-see-features"
                  >
                    See all features
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-6 grid-rows-4 gap-2 sm:gap-3 h-[320px] sm:h-[380px] lg:h-[420px]" data-testid="hero-photo-mosaic">
                <div className="col-span-4 row-span-2 relative rounded-xl overflow-hidden">
                  <img src={constructionTeamImg} alt="Construction team reviewing plans on site" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <span className="text-white text-xs font-medium">Construction Team</span>
                  </div>
                </div>
                <div className="col-span-2 row-span-2 relative rounded-xl overflow-hidden">
                  <img src={painterImg} alt="Professional painter at work" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <span className="text-white text-xs font-medium">Painter</span>
                  </div>
                </div>
                <div className="col-span-2 row-span-2 relative rounded-xl overflow-hidden">
                  <img src={electricianImg} alt="Electrician installing outlet" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <span className="text-white text-xs font-medium">Electrician</span>
                  </div>
                </div>
                <div className="col-span-2 row-span-2 relative rounded-xl overflow-hidden">
                  <img src={plumberImg} alt="Plumber fixing faucet" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <span className="text-white text-xs font-medium">Plumber</span>
                  </div>
                </div>
                <div className="col-span-2 row-span-2 relative rounded-xl overflow-hidden">
                  <img src={hvacTechImg} alt="HVAC technician with safety gear" className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <span className="text-white text-xs font-medium">HVAC Tech</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-primary" />
              Photo Documentation
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-primary" />
              Task Management
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              Site Mapping
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Analytics
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-primary" />
              Inspections
            </span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" />
              Client Sharing
            </span>
          </div>
        </div>
      </section>

      <section id="features" className="py-16 sm:py-20 lg:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-12 sm:mb-16">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-[#267D32]" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Platform Features
              </span>
            </div>
            <h2
              className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight mb-4"
              data-testid="text-features-title"
            >
              Everything your field team needs in one place
            </h2>
            <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
              From photo capture to analytics dashboards, Field View replaces a
              scattered toolkit of apps with one integrated platform your whole
              crew can rely on.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="p-5 sm:p-6 hover:scale-[1.02] hover:shadow-lg transition-all duration-300 cursor-default group"
                data-testid={`card-feature-${feature.title.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="space-y-3 sm:space-y-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 group-hover:bg-primary group-hover:text-white transition-colors duration-300">
                    <feature.icon className="h-5 w-5 text-primary group-hover:text-white transition-colors duration-300" />
                  </div>
                  <h3 className="text-base font-semibold group-hover:text-primary transition-colors duration-300">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                  <ul className="space-y-1.5 pt-1">
                    {feature.bullets.map((b) => (
                      <li
                        key={b}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#267D32] mt-0.5 shrink-0" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="industries" className="py-16 sm:py-20 lg:py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
            <div className="flex items-center justify-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Built For Your Trade
              </span>
            </div>
            <h2
              className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight mb-4"
              data-testid="text-industries-title"
            >
              Tailored for every field service business
            </h2>
            <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
              Whether you're on a roof, under a house, or in a crawl space,
              Field View adapts to how your trade works.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {industries.map((ind) => (
              <Card
                key={ind.name}
                className="p-4 sm:p-5 hover:scale-[1.05] hover:shadow-md transition-all duration-300 cursor-default group"
                data-testid={`card-industry-${ind.name.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 group-hover:bg-primary group-hover:text-white transition-colors duration-300">
                    <ind.icon className="h-4 w-4 text-primary group-hover:text-white transition-colors duration-300" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold group-hover:text-primary transition-colors duration-300">{ind.name}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed mt-1 hidden sm:block">
                      {ind.description}
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 sm:py-20 lg:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-start">
            <div className="space-y-6">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-[#267D32]" />
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  How It Works
                </span>
              </div>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight">
                From the field to the office in three steps
              </h2>
              <div className="space-y-6 pt-2">
                {[
                  {
                    step: "01",
                    title: "Capture",
                    desc: "Take photos on-site. They're automatically GPS-tagged, timestamped, and organized by project.",
                  },
                  {
                    step: "02",
                    title: "Organize & Annotate",
                    desc: "Add annotations, create tasks, fill out checklists, and attach photos to daily logs. Everything stays connected.",
                  },
                  {
                    step: "03",
                    title: "Share & Analyze",
                    desc: "Share client galleries, generate reports, and monitor your team's performance from the analytics dashboard.",
                  },
                ].map((s) => (
                  <div key={s.step} className="flex gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-sm">
                      {s.step}
                    </div>
                    <div>
                      <h3 className="font-semibold mb-1">{s.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {s.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Card className="p-5 sm:p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Layers className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-sm">
                    Platform Highlights
                  </h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                  {checklistItems.map((item) => (
                    <div
                      key={item}
                      className="flex items-start gap-2.5 text-sm"
                    >
                      <CheckCircle2 className="h-4 w-4 text-[#267D32] mt-0.5 shrink-0" />
                      <span className="text-muted-foreground">{item}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      <section id="why" className="py-16 sm:py-20 lg:py-24 bg-sidebar">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary" />
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-foreground/50">
                  Why Field View
                </span>
              </div>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight text-sidebar-foreground">
                More than just a camera app
              </h2>
              <p className="text-sidebar-foreground/60 text-base sm:text-lg leading-relaxed">
                Photo-only tools leave your crew juggling spreadsheets, texts,
                and separate apps for tasks. Field View replaces them all with
                one integrated command center.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                {[
                  {
                    icon: Smartphone,
                    title: "Built for the Field",
                    desc: "Responsive design that works on phones, tablets, and desktops.",
                  },
                  {
                    icon: Shield,
                    title: "100% Cloud Backed Up",
                    desc: "Every photo, task, and report is safely stored and always accessible.",
                  },
                  {
                    icon: Users,
                    title: "Whole-Team Visibility",
                    desc: "Everyone sees the same data. No more asking 'who took that photo?'",
                  },
                  {
                    icon: Zap,
                    title: "Instant Setup",
                    desc: "Sign up, create a project, and start documenting in under 2 minutes.",
                  },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15">
                      <item.icon className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-sidebar-foreground">
                        {item.title}
                      </h3>
                      <p className="text-xs text-sidebar-foreground/50 mt-0.5 leading-relaxed">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-bold text-sidebar-foreground mb-4">Frequently Asked Questions</h3>
                <div className="space-y-3">
                  {[
                    {
                      q: "How many photos can we upload?",
                      a: "Unlimited. We don't believe in capping your project documentation.",
                    },
                    {
                      q: "Does it work offline?",
                      a: "Yes, our mobile-optimized web app handles intermittent field connectivity seamlessly.",
                    },
                    {
                      q: "Does Field View offer a free trial?",
                      a: "Yes, we offer a 14-day free trial so you can experience the full power of the platform with your team.",
                    },
                  ].map((faq) => (
                    <div
                      key={faq.q}
                      className="p-4 rounded-lg border border-sidebar-border bg-sidebar-accent/50 hover:bg-sidebar-accent transition-colors"
                    >
                      <h4 className="font-semibold text-sm text-sidebar-foreground mb-1">{faq.q}</h4>
                      <p className="text-xs text-sidebar-foreground/60 leading-relaxed">
                        {faq.a}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <Card className="p-6 bg-primary/10 border-primary/20">
                <h3 className="font-bold mb-2 text-primary">Ready to take command?</h3>
                <p className="text-sm text-sidebar-foreground/60 mb-4 leading-relaxed">
                  Join hundreds of field teams who have traded their scattered
                  apps for one integrated intelligence platform.
                </p>
                <Button asChild className="w-full">
                  <a href="/api/login">Start Your Free Trial</a>
                </Button>
              </Card>
            </div>
          </div>
        </div>
      </section>

      <section id="pricing" className="py-16 sm:py-20 lg:py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
            <div className="flex items-center justify-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Simple Pricing
              </span>
            </div>
            <h2
              className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight mb-4"
              data-testid="text-pricing-title"
            >
              One plan. Everything included.
            </h2>
            <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
              No hidden fees, no feature gates. Every team gets the full platform.
            </p>
          </div>

          <div className="max-w-lg mx-auto">
            <div className="flex items-center justify-center gap-3 mb-8">
              <span className={`text-sm font-medium transition-colors ${!annual ? "text-foreground" : "text-muted-foreground"}`}>Monthly</span>
              <button
                onClick={() => setAnnual(!annual)}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${annual ? "bg-primary" : "bg-muted-foreground/30"}`}
                data-testid="toggle-billing-period"
              >
                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${annual ? "translate-x-6" : "translate-x-1"}`} />
              </button>
              <span className={`text-sm font-medium transition-colors ${annual ? "text-foreground" : "text-muted-foreground"}`}>Annual</span>
              {annual && (
                <Badge className="bg-[#267D32]/10 text-[#267D32] border-[#267D32]/20 text-xs" data-testid="badge-save">
                  Save 38%
                </Badge>
              )}
            </div>

            <Card className="p-6 sm:p-8 border-primary/30 shadow-lg">
              <div className="text-center mb-6">
                <div className="flex items-baseline justify-center gap-1 mb-1">
                  <span className="text-4xl sm:text-5xl font-bold tracking-tight" data-testid="text-base-price">
                    ${annual ? "49" : "79"}
                  </span>
                  <span className="text-muted-foreground text-sm">/month</span>
                </div>
                {annual && (
                  <p className="text-xs text-muted-foreground">Billed annually (${49 * 12}/year)</p>
                )}
                <p className="text-sm text-muted-foreground mt-2">
                  Includes <strong className="text-foreground">3 users</strong> and <strong className="text-foreground">unlimited cloud storage</strong>
                </p>
              </div>

              <div className="border rounded-lg p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium" htmlFor="team-size">Team size</label>
                  <span className="text-xs text-muted-foreground">
                    {teamSize <= 3 ? "Included" : `+${teamSize - 3} extra seat${teamSize - 3 > 1 ? "s" : ""}`}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setTeamSize(Math.max(1, teamSize - 1))}
                    disabled={teamSize <= 1}
                    data-testid="button-decrease-seats"
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    id="team-size"
                    type="number"
                    min={1}
                    max={999}
                    value={teamSize}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      if (!isNaN(val) && val >= 1) setTeamSize(Math.min(999, val));
                    }}
                    className="text-center text-lg font-semibold h-9 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    data-testid="input-team-size"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setTeamSize(Math.min(999, teamSize + 1))}
                    data-testid="button-increase-seats"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {teamSize > 3 && (
                  <p className="text-xs text-muted-foreground mt-2 text-center">
                    Additional users: ${annual ? "24" : "29"}/month each
                  </p>
                )}
              </div>

              <div className="border rounded-lg p-4 mb-6 bg-muted/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">Base plan (3 users)</span>
                  <span className="text-sm font-medium">${annual ? "49" : "79"}/mo</span>
                </div>
                {teamSize > 3 && (
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">{teamSize - 3} additional user{teamSize - 3 > 1 ? "s" : ""} × ${annual ? "24" : "29"}</span>
                    <span className="text-sm font-medium">${(teamSize - 3) * (annual ? 24 : 29)}/mo</span>
                  </div>
                )}
                <div className="border-t pt-2 mt-2 flex items-center justify-between">
                  <span className="text-sm font-semibold">Total</span>
                  <div className="text-right">
                    <span className="text-2xl font-bold text-primary" data-testid="text-total-price">
                      ${(annual ? 49 : 79) + Math.max(0, teamSize - 3) * (annual ? 24 : 29)}
                    </span>
                    <span className="text-sm text-muted-foreground">/month</span>
                    {annual && (
                      <p className="text-xs text-muted-foreground">
                        ${((annual ? 49 : 79) + Math.max(0, teamSize - 3) * (annual ? 24 : 29)) * 12}/year
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <Button asChild size="lg" className="w-full gap-2 mb-4" data-testid="button-pricing-cta">
                <a href="/api/login">
                  Start 14-Day Free Trial
                  <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
              <p className="text-xs text-muted-foreground text-center">No credit card required</p>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-6 pt-6 border-t">
                {[
                  "Unlimited photos & storage",
                  "All annotation tools",
                  "Task management",
                  "Checklists & reports",
                  "Client gallery sharing",
                  "Analytics dashboard",
                  "Interactive site map",
                  "Daily activity logs",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#267D32] shrink-0" />
                    <span className="text-muted-foreground">{item}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </section>

      <section id="signup" className="py-16 sm:py-20 lg:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mx-auto text-center space-y-6 sm:space-y-8">
            <div className="flex items-center justify-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Get Started
              </span>
            </div>
            <h2
              className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight"
              data-testid="text-signup-title"
            >
              Ready to upgrade your field operations?
            </h2>
            <p className="text-muted-foreground text-base sm:text-lg leading-relaxed max-w-xl mx-auto">
              Join field service teams who have replaced scattered photo rolls,
              spreadsheets, and text threads with one powerful platform.
            </p>

            {submitted ? (
              <Card className="p-6 sm:p-8 max-w-md mx-auto">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#267D32]/10">
                    <CheckCircle2 className="h-6 w-6 text-[#267D32]" />
                  </div>
                  <h3
                    className="font-semibold text-lg"
                    data-testid="text-signup-success"
                  >
                    You're on the list
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    We'll be in touch shortly with your access details.
                  </p>
                  <Button asChild className="mt-2" data-testid="button-try-now">
                    <a href="/api/login">Try It Now</a>
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="p-6 sm:p-8 max-w-md mx-auto">
                <form
                  onSubmit={handleSignup}
                  className="space-y-4"
                  data-testid="form-signup"
                >
                  <div className="space-y-2 text-left">
                    <label
                      htmlFor="signup-email"
                      className="text-sm font-medium"
                    >
                      Work email
                    </label>
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      data-testid="input-signup-email"
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full gap-2"
                    size="lg"
                    data-testid="button-signup-submit"
                  >
                    Request Early Access
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    Free to start. No credit card required.
                  </p>
                </form>
                <div className="mt-4 pt-4 border-t text-center">
                  <p className="text-sm text-muted-foreground mb-2">
                    Already have an account?
                  </p>
                  <Button
                    asChild
                    variant="outline"
                    data-testid="button-login-existing"
                  >
                    <a href="/api/login">Log In</a>
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      </section>

      <section className="py-16 sm:py-20 lg:py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto space-y-6">
            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-serif font-bold tracking-tight">
              Stop juggling apps. Start running jobs.
            </h2>
            <p className="text-muted-foreground text-base sm:text-lg leading-relaxed">
              Your crews are in the field right now. Give them the tools to
              document, collaborate, and deliver&mdash;all from one platform.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2">
              <Button asChild size="lg" data-testid="button-cta-bottom">
                <a href="/api/login" className="gap-2">
                  Get Started Free
                  <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                data-testid="button-cta-demo"
              >
                <a href="/api/login">Request a Demo</a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <footer className="bg-sidebar border-t border-sidebar-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            <div className="col-span-2 sm:col-span-1">
              <div className="flex items-center gap-2 mb-3" data-testid="img-footer-logo">
                <img src={faviconImg} alt="Field View" className="h-8 w-8 rounded-md" />
                <span className="text-base font-bold tracking-tight text-sidebar-foreground">Field View</span>
              </div>
              <p className="text-xs text-sidebar-foreground/50 leading-relaxed">
                The field intelligence platform for teams who build, maintain,
                and inspect.
              </p>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/40 mb-3">
                Platform
              </h4>
              <ul className="space-y-2">
                {[
                  "Photo Documentation",
                  "Task Management",
                  "Site Mapping",
                  "Analytics",
                  "Reports",
                ].map((item) => (
                  <li key={item}>
                    <a
                      href="#features"
                      className="text-sm text-sidebar-foreground/60 transition-colors"
                    >
                      {item}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/40 mb-3">
                Industries
              </h4>
              <ul className="space-y-2">
                {["HVAC", "Roofing", "Landscaping", "Electrical", "Plumbing", "General Contractors"].map(
                  (item) => (
                    <li key={item}>
                      <a
                        href="#industries"
                        className="text-sm text-sidebar-foreground/60 transition-colors"
                      >
                        {item}
                      </a>
                    </li>
                  )
                )}
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/40 mb-3">
                Company
              </h4>
              <ul className="space-y-2">
                {["About", "Contact", "Privacy Policy", "Terms of Service"].map(
                  (item) => (
                    <li key={item}>
                      <a
                        href="#"
                        className="text-sm text-sidebar-foreground/60 transition-colors"
                      >
                        {item}
                      </a>
                    </li>
                  )
                )}
              </ul>
            </div>
          </div>

          <div className="mt-8 pt-6 border-t border-sidebar-border flex flex-wrap items-center justify-between gap-4">
            <p className="text-xs text-sidebar-foreground/40">
              &copy; {new Date().getFullYear()} Field View. All rights reserved.
            </p>
            <Badge variant="outline" className="text-sidebar-foreground/40 border-sidebar-border no-default-hover-elevate no-default-active-elevate">
              Field Intelligence Platform
            </Badge>
          </div>
        </div>
      </footer>
    </div>
  );
}
