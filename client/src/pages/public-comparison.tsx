import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { BeforeAfterSlider } from "@/components/before-after-slider";

interface PublicComparisonData {
  beforeUrl: string;
  afterUrl: string;
  beforeLabel: string;
  afterLabel: string;
  projectName: string | null;
  account: { name: string; companyLogoUrl: string | null } | null;
}

const BRAND_ORANGE = "#f09004";

export default function PublicComparisonPage({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery<PublicComparisonData>({
    queryKey: ["/api/public/comparisons", token],
  });

  // Mirror the /p/:token social-preview mechanism: client-side meta injection.
  // Keep the page out of search engines.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Client-side <title> + Open Graph tags. NOTE: like /p/:token, these are
  // injected client-side, so non-JS social scrapers will not see them — the
  // cover.jpg endpoint exists as a stable image URL ready for future
  // server-side OG injection.
  useEffect(() => {
    const title = data?.projectName
      ? `${data.projectName} — Before & After — Field View`
      : "Before & After — Field View";
    const previousTitle = document.title;
    document.title = title;

    const ogImageUrl = `${window.location.origin}/api/public/comparisons/${token}/cover.jpg`;
    const tags: HTMLMetaElement[] = [];
    const addOg = (property: string, content: string) => {
      const m = document.createElement("meta");
      m.setAttribute("property", property);
      m.content = content;
      document.head.appendChild(m);
      tags.push(m);
    };
    addOg("og:title", title);
    addOg("og:image", ogImageUrl);

    return () => {
      document.title = previousTitle;
      tags.forEach((t) => document.head.removeChild(t));
    };
  }, [data?.projectName, token]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-4">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="aspect-[4/3] w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <h1 className="text-2xl font-bold" data-testid="text-public-comparison-error">
            Comparison unavailable
          </h1>
          <p className="text-muted-foreground">
            This comparison link is no longer available.
          </p>
        </div>
      </div>
    );
  }

  const { beforeUrl, afterUrl, beforeLabel, afterLabel, projectName, account } = data;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          {account?.companyLogoUrl && (
            <img
              src={account.companyLogoUrl}
              alt={account.name}
              className="h-8 w-auto object-contain shrink-0"
              data-testid="img-public-comparison-logo"
            />
          )}
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">Before / After comparison</p>
            <h1 className="text-base font-semibold truncate" data-testid="text-public-comparison-account-name">
              {account?.name ?? "Field View"}
            </h1>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-8 space-y-6">
        {projectName && (
          <h2 className="text-2xl font-serif" data-testid="text-public-comparison-project-name">
            {projectName}
          </h2>
        )}
        <BeforeAfterSlider
          beforeUrl={beforeUrl}
          afterUrl={afterUrl}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
        />
        <p className="text-xs text-muted-foreground text-center">
          Drag the slider to compare the before and after photos.
        </p>
      </main>

      <footer className="border-t py-4">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <a
            href="https://field-view.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium hover:underline"
            style={{ color: BRAND_ORANGE }}
            data-testid="link-made-with-field-view"
          >
            Made with Field View
          </a>
        </div>
      </footer>
    </div>
  );
}
