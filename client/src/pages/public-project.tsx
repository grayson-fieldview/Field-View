import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { MapPin } from "lucide-react";
import { PhotoLightbox } from "@/components/photo-lightbox";

// NOTE: Public viewer is intentionally minimal — no Tasks, no Completion %,
// no status badge. Client viewers should only see what's relevant to them:
// project name, address, cover, and the photo gallery.
interface PublicProjectData {
  project: {
    id: number;
    name: string;
    address: string | null;
    photoCount: number;
  };
  account: {
    name: string;
    companyLogoUrl: string | null;
  };
  coverPhoto: { url: string } | null;
  photos: Array<{ id: number; url: string; takenAt: string }>;
}

export default function PublicProjectPage({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery<PublicProjectData>({
    queryKey: ["/api/public/projects", token],
  });

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    // Keep public project pages out of search engines.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    if (data?.project.name) {
      const previous = document.title;
      document.title = `${data.project.name} — Field View`;
      return () => {
        document.title = previous;
      };
    }
  }, [data?.project.name]);

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
          <h1 className="text-2xl font-bold" data-testid="text-public-project-error">
            Project not found
          </h1>
          <p className="text-muted-foreground">
            This link may have been revoked or never existed.
          </p>
        </div>
      </div>
    );
  }

  const { project, account, coverPhoto, photos } = data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          {account.companyLogoUrl && (
            <img
              src={account.companyLogoUrl}
              alt={account.name}
              className="h-8 w-auto object-contain shrink-0"
              data-testid="img-public-project-logo"
            />
          )}
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">Project shared with you</p>
            <h1 className="text-base font-semibold truncate" data-testid="text-public-project-account-name">
              {account.name}
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        <section className="space-y-4" data-testid="section-public-project-header">
          <div className="space-y-2">
            <h2 className="text-3xl font-serif" data-testid="text-public-project-name">
              {project.name}
            </h2>
            {project.address && (
              <p className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-public-project-address">
                <MapPin className="h-3.5 w-3.5" />
                {project.address}
              </p>
            )}
          </div>

          {coverPhoto && (
            <div className="rounded-md overflow-hidden bg-muted">
              <img
                src={coverPhoto.url}
                alt={`${project.name} cover`}
                className="w-full max-h-96 object-cover"
                data-testid="img-public-project-cover"
              />
            </div>
          )}
        </section>

        <section className="space-y-4" data-testid="section-public-project-photos">
          <h3 className="text-xl font-semibold" data-testid="text-public-project-photos-heading">
            Photos ({project.photoCount})
          </h3>
          {photos.length === 0 ? (
            <Card className="p-12 text-center" data-testid="card-public-project-no-photos">
              <p className="text-sm text-muted-foreground">No photos yet.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {photos.map((photo, i) => (
                <button
                  key={photo.id}
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="block aspect-[4/3] rounded-md overflow-hidden bg-muted focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid={`button-public-project-photo-${photo.id}`}
                >
                  <img
                    src={photo.url}
                    alt={`Project photo ${i + 1}`}
                    loading="lazy"
                    className="w-full h-full object-cover hover:opacity-90 transition-opacity"
                  />
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={photos.map((p) => ({ id: p.id, url: p.url }))}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
