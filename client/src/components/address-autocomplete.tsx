/// <reference types="google.maps" />
import { useEffect, useRef, useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Loader2 } from "lucide-react";

interface AddressResult {
  address: string;
  latitude: number;
  longitude: number;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (result: AddressResult) => void;
  onTextChange: (text: string) => void;
  placeholder?: string;
  "data-testid"?: string;
}

interface Suggestion {
  id: string;
  primary: string;
  secondary: string;
  placePrediction: any;
}

export function AddressAutocomplete({
  value,
  onChange,
  onTextChange,
  placeholder = "Search for an address...",
  "data-testid": testId,
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionTokenRef = useRef<any>(null);
  const fetchSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onTextChangeRef = useRef(onTextChange);
  onChangeRef.current = onChange;
  onTextChangeRef.current = onTextChange;

  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [fetching, setFetching] = useState(false);

  const { data: config, isError: configError } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
    retry: 1,
  });

  useEffect(() => {
    if (!config?.apiKey || scriptLoaded || scriptLoading) return;
    if ((window as any).google?.maps?.places) {
      setScriptLoaded(true);
      return;
    }
    setScriptLoading(true);
    (async () => {
      try {
        const { loadGoogleMaps } = await import("@/lib/google-maps");
        await loadGoogleMaps(config.apiKey);
        setScriptLoaded(true);
      } catch {
        setScriptError(true);
      } finally {
        setScriptLoading(false);
      }
    })();
  }, [config?.apiKey, scriptLoaded, scriptLoading]);

  const ensureSessionToken = useCallback(() => {
    if (!sessionTokenRef.current && (window as any).google?.maps?.places?.AutocompleteSessionToken) {
      sessionTokenRef.current = new (window as any).google.maps.places.AutocompleteSessionToken();
    }
    return sessionTokenRef.current;
  }, []);

  const fetchSuggestions = useCallback(
    async (input: string) => {
      if (!scriptLoaded) return;
      const places: any = (window as any).google?.maps?.places;
      if (!places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions) {
        console.warn("[ADDR] AutocompleteSuggestion API not available");
        return;
      }
      const seq = ++fetchSeqRef.current;
      setFetching(true);
      try {
        const request: any = {
          input,
          sessionToken: ensureSessionToken(),
          includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
        };
        const { suggestions: results } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
        if (seq !== fetchSeqRef.current) return;
        const mapped: Suggestion[] = (results || []).slice(0, 6).map((s: any, idx: number) => {
          const pp = s.placePrediction;
          return {
            id: pp?.placeId || `s-${idx}`,
            primary: pp?.mainText?.text || pp?.text?.text || "",
            secondary: pp?.secondaryText?.text || "",
            placePrediction: pp,
          };
        });
        console.log("[ADDR] fetchAutocompleteSuggestions", { input, count: mapped.length });
        setSuggestions(mapped);
        setHighlight(0);
        setOpen(mapped.length > 0);
      } catch (err) {
        console.error("[ADDR] fetchAutocompleteSuggestions failed", err);
        setSuggestions([]);
        setOpen(false);
      } finally {
        if (seq === fetchSeqRef.current) setFetching(false);
      }
    },
    [scriptLoaded, ensureSessionToken],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    console.log("[ADDR] native input onChange", text);
    onTextChangeRef.current(text);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!text.trim()) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      fetchSuggestions(text);
    }, 200);
  };

  const selectSuggestion = useCallback(async (sug: Suggestion) => {
    console.log("[ADDR] suggestion selected", sug);
    setOpen(false);
    setSuggestions([]);
    try {
      const place = sug.placePrediction.toPlace();
      await place.fetchFields({ fields: ["formattedAddress", "location"] });
      const address = place.formattedAddress || `${sug.primary}${sug.secondary ? ", " + sug.secondary : ""}`;
      const loc = place.location;
      if (!loc) {
        console.warn("[ADDR] selected place has no location");
        return;
      }
      const latitude = typeof loc.lat === "function" ? loc.lat() : loc.lat;
      const longitude = typeof loc.lng === "function" ? loc.lng() : loc.lng;
      console.log("[ADDR] place fetched", { address, latitude, longitude });
      if (inputRef.current) inputRef.current.value = address;
      onChangeRef.current({ address, latitude, longitude });
      sessionTokenRef.current = null;
    } catch (err) {
      console.error("[ADDR] fetchFields failed", err);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) {
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sug = suggestions[highlight];
      if (sug) selectSuggestion(sug);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value) {
      inputRef.current.value = value;
    }
  }, [value]);

  const showFallback = configError || scriptError;

  return (
    <div ref={containerRef} className="relative">
      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none z-10" />
      <Input
        ref={inputRef}
        defaultValue={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder={showFallback ? "Enter address manually" : placeholder}
        className="pl-10"
        data-testid={testId}
        autoComplete="off"
      />
      {(scriptLoading || fetching) && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
      )}
      {open && suggestions.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover text-popover-foreground shadow-md max-h-72 overflow-auto"
          data-testid="dropdown-address-suggestions"
        >
          {suggestions.map((sug, idx) => (
            <button
              key={sug.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(sug);
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 hover-elevate active-elevate-2 ${
                idx === highlight ? "bg-accent text-accent-foreground" : ""
              }`}
              data-testid={`option-address-${idx}`}
            >
              <MapPin className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">{sug.primary}</span>
                {sug.secondary && (
                  <span className="block truncate text-xs text-muted-foreground">{sug.secondary}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {showFallback && (
        <p className="text-xs text-muted-foreground mt-1">
          Address search unavailable. You can type the address manually.
        </p>
      )}
    </div>
  );
}
