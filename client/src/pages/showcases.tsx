import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Images,
  Plus,
  MoreHorizontal,
  Pencil,
  Link2,
  Code2,
  Trash2,
  Eye,
  MapPin,
  Settings as SettingsIcon,
  Loader2,
  TrendingUp,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { loadGoogleMaps } from "@/lib/google-maps";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Showcase, ShowcaseSettings, Project } from "@shared/schema";

type ShowcaseListItem = Showcase & {
  photoCount: number;
  coverUrl: string;
  coverMediaResolvedId: number | null;
  views30d: number;
};

type ShowcaseSettingsData = ShowcaseSettings & {
  accountName: string | null;
  accountLogoUrl: string | null;
};

type AnalyticsData = {
  days: number;
  totalViews: number;
  portfolioViews: number;
  byShowcase: { showcaseId: number; views: number }[];
  daily: { day: string; views: number }[];
};

function ShowcaseMapPreview({ showcases }: { showcases: ShowcaseListItem[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const { data: mapsConfig } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
  });

  const withCoords = useMemo(
    () => showcases.filter((s) => s.displayLat != null && s.displayLng != null),
    [showcases],
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
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });
      infoWindowRef.current = new google.maps.InfoWindow();
      mapInstanceRef.current = map;
      setMapReady(true);
    } catch (err) {
      console.error("Failed to init map:", err);
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
    if (!withCoords.length) return;
    const bounds = new google.maps.LatLngBounds();
    withCoords.forEach((sc) => {
      const position = { lat: sc.displayLat!, lng: sc.displayLng! };
      bounds.extend(position);
      const pinEl = document.createElement("div");
      pinEl.style.cssText = `width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#F09000;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;`;
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: pinEl,
        title: sc.title,
      });
      marker.addListener("click", () => {
        const iw = infoWindowRef.current;
        if (!iw) return;
        iw.setContent(
          `<div style="padding:6px;min-width:160px"><strong style="font-size:13px">${sc.title}</strong>${sc.locationLabel ? `<div style="font-size:12px;color:#666;margin-top:2px">${sc.locationLabel}</div>` : ""}</div>`,
        );
        iw.open(map, marker);
      });
      markersRef.current.push(marker);
    });
    if (withCoords.length === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(10);
    } else {
      map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    }
  }, [withCoords, mapReady]);

  if (!mapsConfig) {
    return <Skeleton className="w-full h-[240px] rounded-md" />;
  }

  return (
    <div
      ref={mapRef}
      className="w-full h-[240px] rounded-md border overflow-hidden"
      data-testid="map-showcases"
    />
  );
}

