import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin } from "lucide-react";
import { useLocation } from "wouter";
import type { Project } from "@shared/schema";
import { loadGoogleMaps } from "@/lib/google-maps";

const statusLabels: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  on_hold: "On Hold",
  archived: "Archived",
};


export default function MapPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
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

      if (infoWindowRef.current) infoWindowRef.current.close();
      const infoWindow = new google.maps.InfoWindow();
      infoWindowRef.current = infoWindow;

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
      if (infoWindowRef.current) infoWindowRef.current.close();
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
        const infoWindow = infoWindowRef.current;
        if (!infoWindow) return;
        const statusLabel = statusLabels[project.status] || project.status;
        infoWindow.setContent(`
          <div style="padding:8px;min-width:200px;max-width:300px;cursor:pointer" id="iw-project-${project.id}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <div style="width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0"></div>
              <strong style="font-size:14px">${project.name}</strong>
            </div>
            <div style="font-size:12px;color:#666;margin-bottom:4px">${statusLabel}</div>
            ${project.address ? `<div style="font-size:12px;color:#666;margin-bottom:4px">${project.address}</div>` : ""}
            ${project.description ? `<div style="font-size:12px;color:#888;margin-bottom:6px">${project.description}</div>` : ""}
            <div style="font-size:11px;color:#F09000;font-weight:500">Click to view project details</div>
          </div>
        `);
        infoWindow.open(map, marker);
        google.maps.event.addListenerOnce(infoWindow, "domready", () => {
          const el = document.getElementById(`iw-project-${project.id}`);
          if (el) {
            el.addEventListener("click", () => {
              navigate(`/projects/${project.id}`);
            });
          }
        });
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
