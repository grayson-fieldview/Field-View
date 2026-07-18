import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowLeft,
  Loader2,
  Plus,
  X,
  Star,
  ChevronLeft,
  ChevronRight,
  Trash2,
  MapPin,
  GripVertical,
  Images,
  ArrowLeftRight,
  Link2Off,
} from "lucide-react";
import { loadGoogleMaps } from "@/lib/google-maps";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Showcase, ShowcaseSettings, Project } from "@shared/schema";

type ShowcasePhotoDetail = {
  id: number;
  mediaId: number;
  sortOrder: number;
  caption: string | null;
  pairGroupId: string | null;
  pairRole: "before" | "after" | null;
  url: string;
  mimeType?: string;
};

type ShowcaseDetail = Showcase & { photos: ShowcasePhotoDetail[] };

type ShowcaseSettingsData = ShowcaseSettings & {
  accountName: string | null;
  accountLogoUrl: string | null;
};

type ProjectMedia = {
  id: number;
  url: string;
  mimeType: string;
  caption: string | null;
};

type ProjectDetailData = {
  project: Project;
  media: ProjectMedia[];
};

type LocalPhoto = {
  mediaId: number;
  url: string;
  caption: string;
  pairGroupId: string | null;
  pairRole: "before" | "after" | null;
};

// ~0.005 deg jitter for privacy when copying project location.
function jitter(v: number): number {
  return +(v + (Math.random() - 0.5) * 0.01).toFixed(5);
}

