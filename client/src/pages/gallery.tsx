import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Calendar, User, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PhotoOverlayStrip } from "@/components/photo-overlay-strip";

interface GalleryPhoto {
  id: number;
  url: string;
  thumbUrl: string | null;
  caption: string | null;
  // Capture time for the timestamp overlay (present only when the
  // project's overlay setting is on).
  takenAt: string | null;
  createdAt: string | null;
  uploadedBy: { firstName: string; lastName: string } | null;
  latitude: number | null;
  longitude: number | null;
}

interface GalleryData {
  token: string;
  projectName: string;
  projectAddress: string;
  includeMetadata: boolean;
  includeDescriptions: boolean;
  // Resolved project timestamp/address overlay flag. CSS text only — the
  // overlay does not survive right-click-save (pixel compositing is a
  // later phase).
  overlayEnabled: boolean;
  createdAt: string;
  photos: GalleryPhoto[];
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Aug 18, 2026, 2:45 PM" — same shape the app uses for photo timestamps. */
function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default function GalleryPage({ token }: { token: string }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { data: gallery, isLoading, error } = useQuery<GalleryData>({
    queryKey: ["/api/galleries", token],
  });

  const photoCount = gallery?.photos.length ?? 0;

  const goPrev = useCallback(() => {
    setLightboxIndex((i) => (i === null || photoCount === 0 ? i : (i - 1 + photoCount) % photoCount));
  }, [photoCount]);
  const goNext = useCallback(() => {
    setLightboxIndex((i) => (i === null || photoCount === 0 ? i : (i + 1) % photoCount));
  }, [photoCount]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIndex(null);
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, goPrev, goNext]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-5 w-48 mb-8" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-md" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !gallery) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-bold" data-testid="text-gallery-error">Gallery not found</h1>
          <p className="text-muted-foreground">This gallery link may have expired or been removed.</p>
        </div>
      </div>
    );
  }

  const lightboxPhoto = lightboxIndex !== null ? gallery.photos[lightboxIndex] : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <h1 className="text-2xl font-bold" data-testid="text-gallery-project-name">{gallery.projectName}</h1>
          {gallery.projectAddress && (
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1" data-testid="text-gallery-address">
              <MapPin className="h-3.5 w-3.5" />
              {gallery.projectAddress}
            </p>
          )}
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-gallery-photo-count">
            {gallery.photos.length} photo{gallery.photos.length !== 1 ? "s" : ""}
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {gallery.photos.length === 0 ? (
          <p className="text-center text-muted-foreground py-12">No photos in this gallery.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {gallery.photos.map((photo, index) => (
              <div
                key={photo.id}
                className="cursor-pointer group"
                onClick={() => setLightboxIndex(index)}
                data-testid={`gallery-photo-${photo.id}`}
              >
                <div className="relative aspect-[4/3] rounded-md overflow-hidden bg-muted">
                  <img
                    src={photo.thumbUrl ?? photo.url}
                    alt={photo.caption || "Photo"}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  {gallery.overlayEnabled && (
                    <PhotoOverlayStrip
                      takenAt={photo.takenAt}
                      createdAt={null}
                      address={gallery.projectAddress || null}
                    />
                  )}
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {gallery.includeDescriptions && photo.caption && (
                    <p className="text-xs font-medium truncate">{photo.caption}</p>
                  )}
                  {gallery.includeMetadata && photo.createdAt && (
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(photo.createdAt)}
                      {photo.uploadedBy && (
                        <span> &middot; {photo.uploadedBy.firstName} {photo.uploadedBy.lastName}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {lightboxPhoto && lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center"
          onClick={() => setLightboxIndex(null)}
          data-testid="lightbox-overlay"
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white z-10"
            onClick={() => setLightboxIndex(null)}
            data-testid="button-close-lightbox"
          >
            <X className="h-8 w-8" />
          </button>

          {gallery.photos.length > 1 && (
            <>
              <button
                className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white"
                onClick={(e) => { e.stopPropagation(); goPrev(); }}
                aria-label="Previous photo"
                data-testid="button-lightbox-prev"
              >
                <ChevronLeft className="h-7 w-7" />
              </button>
              <button
                className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white"
                onClick={(e) => { e.stopPropagation(); goNext(); }}
                aria-label="Next photo"
                data-testid="button-lightbox-next"
              >
                <ChevronRight className="h-7 w-7" />
              </button>
            </>
          )}

          <div className="max-w-5xl w-full px-4 min-h-0" onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              {/* inline-block shrink-wraps the img so the overlay corner
                  aligns to the image itself, not the letterboxed box. */}
              <div className="relative inline-block max-w-full">
                <img
                  src={lightboxPhoto.url}
                  alt={lightboxPhoto.caption || "Photo"}
                  className="max-w-full max-h-[70vh] object-contain rounded-md"
                  data-testid="lightbox-image"
                />
                {gallery.overlayEnabled && (
                  <PhotoOverlayStrip
                    takenAt={lightboxPhoto.takenAt}
                    createdAt={null}
                    address={gallery.projectAddress || null}
                  />
                )}
              </div>
            </div>
            <div className="mt-3 text-center text-white/80 space-y-1">
              {gallery.includeDescriptions && lightboxPhoto.caption && (
                <p className="text-sm font-medium">{lightboxPhoto.caption}</p>
              )}
              {gallery.includeMetadata && (
                <div className="flex flex-wrap items-center justify-center gap-4 text-xs">
                  {lightboxPhoto.createdAt && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(lightboxPhoto.createdAt)} at {formatTime(lightboxPhoto.createdAt)}
                    </span>
                  )}
                  {lightboxPhoto.uploadedBy && (
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {lightboxPhoto.uploadedBy.firstName} {lightboxPhoto.uploadedBy.lastName}
                    </span>
                  )}
                  {lightboxPhoto.latitude && lightboxPhoto.longitude && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {lightboxPhoto.latitude.toFixed(4)}, {lightboxPhoto.longitude.toFixed(4)}
                    </span>
                  )}
                </div>
              )}
            </div>

            {gallery.photos.length > 1 && (
              <div
                className="mt-3 flex gap-1.5 overflow-x-auto pb-1 justify-start sm:justify-center"
                data-testid="lightbox-thumbnails"
              >
                {gallery.photos.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setLightboxIndex(i)}
                    className={`h-14 w-14 shrink-0 overflow-hidden rounded-sm border-2 ${
                      i === lightboxIndex ? "border-white" : "border-transparent opacity-60 hover:opacity-100"
                    }`}
                    aria-label={`Photo ${i + 1}`}
                    data-testid={`lightbox-thumb-${p.id}`}
                  >
                    <img src={p.thumbUrl ?? p.url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="border-t py-4">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p className="text-xs text-muted-foreground">
            Shared via Field View
          </p>
        </div>
      </footer>
    </div>
  );
}
