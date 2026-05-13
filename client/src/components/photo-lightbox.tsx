import { useEffect, useRef, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

interface PhotoLightboxProps {
  photos: Array<{ id: number; url: string }>;
  startIndex: number;
  onClose: () => void;
}

// Plain native buttons (NOT shadcn <Button>) for the controls — the shadcn
// Button's internal flex/inline-flex layout was conflicting with absolute
// positioning in some viewports and causing the close × to render mid-left
// off-screen. Native buttons + explicit fixed positioning are bulletproof.
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
      {/* Close: top-right, 44x44 tap target, safe-area aware */}
      <button
        ref={closeButtonRef}
        type="button"
        aria-label="Close photo viewer"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="fixed z-[60] flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 16px)",
          right: "calc(env(safe-area-inset-right, 0px) + 16px)",
        }}
        data-testid="button-lightbox-close"
      >
        <X className="h-6 w-6" aria-hidden="true" />
      </button>

      {/* Counter pill: top-center, also safe-area aware */}
      <div
        className="fixed left-1/2 z-[60] -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-sm text-white"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 18px)" }}
        data-testid="text-lightbox-index"
      >
        {index + 1} of {total}
      </div>

      {total > 1 && (
        <button
          type="button"
          aria-label="Previous photo"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          className="fixed top-1/2 z-[60] flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          style={{ left: "calc(env(safe-area-inset-left, 0px) + 16px)" }}
          data-testid="button-lightbox-prev"
        >
          <ChevronLeft className="h-7 w-7" aria-hidden="true" />
        </button>
      )}

      <img
        src={photo.url}
        alt={`Photo ${index + 1} of ${total}`}
        className="max-h-[90vh] max-w-[92vw] object-contain select-none"
        onClick={(e) => e.stopPropagation()}
        data-testid={`img-lightbox-${photo.id}`}
      />

      {total > 1 && (
        <button
          type="button"
          aria-label="Next photo"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          className="fixed top-1/2 z-[60] flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          style={{ right: "calc(env(safe-area-inset-right, 0px) + 16px)" }}
          data-testid="button-lightbox-next"
        >
          <ChevronRight className="h-7 w-7" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
