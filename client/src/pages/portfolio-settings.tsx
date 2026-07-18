import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Loader2,
  Check,
  X,
  ExternalLink,
  Copy,
  Globe,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ShowcaseSettings } from "@shared/schema";

type ShowcaseSettingsData = ShowcaseSettings & {
  accountName: string | null;
  accountLogoUrl: string | null;
};

export default function PortfolioSettingsPage() {
  const { toast } = useToast();
  const { data: settings, isLoading } = useQuery<ShowcaseSettingsData>({
    queryKey: ["/api/showcase-settings"],
  });

  const [portfolioEnabled, setPortfolioEnabled] = useState(false);
  const [portfolioSlug, setPortfolioSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [brandColor, setBrandColor] = useState("#F09000");
  const [showMap, setShowMap] = useState(true);
  const [contactCtaEnabled, setContactCtaEnabled] = useState(false);
  const [contactCtaLabel, setContactCtaLabel] = useState("");
  const [contactCtaUrl, setContactCtaUrl] = useState("");
  const [introText, setIntroText] = useState("");
  const [initialized, setInitialized] = useState(false);

  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (settings && !initialized) {
      setPortfolioEnabled(settings.portfolioEnabled);
      setPortfolioSlug(settings.portfolioSlug || "");
      setDisplayName(settings.displayName || "");
      setLogoUrl(settings.logoUrl || "");
      setBrandColor(settings.brandColor || "#F09000");
      setShowMap(settings.showMap);
      setContactCtaEnabled(settings.contactCtaEnabled);
      setContactCtaLabel(settings.contactCtaLabel || "");
      setContactCtaUrl(settings.contactCtaUrl || "");
      setIntroText(settings.introText || "");
      setInitialized(true);
    }
  }, [settings, initialized]);

  // Debounced slug availability check
  useEffect(() => {
    if (!initialized) return;
    const slug = portfolioSlug.trim();
    if (!slug) {
      setSlugStatus("idle");
      return;
    }
    if (slug === settings?.portfolioSlug) {
      setSlugStatus("available");
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug)) {
      setSlugStatus("invalid");
      return;
    }
    setSlugStatus("checking");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/showcase-settings/slug-check?slug=${encodeURIComponent(slug)}`, {
          credentials: "include",
        });
        const data = await res.json();
        setSlugStatus(data.available ? "available" : "taken");
      } catch {
        setSlugStatus("idle");
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [portfolioSlug, initialized, settings?.portfolioSlug]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/showcase-settings", {
        portfolioEnabled,
        portfolioSlug: portfolioSlug.trim() || null,
        displayName: displayName.trim() || null,
        logoUrl: logoUrl.trim() || null,
        brandColor: brandColor || null,
        showMap,
        contactCtaEnabled,
        contactCtaLabel: contactCtaLabel.trim() || null,
        contactCtaUrl: contactCtaUrl.trim() || null,
        introText: introText.trim() || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcase-settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
  });

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const publicUrl = portfolioSlug.trim() ? `${origin}/p/${portfolioSlug.trim()}` : "";
  const embedCode = portfolioSlug.trim()
    ? `<iframe src="${origin}/p/${portfolioSlug.trim()}/embed" width="100%" height="600" frameborder="0" style="border:0"></iframe>`
    : "";
  const effectiveLogo = logoUrl.trim() || settings?.accountLogoUrl || "";

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/showcases">
          <Button size="icon" variant="ghost" data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-settings-title">
            Portfolio Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure your public showcase portfolio.
          </p>
        </div>
      </div>

      <Card className="p-6 space-y-6">
        {/* Enable */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Enable public portfolio</p>
            <p className="text-xs text-muted-foreground">
              Make your published showcases visible at your portfolio URL.
            </p>
          </div>
          <Switch
            checked={portfolioEnabled}
            onCheckedChange={setPortfolioEnabled}
            data-testid="switch-portfolio-enabled"
          />
        </div>

        <Separator />

        {/* Slug */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Portfolio URL</label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground shrink-0">{origin}/p/</span>
            <Input
              value={portfolioSlug}
              onChange={(e) => setPortfolioSlug(e.target.value.toLowerCase())}
              placeholder="your-company"
              data-testid="input-portfolio-slug"
            />
          </div>
          {slugStatus === "checking" && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking…
            </p>
          )}
          {slugStatus === "available" && (
            <p className="text-xs text-green-600 flex items-center gap-1" data-testid="hint-slug-available">
              <Check className="h-3 w-3" /> Available
            </p>
          )}
          {slugStatus === "taken" && (
            <p className="text-xs text-destructive flex items-center gap-1" data-testid="hint-slug-taken">
              <X className="h-3 w-3" /> That URL is taken
            </p>
          )}
          {slugStatus === "invalid" && (
            <p className="text-xs text-destructive flex items-center gap-1" data-testid="hint-slug-invalid">
              <X className="h-3 w-3" /> Use lowercase letters, numbers and dashes
            </p>
          )}
        </div>

        {/* Display name */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Display name</label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={settings?.accountName || "Your company name"}
            data-testid="input-display-name"
          />
        </div>

        {/* Logo */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Logo URL</label>
          <Input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            data-testid="input-logo-url"
          />
          {effectiveLogo && (
            <div className="mt-2">
              <img
                src={effectiveLogo}
                alt="Logo preview"
                className="h-12 rounded-md border object-contain bg-muted p-1"
                data-testid="img-logo-preview"
              />
            </div>
          )}
        </div>

        {/* Brand color */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Brand color</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-9 w-14 rounded-md border cursor-pointer bg-transparent"
              data-testid="input-brand-color"
            />
            <span className="text-sm text-muted-foreground">{brandColor}</span>
          </div>
        </div>

        <Separator />

        {/* Show map */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Show location strip</p>
            <p className="text-xs text-muted-foreground">
              Display approximate showcase locations on your public portfolio.
            </p>
          </div>
          <Switch checked={showMap} onCheckedChange={setShowMap} data-testid="switch-show-map" />
        </div>

        <Separator />

        {/* Contact CTA */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Contact call-to-action</p>
              <p className="text-xs text-muted-foreground">Show a button linking visitors to contact you.</p>
            </div>
            <Switch
              checked={contactCtaEnabled}
              onCheckedChange={setContactCtaEnabled}
              data-testid="switch-contact-cta"
            />
          </div>
          {contactCtaEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Button label</label>
                <Input
                  value={contactCtaLabel}
                  onChange={(e) => setContactCtaLabel(e.target.value)}
                  placeholder="Get a quote"
                  data-testid="input-cta-label"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Button URL</label>
                <Input
                  value={contactCtaUrl}
                  onChange={(e) => setContactCtaUrl(e.target.value)}
                  placeholder="https://…"
                  data-testid="input-cta-url"
                />
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Intro */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Intro text</label>
          <Textarea
            value={introText}
            onChange={(e) => setIntroText(e.target.value)}
            placeholder="Tell visitors about your work…"
            rows={4}
            data-testid="input-intro-text"
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-settings">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </Card>

      {/* Public URL / embed */}
      {portfolioEnabled && settings?.portfolioEnabled && settings?.portfolioSlug && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Your public portfolio</h2>
          </div>
          <a
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline flex items-center gap-1.5"
            data-testid="link-view-portfolio"
          >
            <ExternalLink className="h-4 w-4" />
            {publicUrl}
          </a>
          <div className="space-y-2">
            <label className="text-sm font-medium">Embed code</label>
            <div className="flex items-start gap-2">
              <Textarea
                value={embedCode}
                readOnly
                rows={2}
                className="font-mono text-xs"
                data-testid="text-embed-code"
              />
              <Button
                size="icon"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(embedCode);
                  toast({ title: "Embed code copied" });
                }}
                data-testid="button-copy-embed"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
