import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, MapPin, ExternalLink, Image as ImageIcon } from "lucide-react";
import { BeforeAfterSlider } from "@/components/before-after-slider";
import { PhotoLightbox } from "@/components/photo-lightbox";

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

interface ShowcasePhoto {
  id: number;
  url: string;
  caption: string | null;
  pairGroupId: string | null;
  pairRole: "before" | "after" | null;
  sortOrder: number;
}

interface ShowcaseDetail {
  slug: string;
  title: string;
  description: string | null;
  projectTypes: string[] | null;
  productsUsed: string[] | null;
  locationLabel: string | null;
  displayLat: number | null;
  displayLng: number | null;
  publishedAt: string | null;
  coverUrl: string;
  photos: ShowcasePhoto[];
}

interface MoreShowcase {
  slug: string;
  title: string;
  locationLabel: string | null;
  coverUrl: string;
}

interface ShowcaseData {
  portfolio: PortfolioMeta;
  showcase: ShowcaseDetail;
  moreShowcases: MoreShowcase[];
}

function recordShowcaseView(slug: string, showcaseSlug: string) {
  const key = `sv:${slug}:${showcaseSlug}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch {
    // ignore
  }
  fetch(`/api/public/portfolio/${slug}/view`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      showcaseSlug,
      referrer: document.referrer || null,
    }),
  }).catch(() => {});
}

type GalleryItem =
  | { kind: "single"; photo: ShowcasePhoto; lightboxIndex: number }
  | { kind: "pair"; before: ShowcasePhoto; after: ShowcasePhoto; caption: string | null };

export function PublicShowcasePage({
  slug,
  showcaseSlug,
}: {
  slug: string;
  showcaseSlug: string;
}) {
  const { data, isLoading, error } = useQuery<ShowcaseData>({
    queryKey: ["/api/public/portfolio", slug, showcaseSlug],
    retry: false,
  });

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    if (data) recordShowcaseView(slug, showcaseSlug);
  }, [data, slug, showcaseSlug]);

  useEffect(() => {
    if (data?.showcase.title && data?.portfolio.displayName) {
      const previous = document.title;
      document.title = `${data.showcase.title} — ${data.portfolio.displayName}`;
      return () => {
        document.title = previous;
      };
    }
  }, [data?.showcase.title, data?.portfolio.displayName]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 py-10 space-y-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <h1 className="text-2xl font-bold" data-testid="text-showcase-error">
            Project not found
          </h1>
          <p className="text-muted-foreground">
            This project may be unavailable or the link is incorrect.
          </p>
        </div>
      </div>
    );
  }

  const { portfolio, showcase, moreShowcases } = data;
  const brandColor = portfolio.brandColor || undefined;

  const sorted = [...showcase.photos].sort((a, b) => a.sortOrder - b.sortOrder);

  // Standalone photos feed the lightbox array (in display order). Paired
  // photos render as before/after sliders and are excluded from the lightbox.
  const standalone = sorted.filter((p) => !p.pairGroupId);
  const standaloneIndex = new Map<number, number>();
  standalone.forEach((p, i) => standaloneIndex.set(p.id, i));

  const items: GalleryItem[] = [];
  const seenPairs = new Set<string>();
  for (const p of sorted) {
    if (p.pairGroupId) {
      if (seenPairs.has(p.pairGroupId)) continue;
      seenPairs.add(p.pairGroupId);
      const group = sorted.filter((q) => q.pairGroupId === p.pairGroupId);
      const before = group.find((q) => q.pairRole === "before");
      const after = group.find((q) => q.pairRole === "after");
      if (before && after) {
        items.push({ kind: "pair", before, after, caption: before.caption || after.caption });
      } else {
        // Malformed pair — fall back to singles.
        for (const q of group) {
          const idx = standaloneIndex.get(q.id);
          if (idx != null) items.push({ kind: "single", photo: q, lightboxIndex: idx });
        }
      }
    } else {
      items.push({ kind: "single", photo: p, lightboxIndex: standaloneIndex.get(p.id) ?? 0 });
    }
  }

  const publishedDate = showcase.publishedAt
    ? new Date(showcase.publishedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          {portfolio.logoUrl && (
            <img
              src={portfolio.logoUrl}
              alt={portfolio.displayName}
              className="h-8 w-auto object-contain shrink-0"
              data-testid="img-showcase-logo"
            />
          )}
          <Link
            href={`/p/${slug}`}
            className="text-sm font-medium hover:underline flex items-center gap-1"
            style={brandColor ? { color: brandColor } : undefined}
            data-testid="link-back-portfolio"
          >
            <ChevronLeft className="h-4 w-4" />
            {portfolio.displayName}
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <section className="space-y-3" data-testid="section-showcase-header">
          <h1 className="text-3xl font-bold" data-testid="text-showcase-title">
            {showcase.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {showcase.locationLabel && (
              <span className="flex items-center gap-1" data-testid="text-showcase-location">
                <MapPin className="h-3.5 w-3.5" />
                {showcase.locationLabel}
              </span>
            )}
            {publishedDate && (
              <span data-testid="text-showcase-date">{publishedDate}</span>
            )}
          </div>
          {showcase.projectTypes && showcase.projectTypes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {showcase.projectTypes.map((t) => (
                <Badge key={t} variant="secondary" data-testid={`badge-type-${t}`}>
                  {t}
                </Badge>
              ))}
            </div>
          )}
          {showcase.description && (
            <p
              className="text-sm text-foreground/90 max-w-3xl whitespace-pre-line pt-2"
              data-testid="text-showcase-description"
            >
              {showcase.description}
            </p>
          )}
          {showcase.productsUsed && showcase.productsUsed.length > 0 && (
            <div className="pt-2 space-y-1">
              <p className="text-sm font-medium">Products used</p>
              <ul className="flex flex-wrap gap-2" data-testid="list-products-used">
                {showcase.productsUsed.map((prod) => (
                  <li key={prod}>
                    <Badge variant="outline" data-testid={`badge-product-${prod}`}>
                      {prod}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-4" data-testid="section-showcase-gallery">
          {items.length === 0 ? (
            <Card className="p-12 text-center" data-testid="card-no-photos">
              <p className="text-sm text-muted-foreground">No photos yet.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {items.map((item, i) =>
                item.kind === "pair" ? (
                  <div
                    key={`pair-${item.before.id}`}
                    className="sm:col-span-2 space-y-2"
                    data-testid={`gallery-pair-${item.before.id}`}
                  >
                    <BeforeAfterSlider
                      beforeUrl={item.before.url}
                      afterUrl={item.after.url}
                      beforeLabel="Before"
                      afterLabel="After"
                    />
                    {item.caption && (
                      <p className="text-sm text-muted-foreground">{item.caption}</p>
                    )}
                  </div>
                ) : (
                  <div key={`single-${item.photo.id}`} className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setLightboxIndex(item.lightboxIndex)}
                      className="block w-full aspect-[4/3] rounded-md overflow-hidden bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      data-testid={`button-photo-${item.photo.id}`}
                    >
                      {item.photo.url ? (
                        <img
                          src={item.photo.url}
                          alt={item.photo.caption || `Photo ${i + 1}`}
                          loading="lazy"
                          className="w-full h-full object-cover hover:opacity-90 transition-opacity"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <ImageIcon className="h-8 w-8" />
                        </div>
                      )}
                    </button>
                    {item.photo.caption && (
                      <p className="text-sm text-muted-foreground">
                        {item.photo.caption}
                      </p>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </section>

        {moreShowcases.length > 0 && (
          <section className="space-y-4" data-testid="section-more-showcases">
            <h2 className="text-xl font-semibold">More projects</h2>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {moreShowcases.map((m) => (
                <Link
                  key={m.slug}
                  href={`/p/${slug}/${m.slug}`}
                  className="block w-48 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md"
                  data-testid={`link-more-${m.slug}`}
                >
                  <Card className="overflow-hidden hover-elevate">
                    <div className="aspect-[4/3] bg-muted overflow-hidden">
                      {m.coverUrl ? (
                        <img
                          src={m.coverUrl}
                          alt={m.title}
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                          <ImageIcon className="h-6 w-6" />
                        </div>
                      )}
                    </div>
                    <div className="p-3 space-y-1">
                      <p className="text-sm font-medium leading-tight truncate">
                        {m.title}
                      </p>
                      {m.locationLabel && (
                        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {m.locationLabel}
                        </p>
                      )}
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        )}

        {portfolio.contactCtaEnabled && portfolio.contactCtaUrl && (
          <section className="pt-4" data-testid="section-showcase-cta">
            <Button
              asChild
              style={
                brandColor
                  ? { backgroundColor: brandColor, borderColor: brandColor }
                  : undefined
              }
              data-testid="button-showcase-cta"
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
          </section>
        )}
      </main>

      {lightboxIndex !== null && standalone.length > 0 && (
        <PhotoLightbox
          photos={standalone.map((p) => ({ id: p.id, url: p.url }))}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

export default PublicShowcasePage;
