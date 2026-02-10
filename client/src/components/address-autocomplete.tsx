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
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const onChangeRef = useRef(onChange);
  const onTextChangeRef = useRef(onTextChange);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const [internalValue, setInternalValue] = useState(value);
  const isSelectingRef = useRef(false);

  onChangeRef.current = onChange;
  onTextChangeRef.current = onTextChange;

  useEffect(() => {
    if (!isSelectingRef.current) {
      setInternalValue(value);
    }
  }, [value]);

  const { data: config, isError: configError } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
    retry: 1,
  });

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;

    const autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
      types: ["address"],
      fields: ["formatted_address", "geometry"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (place.formatted_address && place.geometry?.location) {
        isSelectingRef.current = true;
        const address = place.formatted_address;
        setInternalValue(address);
        onChangeRef.current({
          address,
          latitude: place.geometry.location.lat(),
          longitude: place.geometry.location.lng(),
        });
        setTimeout(() => {
          isSelectingRef.current = false;
        }, 100);
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

    const existingScript = document.querySelector('script[src*="maps.googleapis.com"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => {
        setScriptLoaded(true);
        setScriptLoading(false);
      });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${config.apiKey}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      setScriptLoaded(true);
      setScriptLoading(false);
    };
    script.onerror = () => {
      setScriptLoading(false);
      setScriptError(true);
    };
    document.head.appendChild(script);
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
    const text = e.target.value;
    setInternalValue(text);
    onTextChangeRef.current(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
    }
  };

  const showFallback = configError || scriptError;

  return (
    <div className="relative">
      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={internalValue}
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
