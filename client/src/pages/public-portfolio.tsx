import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MapPin, Image as ImageIcon, ExternalLink } from "lucide-react";
import PublicProjectPage from "@/pages/public-project";

interface PortfolioMeta {
  portfolioSlug: string;
  displayName: string;
  logoUrl: string | null;
  brandColor: string | null;
  showMap: boolean;
  contactCtaEnabled: boolean;
  contactCtaLabel: string | null;
  contactCtaUrl: string | null;
  introText: string | null;
}

interface PortfolioShowcase {
  slug: string;
  title: string;
  projectTypes: string[] | null;
  locationLabel: string | null;
  displayLat: number | null;
  displayLng: number | null;
  photoCount: number;
  coverUrl: string;
}

interface PortfolioData {
  portfolio: PortfolioMeta;
  showcases: PortfolioShowcase[];
}

function recordPortfolioView(slug: string, showcaseSlug: string | null) {
  const key = `sv:${slug}:${showcaseSlug || "_"}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // sessionStorage unavailable — still fire once per page load
  }
  fetch(`/api/public/portfolio/${slug}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      showcaseSlug: showcaseSlug || undefined,
      referrer: document.referrer || null,
    }),
  }).catch(() => {});
}

function ShowcaseCard({
  slug,
  sc,
  embed,
}: {
  slug: string;
  sc: PortfolioShowcase;
  embed?: boolean;
}) {
  const href = `/p/${slug}/${sc.slug}`;
  const inner = (
    <Card
      className="overflow-hidden hover-elevate h-full flex flex-col"
      data-testid={`card-showcase-${sc.slug}`}
    >
      <div className="aspect-[4/3] bg-muted overflow-hidden">
        {sc.coverUrl ? (
          <img
            src={sc.coverUrl}
            alt={sc.title}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
      </div>
      <div className="p-4 space-y-2 flex-1 flex flex-col">
        <h3
          className="font-semibold text-base leading-tight"
          data-testid={`text-showcase-title-${sc.slug}`}
        >
          {sc.title}
        </h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground mt-auto">
          {sc.locationLabel && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {sc.locationLabel}
            </span>
          )}
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3.5 w-3.5" />
            {sc.photoCount} {sc.photoCount === 1 ? "photo" : "photos"}
          </span>
        </div>
      </div>
    </Card>
  );

  if (embed) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md"
        data-testid={`link-showcase-${sc.slug}`}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link
      href={href}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md"
      data-testid={`link-showcase-${sc.slug}`}
    >
      {inner}
    </Link>
  );
}

