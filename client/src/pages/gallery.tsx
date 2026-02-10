import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Calendar, User, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface GalleryPhoto {
  id: number;
  url: string;
  caption: string | null;
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

export default function GalleryPage({ token }: { token: string }) {
  const [lightboxPhoto, setLightboxPhoto] = useState<GalleryPhoto | null>(null);

  const { data: gallery, isLoading, error } = useQuery<GalleryData>({
    queryKey: ["/api/galleries", token],
  });

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
            {gallery.photos.map((photo) => (
              <div
                key={photo.id}
                className="cursor-pointer group"
                onClick={() => setLightboxPhoto(photo)}
                data-testid={`gallery-photo-${photo.id}`}
              >
                <div className="aspect-[4/3] rounded-md overflow-hidden bg-muted">
                  <img
                    src={photo.url}
                    alt={photo.caption || "Photo"}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {gallery.includeDescriptions && photo.caption && (
                    <p className="text-xs font-medium truncate">{photo.caption}</p>
                  )}
                  {gallery.includeMetadata && photo.createdAt && (
                    <p className="text-xs text-muted-foreground">
                      {formatTime(photo.createdAt)}
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

      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxPhoto(null)}
          data-testid="lightbox-overlay"
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white z-10"
            onClick={() => setLightboxPhoto(null)}
            data-testid="button-close-lightbox"
          >
            <X className="h-8 w-8" />
          </button>
          <div className="max-w-5xl max-h-[90vh] w-full px-4" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxPhoto.url}
              alt={lightboxPhoto.caption || "Photo"}
              className="max-w-full max-h-[80vh] mx-auto object-contain rounded-md"
              data-testid="lightbox-image"
            />
            <div className="mt-4 text-center text-white/80 space-y-1">
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
