import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MapPin, Image as ImageIcon, ExternalLink } from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";
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

function PortfolioMap({
  slug,
  showcases,
  embed,
  onNavigate,
}: {
  slug: string;
  showcases: PortfolioShowcase[];
  embed?: boolean;
  onNavigate: (path: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const { data: mapsConfig, error: mapsError } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/public/maps-config"],
    retry: false,
  });

  const withCoords = useMemo(
    () =>
      showcases.filter((s) => s.displayLat != null && s.displayLng != null),
    [showcases],
  );

  const initMap = useCallback(async () => {
    if (!mapsConfig?.apiKey || !mapRef.current || mapInstanceRef.current) return;
    try {
      await loadGoogleMaps(mapsConfig.apiKey);
      const map = new google.maps.Map(mapRef.current, {
        center: { lat: 39.8283, lng: -98.5795 },
        zoom: 4,
        mapId: "fieldview-map",
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });
      infoWindowRef.current = new google.maps.InfoWindow();
      mapInstanceRef.current = map;
      setMapReady(true);
    } catch (err) {
      console.error("Failed to init portfolio map:", err);
    }
  }, [mapsConfig?.apiKey]);

  useEffect(() => {
    initMap();
    return () => {
      markersRef.current.forEach((m) => (m.map = null));
      markersRef.current = [];
      if (infoWindowRef.current) infoWindowRef.current.close();
      mapInstanceRef.current = null;
      setMapReady(false);
    };
  }, [initMap]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapReady) return;
    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];
    if (!withCoords.length) return;
    const bounds = new google.maps.LatLngBounds();
    withCoords.forEach((sc) => {
      const position = { lat: sc.displayLat!, lng: sc.displayLng! };
      bounds.extend(position);
      const pinEl = document.createElement("div");
      pinEl.style.cssText = `width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#F09000;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;`;
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: pinEl,
        title: sc.title,
      });
      marker.addListener("click", () => {
        const iw = infoWindowRef.current;
        if (!iw) return;
        const href = embed
          ? `${window.location.origin}/p/${slug}/${sc.slug}`
          : `/p/${slug}/${sc.slug}`;
        // Build the info window with DOM APIs (textContent / setAttribute)
        // so account-controlled fields can never inject HTML into the
        // public page (XSS-safe — no string-interpolated markup).
        const root = document.createElement("div");
        root.style.cssText = "width:200px;font-family:inherit";
        if (sc.coverUrl) {
          const img = document.createElement("img");
          img.src = sc.coverUrl;
          img.alt = "";
          img.style.cssText =
            "width:100%;height:110px;object-fit:cover;border-radius:4px;margin-bottom:6px";
          root.appendChild(img);
        }
        const titleEl = document.createElement("strong");
        titleEl.style.cssText = "font-size:13px;display:block";
        titleEl.textContent = sc.title;
        root.appendChild(titleEl);
        if (sc.locationLabel) {
          const loc = document.createElement("div");
          loc.style.cssText = "font-size:12px;color:#666;margin-top:2px";
          loc.textContent = sc.locationLabel;
          root.appendChild(loc);
        }
        const link = document.createElement("a");
        link.href = href;
        link.style.cssText =
          "display:inline-block;margin-top:6px;font-size:12px;color:#F09000;font-weight:500;text-decoration:none";
        link.textContent = "View project →";
        if (embed) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        } else {
          link.addEventListener("click", (e) => {
            e.preventDefault();
            onNavigate(`/p/${slug}/${sc.slug}`);
          });
        }
        root.appendChild(link);
        iw.setContent(root);
        iw.open(map, marker);
      });
      markersRef.current.push(marker);
    });
    if (withCoords.length === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(11);
    } else {
      map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    }
  }, [withCoords, mapReady, embed, slug, onNavigate]);

  // Graceful fallback to the location chips strip if the key can't be fetched.
  if (mapsError || (mapsConfig && !mapsConfig.apiKey)) {
    return (
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
    );
  }

  if (!mapsConfig) {
    return <Skeleton className="w-full h-[360px] rounded-md" />;
  }

  return (
    <div
      ref={mapRef}
      className="w-full h-[360px] rounded-md border overflow-hidden"
      data-testid="map-public-portfolio"
    />
  );
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

  const [, navigate] = useLocation();
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
          <PortfolioMap
            slug={slug}
            showcases={showcases}
            embed={embed}
            onNavigate={navigate}
          />
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