export default function ShowcasesPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"published" | "drafts">("published");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newProjectId, setNewProjectId] = useState<string>("none");
  const [deleteTarget, setDeleteTarget] = useState<ShowcaseListItem | null>(null);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);

  const { data: showcases, isLoading } = useQuery<ShowcaseListItem[]>({
    queryKey: ["/api/showcases"],
  });
  const { data: analytics } = useQuery<AnalyticsData>({
    queryKey: [`/api/showcases/analytics?days=${period}`],
  });
  const { data: settings } = useQuery<ShowcaseSettingsData>({
    queryKey: ["/api/showcase-settings"],
  });
  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: createOpen,
  });

  const createShowcase = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/showcases", {
        title: newTitle.trim(),
        projectId: newProjectId === "none" ? null : Number(newProjectId),
      });
      return (await res.json()) as Showcase;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcases"] });
      setCreateOpen(false);
      setNewTitle("");
      setNewProjectId("none");
      navigate(`/showcases/${created.id}/edit`);
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't create showcase", description: e.message, variant: "destructive" });
    },
  });

  const toggleStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "draft" | "published" }) => {
      const res = await apiRequest("PATCH", `/api/showcases/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcases"] });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't update", description: e.message, variant: "destructive" });
    },
  });

  const deleteShowcase = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/showcases/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcases"] });
      setDeleteTarget(null);
      toast({ title: "Showcase deleted" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't delete", description: e.message, variant: "destructive" });
    },
  });

  const all = showcases || [];
  const projectTypeUnion = useMemo(() => {
    const set = new Set<string>();
    all.forEach((s) => (s.projectTypes || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [all]);

  const visible = useMemo(() => {
    return all
      .filter((s) => (activeTab === "published" ? s.status === "published" : s.status === "draft"))
      .filter((s) => !typeFilter || (s.projectTypes || []).includes(typeFilter));
  }, [all, activeTab, typeFilter]);

  const publishedCount = all.filter((s) => s.status === "published").length;
  const draftCount = all.filter((s) => s.status === "draft").length;

  const portfolioReady = !!settings?.portfolioEnabled && !!settings?.portfolioSlug;
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const copyLink = (slug: string) => {
    if (!portfolioReady || !settings?.portfolioSlug) return;
    const url = `${origin}/p/${settings.portfolioSlug}/${slug}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied", description: url });
  };

  const copyEmbed = () => {
    if (!portfolioReady || !settings?.portfolioSlug) return;
    const code = `<iframe src="${origin}/p/${settings.portfolioSlug}/embed" width="100%" height="600" frameborder="0" style="border:0"></iframe>`;
    navigator.clipboard.writeText(code);
    toast({ title: "Embed code copied" });
  };

  const sparkData = (analytics?.daily || []).map((d) => ({ day: d.day, views: d.views }));
  const viewsByShowcase = useMemo(() => {
    const m = new Map<number, number>();
    (analytics?.byShowcase || []).forEach((r) => m.set(r.showcaseId, r.views));
    return m;
  }, [analytics]);

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-showcases-title">
            Showcases
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Curate published project stories for your public portfolio.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/showcases/settings">
            <Button variant="outline" data-testid="link-portfolio-settings">
              <SettingsIcon className="h-4 w-4 mr-2" />
              Portfolio Settings
            </Button>
          </Link>
          <Button onClick={() => setCreateOpen(true)} data-testid="button-new-showcase">
            <Plus className="h-4 w-4 mr-2" />
            New Showcase
          </Button>
        </div>
      </div>

      {/* Analytics period selector */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-medium text-muted-foreground">Analytics</p>
        <div className="flex items-center gap-1" data-testid="group-analytics-period">
          {([7, 30, 90] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={period === d ? "default" : "outline"}
              onClick={() => setPeriod(d)}
              data-testid={`button-analytics-${d}d`}
            >
              {d}d
            </Button>
          ))}
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4" data-testid="stat-total-views">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Eye className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold" data-testid="text-total-views">
                {analytics?.totalViews ?? 0}
              </p>
              <p className="text-xs text-muted-foreground">Total views ({period}d)</p>
            </div>
          </div>
        </Card>
        <Card className="p-4" data-testid="stat-portfolio-views">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Images className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold" data-testid="text-portfolio-views">
                {analytics?.portfolioViews ?? 0}
              </p>
              <p className="text-xs text-muted-foreground">Portfolio views ({period}d)</p>
            </div>
          </div>
        </Card>
        <Card className="p-4" data-testid="stat-views-trend">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-primary" />
            <p className="text-xs text-muted-foreground">Daily views ({period}d)</p>
          </div>
          <div className="h-[52px]">
            {sparkData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparkData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <Area
                    type="monotone"
                    dataKey="views"
                    stroke="hsl(36, 100%, 47%)"
                    fill="hsl(36, 100%, 47%)"
                    fillOpacity={0.2}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center text-xs text-muted-foreground">No views yet</div>
            )}
          </div>
        </Card>
      </div>

      {/* Map preview */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Published locations</h2>
        </div>
        <ShowcaseMapPreview showcases={all.filter((s) => s.status === "published")} />
      </Card>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        <button
          onClick={() => setActiveTab("published")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "published"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground"
          }`}
          data-testid="tab-published"
        >
          Published ({publishedCount})
        </button>
        <button
          onClick={() => setActiveTab("drafts")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "drafts"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground"
          }`}
          data-testid="tab-drafts"
        >
          Drafts ({draftCount})
        </button>
      </div>

      {/* Type filter */}
      {projectTypeUnion.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={typeFilter === null ? "default" : "secondary"}
            className="cursor-pointer"
            onClick={() => setTypeFilter(null)}
            data-testid="chip-type-all"
          >
            All
          </Badge>
          {projectTypeUnion.map((t) => (
            <Badge
              key={t}
              variant={typeFilter === t ? "default" : "secondary"}
              className="cursor-pointer"
              onClick={() => setTypeFilter(t)}
              data-testid={`chip-type-${t}`}
            >
              {t}
            </Badge>
          ))}
        </div>
      )}

      {/* Grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card className="p-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto mb-3">
            <Images className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold">
            No {activeTab === "published" ? "published showcases" : "drafts"} yet
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Create a showcase to feature your best work.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((sc) => (
            <Card key={sc.id} className="overflow-hidden flex flex-col" data-testid={`card-showcase-${sc.id}`}>
              <Link href={`/showcases/${sc.id}/edit`}>
                <div className="aspect-video bg-muted overflow-hidden">
                  {sc.coverMediaResolvedId ? (
                    <img
                      src={sc.coverUrl}
                      alt={sc.title}
                      className="w-full h-full object-cover"
                      data-testid={`img-cover-${sc.id}`}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Images className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                </div>
              </Link>
              <div className="p-4 flex flex-col gap-2 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold truncate" data-testid={`text-title-${sc.id}`}>
                      {sc.title}
                    </h3>
                    {sc.locationLabel && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <MapPin className="h-3 w-3" />
                        {sc.locationLabel}
                      </p>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" data-testid={`button-menu-${sc.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild data-testid={`menu-edit-${sc.id}`}>
                        <Link href={`/showcases/${sc.id}/edit`}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </Link>
                      </DropdownMenuItem>
                      {portfolioReady ? (
                        <DropdownMenuItem onClick={() => copyLink(sc.slug)} data-testid={`menu-copy-link-${sc.id}`}>
                          <Link2 className="h-4 w-4 mr-2" />
                          Copy Portfolio Link
                        </DropdownMenuItem>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div>
                              <DropdownMenuItem disabled data-testid={`menu-copy-link-${sc.id}`}>
                                <Link2 className="h-4 w-4 mr-2" />
                                Copy Portfolio Link
                              </DropdownMenuItem>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            Enable your portfolio and set a URL in Portfolio Settings first.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <DropdownMenuItem
                        onClick={copyEmbed}
                        disabled={!portfolioReady}
                        data-testid={`menu-copy-embed-${sc.id}`}
                      >
                        <Code2 className="h-4 w-4 mr-2" />
                        Copy Embed Code
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDeleteTarget(sc)}
                        className="text-destructive focus:text-destructive"
                        data-testid={`menu-delete-${sc.id}`}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(sc.projectTypes || []).slice(0, 3).map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 mt-auto pt-2">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span data-testid={`text-photo-count-${sc.id}`}>{sc.photoCount} photos</span>
                    <span
                      className="flex items-center gap-1"
                      data-testid={`text-views-${sc.id}`}
                    >
                      <Eye className="h-3 w-3" />
                      {viewsByShowcase.get(sc.id) ?? 0} views · {period}d
                    </span>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Switch
                      checked={sc.status === "published"}
                      onCheckedChange={(v) =>
                        toggleStatus.mutate({ id: sc.id, status: v ? "published" : "draft" })
                      }
                      disabled={toggleStatus.isPending}
                      data-testid={`switch-publish-${sc.id}`}
                    />
                    {sc.status === "published" ? "Live" : "Draft"}
                  </label>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="dialog-create-showcase">
          <DialogHeader>
            <DialogTitle>New Showcase</DialogTitle>
            <DialogDescription>
              Give your showcase a title. You can optionally link a project to pull in photos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Downtown Kitchen Remodel"
                data-testid="input-showcase-title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Project (optional)</label>
              <Select value={newProjectId} onValueChange={setNewProjectId}>
                <SelectTrigger data-testid="select-project">
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {(projects || []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-cancel-create">
              Cancel
            </Button>
            <Button
              onClick={() => createShowcase.mutate()}
              disabled={!newTitle.trim() || createShowcase.isPending}
              data-testid="button-confirm-create"
            >
              {createShowcase.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent data-testid="dialog-delete-showcase">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete showcase?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes "{deleteTarget?.title}" and its published page. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteShowcase.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
