import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin, Calendar } from "lucide-react";
import { useLocation } from "wouter";
import type { Project } from "@shared/schema";
import { loadGoogleMaps } from "@/lib/google-maps";

const statusLabels: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  on_hold: "On Hold",
  archived: "Archived",
};

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  completed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  on_hold: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
};

export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const overlayRef = useRef<google.maps.OverlayView | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [cardPosition, setCardPosition] = useState<{ x: number; y: number } | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [, navigate] = useLocation();

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: mapsConfig } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
  });

  const projectsWithLocation = (projects || []).filter(
    (p) => p.latitude != null && p.longitude != null
  );

  const initMap = useCallback(async () => {
    if (!mapsConfig?.apiKey || !mapRef.current || mapInstanceRef.current) return;

    try {
      await loadGoogleMaps(mapsConfig.apiKey);

      const map = new google.maps.Map(mapRef.current, {
        center: { lat: 39.8283, lng: -98.5795 },
        zoom: 4,
        mapId: "fieldview-map",
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: true,
        streetViewControl: false,
        fullscreenControl: true,
      });

      map.addListener("click", () => {
        setSelectedProject(null);
        setCardPosition(null);
      });

      const overlay = new google.maps.OverlayView();
      overlay.draw = function () {};
      overlay.setMap(map);
      overlayRef.current = overlay;

      mapInstanceRef.current = map;
      setMapReady(true);
    } catch (err) {
      console.error("Failed to initialize Google Maps:", err);
    }
  }, [mapsConfig?.apiKey]);

  useEffect(() => {
    initMap();
    return () => {
      markersRef.current.forEach((m) => (m.map = null));
      markersRef.current = [];
      if (overlayRef.current) {
        overlayRef.current.setMap(null);
        overlayRef.current = null;
      }
      mapInstanceRef.current = null;
      setMapReady(false);
    };
  }, [initMap]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapReady) return;

    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];

    if (!projectsWithLocation.length) return;

    const bounds = new google.maps.LatLngBounds();

    projectsWithLocation.forEach((project) => {
      const lat = project.latitude!;
      const lng = project.longitude!;
      const position = { lat, lng };
      bounds.extend(position);

      const color = project.color || "#F09000";

      const pinEl = document.createElement("div");
      pinEl.style.cssText = `
        width: 36px; height: 36px; border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg); background: ${color};
        border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: transform 0.15s;
      `;
      const label = document.createElement("span");
      label.style.cssText = `transform: rotate(45deg); color: white; font-size: 14px; font-weight: bold;`;
      label.textContent = project.name[0];
      pinEl.appendChild(label);

      pinEl.addEventListener("mouseenter", () => {
        pinEl.style.transform = "rotate(-45deg) scale(1.15)";
      });
      pinEl.addEventListener("mouseleave", () => {
        pinEl.style.transform = "rotate(-45deg) scale(1)";
      });

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: pinEl,
        title: project.name,
      });

      marker.addListener("click", () => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        const projection = overlay.getProjection();
        if (projection) {
          const point = projection.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
          if (point) {
            setCardPosition({ x: point.x, y: point.y });
          }
        }
        setSelectedProject(project);
      });
      markersRef.current.push(marker);
    });

    if (projectsWithLocation.length === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(12);
    } else {
      map.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
    }
  }, [projectsWithLocation, mapReady]);

  return (
    <div className="relative h-full flex flex-col">
      <div className="p-4 sm:p-6 pb-0">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-map-title">Map</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View all project locations ({projectsWithLocation.length} with coordinates)
        </p>
      </div>

      <div className="flex-1 p-4 sm:p-6 pt-4 relative">
        {isLoading || !mapsConfig ? (
          <Skeleton className="w-full h-full rounded-md" />
        ) : (
          <div
            ref={mapRef}
            className="w-full h-full rounded-md border overflow-hidden min-h-[400px]"
            data-testid="map-container"
          />
        )}

        {selectedProject && cardPosition && (
          <Card
            className="absolute sm:w-80 w-72 p-4 z-[1000] cursor-pointer hover-elevate shadow-lg"
            style={{
              left: `${cardPosition.x}px`,
              top: `${cardPosition.y - 16}px`,
              transform: "translate(-50%, -100%)",
            }}
            onClick={() => navigate(`/projects/${selectedProject.id}`)}
            data-testid="card-map-preview"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: selectedProject.color || "#F09000" }}
                  />
                  <h3 className="font-semibold truncate text-sm">{selectedProject.name}</h3>
                </div>
                <Badge variant="secondary" className={`shrink-0 text-xs no-default-hover-elevate no-default-active-elevate ${statusColors[selectedProject.status]}`}>
                  {statusLabels[selectedProject.status]}
                </Badge>
              </div>
              {selectedProject.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{selectedProject.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {selectedProject.address && (
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    <span className="truncate max-w-[180px]">{selectedProject.address}</span>
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {new Date(selectedProject.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="text-xs text-primary font-medium">Click to view project details</p>
            </div>
          </Card>
        )}

        {!isLoading && projectsWithLocation.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Card className="p-8 pointer-events-auto">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <MapPin className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No locations to display</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Add an address when creating projects to see them on the map.
                </p>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
