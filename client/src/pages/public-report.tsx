import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FileDown, MapPin, X } from "lucide-react";

interface PublicPhoto {
  id: number;
  url: string;
  caption: string | null;
  description: string | null;
  sortOrder: number;
  displayTimestamp: string | null;
}

interface PublicSection {
  id: number;
  title: string;
  summary: string | null;
  sortOrder: number;
  photos: PublicPhoto[];
}

interface PublicReportData {
  report: {
    id: number;
    title: string;
    description: string | null;
    coverConfig: Record<string, unknown>;
    createdAt: string;
    status: string;
  };
  project: { name: string; address: string | null };
  account: {
    name: string;
    companyLogoUrl: string | null;
    companyLegalName: string | null;
    companyAddress: string | null;
  };
  creator: { firstName: string | null; lastName: string | null } | null;
  coverPhotoUrl: string | null;
  sections: PublicSection[];
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function PublicReportPage({ token }: { token: string }) {
  const [lightboxPhoto, setLightboxPhoto] = useState<PublicPhoto | null>(null);

  const { data, isLoading, error } = useQuery<PublicReportData>({
    queryKey: ["/api/public/reports", token],
  });

  useEffect(() => {
    // SEO: keep public report pages out of search engines.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    if (data?.report.title) {
      const previous = document.title;
      document.title = `${data.report.title} — Field View`;
      return () => {
        document.title = previous;
      };
    }
  }, [data?.report.title]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <h1 className="text-2xl font-bold" data-testid="text-public-report-error">
            Report not found
          </h1>
          <p className="text-muted-foreground">
            This link may have been revoked or never existed.
          </p>
        </div>
      </div>
    );
  }

  const { report, project, account, creator, coverPhotoUrl, sections } = data;
  const creatorName = [creator?.firstName, creator?.lastName].filter(Boolean).join(" ");
  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const totalPhotos = sortedSections.reduce((acc, s) => acc + s.photos.length, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Top action bar — title + Download PDF only. No edit/share affordances for viewers. */}
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">Shared report</p>
            <h1 className="text-base font-semibold truncate" data-testid="text-public-report-title">
              {report.title}
            </h1>
          </div>
          <Button asChild variant="secondary" size="sm" data-testid="button-public-download-pdf">
            <a href={`/api/public/reports/${token}/pdf`}>
              <FileDown className="h-4 w-4 mr-1.5" />
              Download PDF
            </a>
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Cover */}
        <section className="space-y-4" data-testid="section-public-cover">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="space-y-2 min-w-0">
              {account.companyLogoUrl && (
                <img
                  src={account.companyLogoUrl}
                  alt={account.companyLegalName || account.name}
                  className="h-12 w-auto object-contain"
                  data-testid="img-public-account-logo"
                />
              )}
              <p className="text-sm font-medium" data-testid="text-public-account-name">
                {account.companyLegalName || account.name}
              </p>
              {account.companyAddress && (
                <p className="text-xs text-muted-foreground whitespace-pre-line">{account.companyAddress}</p>
              )}
            </div>
            <div className="text-right space-y-1">
              <p className="text-xs text-muted-foreground">Generated</p>
              <p className="text-sm font-medium" data-testid="text-public-report-date">
                {formatDate(report.createdAt)}
              </p>
              {creatorName && (
                <p className="text-xs text-muted-foreground">By {creatorName}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-3xl font-serif" data-testid="text-public-report-heading">
              {report.title}
            </h2>
            <p className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-public-project-name">
              {project.address && <MapPin className="h-3.5 w-3.5" />}
              {project.name}{project.address ? ` · ${project.address}` : ""}
            </p>
            {report.description && (
              <p className="text-sm leading-relaxed pt-2" data-testid="text-public-report-description">
                {report.description}
              </p>
            )}
          </div>

          {coverPhotoUrl && (
            <div className="rounded-md overflow-hidden bg-muted">
              <img
                src={coverPhotoUrl}
                alt="Cover"
                className="w-full max-h-96 object-cover"
                data-testid="img-public-cover-photo"
              />
            </div>
          )}
        </section>

        {/* Sections */}
        {sortedSections.length === 0 ? (
          <Card className="p-12 text-center" data-testid="card-public-empty-report">
            <h3 className="text-lg font-semibold mb-1">This report has no content yet</h3>
            <p className="text-sm text-muted-foreground">
              The author hasn't added any sections. Check back later.
            </p>
          </Card>
        ) : (
          sortedSections.map((section) => (
            <section key={section.id} className="space-y-4" data-testid={`section-public-${section.id}`}>
              <div className="border-b pb-2">
                <h3 className="text-xl font-semibold" data-testid={`text-section-title-${section.id}`}>
                  {section.title}
                </h3>
                {section.summary && (
                  <p className="text-sm text-muted-foreground mt-1 whitespace-pre-line" data-testid={`text-section-summary-${section.id}`}>
                    {section.summary}
                  </p>
                )}
              </div>
              {section.photos.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[...section.photos].sort((a, b) => a.sortOrder - b.sortOrder).map((photo) => (
                    <div key={photo.id} className="space-y-2" data-testid={`photo-public-${photo.id}`}>
                      <button
                        onClick={() => setLightboxPhoto(photo)}
                        className="block w-full aspect-[4/3] rounded-md overflow-hidden bg-muted"
                      >
                        <img
                          src={photo.url}
                          alt={photo.caption || "Photo"}
                          className="w-full h-full object-cover"
                        />
                      </button>
                      {photo.caption && (
                        <p className="text-sm font-medium" data-testid={`text-photo-caption-${photo.id}`}>
                          {photo.caption}
                        </p>
                      )}
                      {photo.description && (
                        <p className="text-xs text-muted-foreground whitespace-pre-line" data-testid={`text-photo-description-${photo.id}`}>
                          {photo.description}
                        </p>
                      )}
                      {photo.displayTimestamp && (
                        <p className="text-xs text-muted-foreground" data-testid={`text-photo-timestamp-${photo.id}`}>
                          {photo.displayTimestamp}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))
        )}
      </main>

      <footer className="border-t mt-8 py-4">
        <div className="max-w-5xl mx-auto px-4 text-center space-y-1">
          <p className="text-xs text-muted-foreground">
            {totalPhotos} photo{totalPhotos !== 1 ? "s" : ""} · {sortedSections.length} section{sortedSections.length !== 1 ? "s" : ""}
          </p>
          <p className="text-xs text-muted-foreground">Shared via Field View</p>
        </div>
      </footer>

      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxPhoto(null)}
          data-testid="lightbox-overlay-public"
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white z-10"
            onClick={() => setLightboxPhoto(null)}
            data-testid="button-close-lightbox-public"
          >
            <X className="h-8 w-8" />
          </button>
          <div className="max-w-5xl max-h-[90vh] w-full px-4" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxPhoto.url}
              alt={lightboxPhoto.caption || "Photo"}
              className="max-w-full max-h-[80vh] mx-auto object-contain rounded-md"
            />
            {(lightboxPhoto.caption || lightboxPhoto.description) && (
              <div className="mt-4 text-center text-white/80 space-y-1">
                {lightboxPhoto.caption && <p className="text-sm font-medium">{lightboxPhoto.caption}</p>}
                {lightboxPhoto.description && (
                  <p className="text-xs whitespace-pre-line">{lightboxPhoto.description}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
