export type GeocodedCoordinates = {
  latitude: number;
  longitude: number;
};

let hasLoggedMissingGoogleMapsKey = false;

function truncatedAddress(address: string): string {
  return address.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function forwardGeocode(address: string): Promise<GeocodedCoordinates | null> {
  const normalizedAddress = address.trim();
  if (!normalizedAddress) return null;

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    if (!hasLoggedMissingGoogleMapsKey) {
      hasLoggedMissingGoogleMapsKey = true;
      console.warn("[geocode] forward geocoding is not configured: GOOGLE_MAPS_API_KEY is missing");
    }
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(normalizedAddress)}&key=${key}`,
      { signal: controller.signal },
    );
    const data: any = await response.json();
    const location = data?.results?.[0]?.geometry?.location;
    const latitude = location?.lat;
    const longitude = location?.lng;

    if (
      data?.status !== "OK" ||
      !Array.isArray(data?.results) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      console.warn("[geocode] forward failed:", {
        status: data?.status ?? "malformed_response",
        address: truncatedAddress(normalizedAddress),
      });
      return null;
    }

    return { latitude, longitude };
  } catch (error) {
    console.warn("[geocode] forward failed:", {
      status: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed",
      address: truncatedAddress(normalizedAddress),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
