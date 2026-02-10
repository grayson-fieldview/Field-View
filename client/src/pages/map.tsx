import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MapPin, FolderKanban, Calendar } from "lucide-react";
import { useLocation } from "wouter";
import type { Project } from "@shared/schema";
import L from "leaflet";

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
  const mapInstanceRef = useRef<L.Map | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [, navigate] = useLocation();

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const projectsWithLocation = (projects || []).filter(
    (p) => p.latitude != null && p.longitude != null
  );

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current, {
      center: [39.8283, -98.5795],
      zoom: 4,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !projectsWithLocation.length) return;

    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    const bounds: L.LatLngBoundsExpression = [];
    projectsWithLocation.forEach((project) => {
      const lat = project.latitude!;
      const lng = project.longitude!;
      bounds.push([lat, lng]);

      const color = project.color || "#E97316";
      const icon = L.divIcon({
        className: "custom-marker",
        html: `<div style="background-color: ${color}; width: 32px; height: 32px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;"><div style="transform: rotate(45deg); color: white; font-size: 14px; font-weight: bold;">${project.name[0]}</div></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
      });

      const marker = L.marker([lat, lng], { icon }).addTo(map);
      marker.on("click", () => setSelectedProject(project));
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [50, 50], maxZoom: 12 });
    }
  }, [projectsWithLocation]);

  return (
    <div className="relative h-full flex flex-col">
      <div className="p-4 sm:p-6 pb-0">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-map-title">Map</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View all project locations ({projectsWithLocation.length} with coordinates)
        </p>
      </div>

      <div className="flex-1 p-4 sm:p-6 pt-4 relative">
        {isLoading ? (
          <Skeleton className="w-full h-full rounded-md" />
        ) : (
          <>
            <link
              rel="stylesheet"
              href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
              crossOrigin=""
            />
            <div
              ref={mapRef}
              className="w-full h-full rounded-md border overflow-hidden min-h-[400px]"
              data-testid="map-container"
            />
          </>
        )}

        {selectedProject && (
          <Card
            className="absolute bottom-8 left-8 right-8 sm:left-auto sm:right-8 sm:w-80 p-4 z-[1000] cursor-pointer hover-elevate"
            onClick={() => navigate(`/projects/${selectedProject.id}`)}
            data-testid="card-map-preview"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: selectedProject.color || "#E97316" }}
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
                  Add latitude and longitude to your projects to see them on the map.
                </p>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