export function PublicPortfolioPage({
  slug,
  embed,
}: {
  slug: string;
  embed?: boolean;
}) {
  const { data, isLoading, error } = useQuery<PortfolioData>({
    queryKey: ["/api/public/portfolio", slug],
    retry: false,
  });

  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  useEffect(() => {
    if (data) recordPortfolioView(slug, null);
  }, [data, slug]);

  useEffect(() => {
    if (data?.portfolio.displayName) {
      const previous = document.title;
      document.title = `${data.portfolio.displayName} — Project Portfolio`;
      return () => {
        document.title = previous;
      };
    }
  }, [data?.portfolio.displayName]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-4 py-10 space-y-6">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-5 w-2/3" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <h1 className="text-2xl font-bold" data-testid="text-portfolio-error">
            Portfolio not found
          </h1>
          <p className="text-muted-foreground">
            This portfolio may be unavailable or the link is incorrect.
          </p>
        </div>
      </div>
    );
  }

  const { portfolio, showcases } = data;
  const brandColor = portfolio.brandColor || undefined;

  const allTypes = Array.from(
    new Set(showcases.flatMap((s) => s.projectTypes || [])),
  ).sort();

  const visible = typeFilter
    ? showcases.filter((s) => (s.projectTypes || []).includes(typeFilter))
    : showcases;

  const hasCoords = showcases.some(
    (s) => s.displayLat != null && s.displayLng != null,
  );

  return (
    <div className="min-h-screen bg-background">
      {!embed && (
        <header className="border-b bg-card">
          <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
            <div className="flex items-center gap-4">
              {portfolio.logoUrl && (
                <img
                  src={portfolio.logoUrl}
                  alt={portfolio.displayName}
                  className="h-12 w-auto object-contain shrink-0"
                  data-testid="img-portfolio-logo"
                />
              )}
              <div className="min-w-0">
                <h1
                  className="text-2xl font-bold leading-tight"
                  style={brandColor ? { color: brandColor } : undefined}
                  data-testid="text-portfolio-name"
                >
                  {portfolio.displayName}
                </h1>
                <p className="text-sm text-muted-foreground">Project Portfolio</p>
              </div>
            </div>
            {portfolio.introText && (
              <p
                className="text-sm text-muted-foreground max-w-3xl whitespace-pre-line"
                data-testid="text-portfolio-intro"
              >
                {portfolio.introText}
              </p>
            )}
            {portfolio.contactCtaEnabled && portfolio.contactCtaUrl && (
              <Button
                asChild
                style={
                  brandColor
                    ? { backgroundColor: brandColor, borderColor: brandColor }
                    : undefined
                }
                data-testid="button-portfolio-cta"
              >
                <a
                  href={portfolio.contactCtaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {portfolio.contactCtaLabel || "Contact us"}
                  <ExternalLink className="h-4 w-4 ml-1.5" />
                </a>
              </Button>
            )}
          </div>
        </header>
      )}

      <main
        className={
          embed
            ? "max-w-6xl mx-auto px-3 py-4 space-y-4"
            : "max-w-6xl mx-auto px-4 py-8 space-y-6"
        }
      >
        {portfolio.showMap && hasCoords && (
          <div
            className="flex flex-wrap gap-2"
            data-testid="strip-portfolio-locations"
          >
            {showcases
              .filter((s) => s.locationLabel)
              .map((s) => (
                <Badge
                  key={s.slug}
                  variant="secondary"
                  data-testid={`badge-location-${s.slug}`}
                >
                  <MapPin className="h-3 w-3 mr-1" />
                  {s.locationLabel}
                </Badge>
              ))}
          </div>
        )}

        {!embed && allTypes.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="filter-project-types">
            <Button
              variant={typeFilter === null ? "default" : "outline"}
              size="sm"
              onClick={() => setTypeFilter(null)}
              data-testid="button-filter-all"
            >
              All
            </Button>
            {allTypes.map((t) => (
              <Button
                key={t}
                variant={typeFilter === t ? "default" : "outline"}
                size="sm"
                onClick={() => setTypeFilter(t)}
                data-testid={`button-filter-${t}`}
              >
                {t}
              </Button>
            ))}
          </div>
        )}

        {visible.length === 0 ? (
          <Card className="p-12 text-center" data-testid="card-no-showcases">
            <p className="text-sm text-muted-foreground">
              No projects to display yet.
            </p>
          </Card>
        ) : (
          <div
            className={
              embed
                ? "grid grid-cols-2 lg:grid-cols-3 gap-3"
                : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
            }
          >
            {visible.map((sc) => (
              <ShowcaseCard key={sc.slug} slug={slug} sc={sc} embed={embed} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// Resolver for bare /p/:slug — a portfolio slug OR a legacy 32-char project
// share token both live under the /p/ prefix. Try the portfolio endpoint
// first; on 404 fall back to the legacy project share viewer.
export function PublicPRouter({ slug }: { slug: string }) {
  const { data, isLoading, error } = useQuery<PortfolioData>({
    queryKey: ["/api/public/portfolio", slug],
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-4 py-10 space-y-6">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-5 w-2/3" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return <PublicProjectPage token={slug} />;
  }

  return <PublicPortfolioPage slug={slug} />;
}

export default PublicPortfolioPage;
