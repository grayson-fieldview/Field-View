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

export function AddressAutocomplete({
  value,
  onChange,
  onTextChange,
  placeholder = "Search for an address...",
  "data-testid": testId,
}: AddressAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const onChangeRef = useRef(onChange);
  const onTextChangeRef = useRef(onTextChange);
  const isHandlingPlaceSelectionRef = useRef(false);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState(false);

  onChangeRef.current = onChange;
  onTextChangeRef.current = onTextChange;

  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== value) {
      inputRef.current.value = value;
    }
  }, [value]);

  useEffect(() => {
    if (!containerRef.current) return;

    const repositionPac = () => {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const pacContainers = document.querySelectorAll(".pac-container");
      pacContainers.forEach((pac) => {
        const el = pac as HTMLElement;
        el.style.position = "fixed";
        el.style.top = `${rect.bottom + 2}px`;
        el.style.left = `${rect.left}px`;
        el.style.width = `${rect.width}px`;
        el.style.zIndex = "10000";
      });
    };

    const preventBlur = (e: MouseEvent) => {
      e.preventDefault();
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement && node.classList.contains("pac-container")) {
            node.style.position = "fixed";
            node.style.zIndex = "10000";
            node.addEventListener("mousedown", preventBlur);
            repositionPac();

            const styleObs = new MutationObserver(() => {
              repositionPac();
            });
            styleObs.observe(node, { attributes: true, attributeFilter: ["style"] });
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const inputEl = inputRef.current;
    if (inputEl) {
      inputEl.addEventListener("focus", repositionPac);
      inputEl.addEventListener("input", repositionPac);
    }

    window.addEventListener("scroll", repositionPac, true);
    window.addEventListener("resize", repositionPac);

    return () => {
      observer.disconnect();
      if (inputEl) {
        inputEl.removeEventListener("focus", repositionPac);
        inputEl.removeEventListener("input", repositionPac);
      }
      window.removeEventListener("scroll", repositionPac, true);
      window.removeEventListener("resize", repositionPac);
    };
  }, []);

  const { data: config, isError: configError } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
    retry: 1,
  });

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;

    const input = inputRef.current;

    const autocomplete = new google.maps.places.Autocomplete(input, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      console.log("[ADDR] place_changed fires", { place });
      if (place.formatted_address && place.geometry?.location) {
        const address = place.formatted_address;
        const latitude = place.geometry.location.lat();
        const longitude = place.geometry.location.lng();

        isHandlingPlaceSelectionRef.current = true;
        input.value = address;
        console.log("[ADDR] onChange called from place_changed", { address, latitude, longitude });
        onChangeRef.current({ address, latitude, longitude });

        setTimeout(() => {
          isHandlingPlaceSelectionRef.current = false;
        }, 0);
      }
    });

    autocompleteRef.current = autocomplete;
  }, []);

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
        setScriptLoading(false);
      } catch {
        setScriptLoading(false);
        setScriptError(true);
      }
    })();
  }, [config?.apiKey, scriptLoaded, scriptLoading]);

  useEffect(() => {
    if (scriptLoaded) {
      initAutocomplete();
    }
  }, [scriptLoaded, initAutocomplete]);

  useEffect(() => {
    return () => {
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current);
        autocompleteRef.current = null;
      }
    };
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isHandlingPlaceSelectionRef.current) {
      console.log("[ADDR] native input onChange fires \u2192 SUPPRESSED by guard flag", e.target.value);
      return;
    }
    console.log("[ADDR] native input onChange fires", e.target.value);
    onTextChangeRef.current(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
  };

  const showFallback = configError || scriptError;

  return (
    <div ref={containerRef} className="relative">
      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        ref={inputRef}
        defaultValue={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={showFallback ? "Enter address manually" : placeholder}
        className="pl-10"
        data-testid={testId}
      />
      {scriptLoading && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
      )}
      {showFallback && (
        <p className="text-xs text-muted-foreground mt-1">Address search unavailable. You can type the address manually.</p>
      )}
    </div>
  );
}
