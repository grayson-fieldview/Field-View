import { useEffect, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PhotoLightboxProps {
  photos: Array<{ id: number; url: string }>;
  startIndex: number;
  onClose: () => void;
}

export function PhotoLightbox({ photos, startIndex, onClose }: PhotoLightboxProps) {
  const [index, setIndex] = useState(startIndex);
  const touchStartX = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const total = photos.length;

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => (i - 1 + total) % total);
      } else if (e.key === "ArrowRight") {
        setIndex((i) => (i + 1) % total);
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [total, onClose]);

  if (total === 0) return null;
  const photo = photos[index];

  const goPrev = () => setIndex((i) => (i - 1 + total) % total);
  const goNext = () => setIndex((i) => (i + 1) % total);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) > 40) {
      if (dx > 0) goPrev();
      else goNext();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo viewer, ${index + 1} of ${total}`}
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      data-testid="overlay-photo-lightbox"
    >
      <Button
        ref={closeButtonRef}
        variant="ghost"
        size="icon"
        aria-label="Close photo viewer"
        className="absolute top-3 right-3 text-white hover:bg-white/10"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        data-testid="button-lightbox-close"
      >
        <X className="h-5 w-5" />
      </Button>

      <div
        className="absolute top-3 left-1/2 -translate-x-1/2 text-white text-sm bg-black/40 rounded-full px-3 py-1"
        data-testid="text-lightbox-index"
      >
        {index + 1} of {total}
      </div>

      {total > 1 && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous photo"
          className="absolute left-3 md:left-6 text-white hover:bg-white/10 h-12 w-12"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          data-testid="button-lightbox-prev"
        >
          <ChevronLeft className="h-7 w-7" />
        </Button>
      )}

      <img
        src={photo.url}
        alt={`Photo ${index + 1} of ${total}`}
        className="max-h-[90vh] max-w-[92vw] object-contain select-none"
        onClick={(e) => e.stopPropagation()}
        data-testid={`img-lightbox-${photo.id}`}
      />

      {total > 1 && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next photo"
          className="absolute right-3 md:right-6 text-white hover:bg-white/10 h-12 w-12"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          data-testid="button-lightbox-next"
        >
          <ChevronRight className="h-7 w-7" />
        </Button>
      )}
    </div>
  );
}