function LocationMap({
  lat,
  lng,
  onChange,
}: {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const { data: mapsConfig } = useQuery<{ apiKey: string }>({
    queryKey: ["/api/config/maps"],
  });

  const placeMarker = useCallback((map: google.maps.Map, position: google.maps.LatLngLiteral) => {
    if (markerRef.current) markerRef.current.map = null;
    const pinEl = document.createElement("div");
    pinEl.style.cssText =
      "width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#F09000;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:grab;";
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position,
      content: pinEl,
      gmpDraggable: true,
    });
    marker.addListener("dragend", (e: any) => {
      const p = e.latLng || marker.position;
      const nlat = typeof p.lat === "function" ? p.lat() : (p as any).lat;
      const nlng = typeof p.lng === "function" ? p.lng() : (p as any).lng;
      onChangeRef.current(+nlat.toFixed(5), +nlng.toFixed(5));
    });
    markerRef.current = marker;
  }, []);

  useEffect(() => {
    if (!mapsConfig?.apiKey || !mapRef.current) return;
    let cancelled = false;
    (async () => {
      await loadGoogleMaps(mapsConfig.apiKey);
      if (cancelled || !mapRef.current) return;
      const center = lat != null && lng != null ? { lat, lng } : { lat: 39.8283, lng: -98.5795 };
      if (!mapInstanceRef.current) {
        const map = new google.maps.Map(mapRef.current, {
          center,
          zoom: lat != null ? 11 : 4,
          mapId: "fieldview-map",
          disableDefaultUI: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        });
        map.addListener("click", (e: any) => {
          const nlat = +e.latLng.lat().toFixed(5);
          const nlng = +e.latLng.lng().toFixed(5);
          onChangeRef.current(nlat, nlng);
        });
        mapInstanceRef.current = map;
      }
      if (lat != null && lng != null) {
        placeMarker(mapInstanceRef.current, { lat, lng });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapsConfig?.apiKey, lat, lng]);

  if (!mapsConfig) return <Skeleton className="w-full h-[260px] rounded-md" />;
  return (
    <div
      ref={mapRef}
      className="w-full h-[260px] rounded-md border overflow-hidden"
      data-testid="map-location"
    />
  );
}

export default function ShowcaseEditPage({ id }: { id: string }) {
  const showcaseId = Number(id);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: showcase, isLoading } = useQuery<ShowcaseDetail>({
    queryKey: ["/api/showcases", showcaseId],
  });
  const { data: settings } = useQuery<ShowcaseSettingsData>({
    queryKey: ["/api/showcase-settings"],
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectTypes, setProjectTypes] = useState<string[]>([]);
  const [productsUsed, setProductsUsed] = useState<string[]>([]);
  const [productInput, setProductInput] = useState("");
  const [newTagInput, setNewTagInput] = useState("");
  const [displayLat, setDisplayLat] = useState<number | null>(null);
  const [displayLng, setDisplayLng] = useState<number | null>(null);
  const [locationLabel, setLocationLabel] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [coverMediaId, setCoverMediaId] = useState<number | null>(null);
  const [selectedForPair, setSelectedForPair] = useState<Set<number>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    if (showcase && !initialized) {
      setTitle(showcase.title);
      setDescription(showcase.description || "");
      setProjectTypes(showcase.projectTypes || []);
      setProductsUsed(showcase.productsUsed || []);
      setDisplayLat(showcase.displayLat ?? null);
      setDisplayLng(showcase.displayLng ?? null);
      setLocationLabel(showcase.locationLabel || "");
      setProjectId(showcase.projectId ?? null);
      setCoverMediaId(showcase.coverMediaId ?? null);
      setPhotos(
        (showcase.photos || [])
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => ({
            mediaId: p.mediaId,
            url: p.url,
            caption: p.caption || "",
            pairGroupId: p.pairGroupId,
            pairRole: p.pairRole,
          })),
      );
      setInitialized(true);
    }
  }, [showcase, initialized]);

  const { data: projectsList } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });
  const { data: projectDetail } = useQuery<ProjectDetailData>({
    queryKey: ["/api/projects", projectId],
    enabled: projectId != null,
  });

  const projectImages = useMemo(
    () => (projectDetail?.media || []).filter((m) => m.mimeType.startsWith("image/")),
    [projectDetail],
  );
  const projectLocation = projectDetail?.project;

  const availableTags = settings?.showcaseTags || [];

  const savePhotos = async () => {
    const payload = photos.map((p, i) => ({
      mediaId: p.mediaId,
      sortOrder: i,
      caption: p.caption || null,
      pairGroupId: p.pairGroupId,
      pairRole: p.pairRole,
    }));
    await apiRequest("PUT", `/api/showcases/${showcaseId}/photos`, { photos: payload });
  };

  const saveMutation = useMutation({
    mutationFn: async (publish: boolean) => {
      // Persist photos first so publish validation (>=1 photo) sees them.
      await savePhotos();
      const body: any = {
        title: title.trim(),
        description: description.trim() || null,
        projectTypes,
        productsUsed,
        projectId,
        displayLat,
        displayLng,
        locationLabel: locationLabel.trim() || null,
        coverMediaId: coverMediaId,
      };
      body.status = publish ? "published" : "draft";
      const res = await apiRequest("PATCH", `/api/showcases/${showcaseId}`, body);
      return res.json();
    },
    onSuccess: (_data, publish) => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcases", showcaseId] });
      queryClient.invalidateQueries({ queryKey: ["/api/showcases"] });
      toast({ title: publish ? "Showcase published" : "Draft saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
  });

  const addTagMutation = useMutation({
    mutationFn: async (tag: string) => {
      const next = Array.from(new Set([...availableTags, tag]));
      const res = await apiRequest("PATCH", "/api/showcase-settings", { showcaseTags: next });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcase-settings"] });
      setNewTagInput("");
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't add tag", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/showcases/${showcaseId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/showcases"] });
      navigate("/showcases");
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't delete", description: e.message, variant: "destructive" });
    },
  });

  const toggleProjectType = (tag: string) => {
    setProjectTypes((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const addProduct = () => {
    const v = productInput.trim();
    if (!v) return;
    if (!productsUsed.includes(v)) setProductsUsed((p) => [...p, v]);
    setProductInput("");
  };

  const selectedMediaIds = new Set(photos.map((p) => p.mediaId));

  const addProjectPhoto = (m: ProjectMedia) => {
    if (selectedMediaIds.has(m.id)) {
      setPhotos((prev) => prev.filter((p) => p.mediaId !== m.id));
    } else {
      setPhotos((prev) => [
        ...prev,
        { mediaId: m.id, url: m.url, caption: m.caption || "", pairGroupId: null, pairRole: null },
      ]);
    }
  };

  const movePhoto = (index: number, dir: -1 | 1) => {
    setPhotos((prev) => {
      const next = prev.slice();
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleDrop = (index: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from == null || from === index) return;
    setPhotos((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      return next;
    });
  };

  const removePhoto = (mediaId: number) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.mediaId === mediaId);
      let next = prev.filter((p) => p.mediaId !== mediaId);
      // If removing a paired photo, unpair its partner.
      if (target?.pairGroupId) {
        next = next.map((p) =>
          p.pairGroupId === target.pairGroupId ? { ...p, pairGroupId: null, pairRole: null } : p,
        );
      }
      return next;
    });
    if (coverMediaId === mediaId) setCoverMediaId(null);
    setSelectedForPair((prev) => {
      const s = new Set(prev);
      s.delete(mediaId);
      return s;
    });
  };

  const toggleSelectForPair = (mediaId: number) => {
    setSelectedForPair((prev) => {
      const s = new Set(prev);
      if (s.has(mediaId)) s.delete(mediaId);
      else s.add(mediaId);
      return s;
    });
  };

  const pairSelected = () => {
    const ids = Array.from(selectedForPair);
    if (ids.length !== 2) {
      toast({ title: "Select exactly two photos to pair", variant: "destructive" });
      return;
    }
    const groupId = crypto.randomUUID();
    setPhotos((prev) =>
      prev.map((p) => {
        if (p.mediaId === ids[0]) return { ...p, pairGroupId: groupId, pairRole: "before" };
        if (p.mediaId === ids[1]) return { ...p, pairGroupId: groupId, pairRole: "after" };
        return p;
      }),
    );
    setSelectedForPair(new Set());
  };

  const swapPair = (groupId: string) => {
    setPhotos((prev) =>
      prev.map((p) =>
        p.pairGroupId === groupId
          ? { ...p, pairRole: p.pairRole === "before" ? "after" : "before" }
          : p,
      ),
    );
  };

  const unpair = (groupId: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.pairGroupId === groupId ? { ...p, pairGroupId: null, pairRole: null } : p)),
    );
  };

  if (isLoading || !showcase) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href="/showcases">
            <Button size="icon" variant="ghost" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-edit-title">
              Edit Showcase
            </h1>
            <Badge variant="secondary" className="mt-1">
              {showcase.status === "published" ? "Published" : "Draft"}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => saveMutation.mutate(false)}
            disabled={saveMutation.isPending}
            data-testid="button-save-draft"
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save as Draft"}
          </Button>
          <Button
            onClick={() => saveMutation.mutate(true)}
            disabled={saveMutation.isPending}
            data-testid="button-publish"
          >
            Publish
          </Button>
        </div>
      </div>

      {/* Basics */}
      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Title</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="input-title" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            data-testid="input-description"
          />
        </div>

        {/* Project types */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Project types</label>
          <div className="flex flex-wrap gap-2">
            {availableTags.map((tag) => (
              <Badge
                key={tag}
                variant={projectTypes.includes(tag) ? "default" : "secondary"}
                className="cursor-pointer"
                onClick={() => toggleProjectType(tag)}
                data-testid={`chip-project-type-${tag}`}
              >
                {tag}
              </Badge>
            ))}
            {availableTags.length === 0 && (
              <p className="text-xs text-muted-foreground">No tags yet — add one below.</p>
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Input
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              placeholder="Add a new tag…"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newTagInput.trim()) addTagMutation.mutate(newTagInput.trim());
                }
              }}
              data-testid="input-new-tag"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => newTagInput.trim() && addTagMutation.mutate(newTagInput.trim())}
              disabled={!newTagInput.trim() || addTagMutation.isPending}
              data-testid="button-add-tag"
            >
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </div>

        {/* Products used */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Products used</label>
          <div className="flex items-center gap-2">
            <Input
              value={productInput}
              onChange={(e) => setProductInput(e.target.value)}
              placeholder="Add a product…"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addProduct();
                }
              }}
              data-testid="input-product"
            />
            <Button size="sm" variant="outline" onClick={addProduct} data-testid="button-add-product">
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {productsUsed.map((p) => (
              <Badge key={p} variant="secondary" className="gap-1.5" data-testid={`badge-product-${p}`}>
                {p}
                <X
                  className="h-3 w-3 cursor-pointer"
                  onClick={() => setProductsUsed((prev) => prev.filter((x) => x !== p))}
                />
              </Badge>
            ))}
          </div>
        </div>
      </Card>

      {/* Location */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Location</h2>
        </div>
        <p className="text-xs text-muted-foreground">Pin is approximate for privacy.</p>
        <LocationMap
          lat={displayLat}
          lng={displayLng}
          onChange={(la, ln) => {
            setDisplayLat(la);
            setDisplayLng(ln);
          }}
        />
        {projectLocation?.latitude != null && projectLocation?.longitude != null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDisplayLat(jitter(projectLocation.latitude!));
              setDisplayLng(jitter(projectLocation.longitude!));
            }}
            data-testid="button-use-project-location"
          >
            Use project location (approximate)
          </Button>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium">Location label</label>
          <Input
            value={locationLabel}
            onChange={(e) => setLocationLabel(e.target.value)}
            placeholder="City, ST"
            data-testid="input-location-label"
          />
        </div>
      </Card>

      {/* Photos */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Images className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Photos</h2>
        </div>

        {/* Project picker */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Source project</label>
          <Select
            value={projectId != null ? String(projectId) : "none"}
            onValueChange={(v) => setProjectId(v === "none" ? null : Number(v))}
          >
            <SelectTrigger className="max-w-sm" data-testid="select-source-project">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No project</SelectItem>
              {(projectsList || []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Project photo grid */}
        {projectId != null && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Tap photos to add or remove them from this showcase.</p>
            {projectImages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No photos in this project.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {projectImages.map((m) => {
                  const added = selectedMediaIds.has(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => addProjectPhoto(m)}
                      className={`relative aspect-square rounded-md overflow-hidden border-2 ${
                        added ? "border-primary" : "border-transparent"
                      }`}
                      data-testid={`button-project-photo-${m.id}`}
                    >
                      <img src={m.url} alt="" className="w-full h-full object-cover" />
                      {added && (
                        <div className="absolute top-1 right-1 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                          <Checkbox checked className="pointer-events-none" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <Separator />

        {/* Selected photos strip */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Selected photos ({photos.length})</p>
          <Button
            size="sm"
            variant="outline"
            onClick={pairSelected}
            disabled={selectedForPair.size !== 2}
            data-testid="button-pair"
          >
            <ArrowLeftRight className="h-4 w-4 mr-1" /> Pair as Before/After
          </Button>
        </div>

        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No photos selected yet.</p>
        ) : (
          <div className="space-y-2">
            {photos.map((p, index) => {
              const paired = !!p.pairGroupId;
              return (
                <div
                  key={p.mediaId}
                  draggable
                  onDragStart={() => (dragIndex.current = index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(index)}
                  className="flex items-center gap-3 p-2 rounded-md border bg-card"
                  data-testid={`row-photo-${p.mediaId}`}
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab shrink-0" />
                  <Checkbox
                    checked={selectedForPair.has(p.mediaId)}
                    onCheckedChange={() => toggleSelectForPair(p.mediaId)}
                    data-testid={`checkbox-pair-${p.mediaId}`}
                  />
                  <img src={p.url} alt="" className="h-14 w-14 rounded-md object-cover shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <Input
                      defaultValue={p.caption}
                      onBlur={(e) =>
                        setPhotos((prev) =>
                          prev.map((x) => (x.mediaId === p.mediaId ? { ...x, caption: e.target.value } : x)),
                        )
                      }
                      placeholder="Caption…"
                      className="h-8"
                      data-testid={`input-caption-${p.mediaId}`}
                    />
                    {paired && (
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">
                          {p.pairRole === "before" ? "Before" : "After"}
                        </Badge>
                        <button
                          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                          onClick={() => swapPair(p.pairGroupId!)}
                          data-testid={`button-swap-${p.mediaId}`}
                        >
                          <ArrowLeftRight className="h-3 w-3" /> Swap
                        </button>
                        <button
                          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                          onClick={() => unpair(p.pairGroupId!)}
                          data-testid={`button-unpair-${p.mediaId}`}
                        >
                          <Link2Off className="h-3 w-3" /> Unpair
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setCoverMediaId(p.mediaId)}
                      data-testid={`button-cover-${p.mediaId}`}
                      title="Set as cover"
                    >
                      <Star
                        className={`h-4 w-4 ${coverMediaId === p.mediaId ? "fill-primary text-primary" : ""}`}
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => movePhoto(index, -1)}
                      disabled={index === 0}
                      data-testid={`button-move-up-${p.mediaId}`}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => movePhoto(index, 1)}
                      disabled={index === photos.length - 1}
                      data-testid={`button-move-down-${p.mediaId}`}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removePhoto(p.mediaId)}
                      data-testid={`button-remove-${p.mediaId}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Danger zone */}
      <Card className="p-6">
        <Button
          variant="outline"
          className="text-destructive"
          onClick={() => setDeleteOpen(true)}
          data-testid="button-delete-showcase"
        >
          <Trash2 className="h-4 w-4 mr-2" /> Delete showcase
        </Button>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent data-testid="dialog-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete showcase?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes "{showcase.title}". This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
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
