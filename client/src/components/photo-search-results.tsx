import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchX } from "lucide-react";
import type { Media } from "@shared/schema";

export type MediaSearchResult = Media & {
  project?: {
    name: string;
    color: string | null;
    address?: string | null;
    photoOverlayEnabled?: boolean | null;
  };
  uploadedBy?: { firstName: string | null; lastName: string | null };
};

/** Debounce a changing value (~300ms) so search doesn't fire per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Server-side media search (GET /api/media/search). Only enabled for a
 * non-empty trimmed query — callers fall back to the normal listing when
 * the search box is empty. Results come back rank-ordered by the server.
 */
export function useMediaSearch(q: string, projectId?: number) {
  const trimmed = q.trim();
  const params = new URLSearchParams({ q: trimmed });
  if (projectId != null) params.set("projectId", String(projectId));
  const url = `/api/media/search?${params.toString()}`;
  return useQuery<MediaSearchResult[]>({
    // Single-element key: the default queryFn fetches queryKey.join("/").
    queryKey: [url],
    enabled: trimmed.length > 0,
  });
}

// The server stores a literal "UNCLEAR" sentinel when the AI couldn't
// caption a photo — it is NOT stripped server-side, so skip it here.
export function displayAiCaption(m: MediaSearchResult): string | null {
  const c = (m.aiCaption || "").trim();
  if (!c || c.toUpperCase() === "UNCLEAR") return null;
  return c;
}

export function PhotoSearchResults({
  results,
  isLoading,
  onSelect,
  showProject = false,
}: {
  results: MediaSearchResult[] | undefined;
  isLoading: boolean;
  onSelect: (item: MediaSearchResult) => void;
  showProject?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="aspect-square rounded-md" />
        ))}
      </div>
    );
  }
  if (!results || results.length === 0) {
    return (
      <Card className="p-12">
        <div className="text-center space-y-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
            <SearchX className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold" data-testid="text-no-search-results">
            No photos match your search
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Try different words, a quoted phrase, or fewer terms.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {results.map((item) => {
        const aiCaption = displayAiCaption(item);
        return (
          <Card
            key={item.id}
            className="overflow-visible cursor-pointer hover-elevate group"
            onClick={() => onSelect(item)}
            data-testid={`card-search-result-${item.id}`}
          >
            <div className="aspect-square overflow-hidden rounded-t-md">
              <img
                src={item.url}
                alt={item.caption || item.originalName}
                className="w-full h-full object-cover md:transition-transform md:duration-300 md:group-hover:scale-105"
              />
            </div>
            <div className="p-2 space-y-0.5">
              {showProject && item.project && (
                <p className="text-xs font-medium truncate" data-testid={`text-search-project-${item.id}`}>
                  {item.project.name}
                </p>
              )}
              {aiCaption && (
                <p
                  className="text-[11px] text-muted-foreground line-clamp-2"
                  data-testid={`text-search-ai-caption-${item.id}`}
                >
                  {aiCaption}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                {new Date(item.createdAt).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })}
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
