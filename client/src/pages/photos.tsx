import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Camera,
  MapPin,
  Calendar,
  Tag,
  Image as ImageIcon,
  Download,
  FolderKanban,
} from "lucide-react";
import type { Media, Project } from "@shared/schema";

type MediaWithProject = Media & {
  project?: { name: string; color: string | null };
  uploadedBy?: { firstName: string | null; lastName: string | null };
};

export default function PhotosPage() {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedPhoto, setSelectedPhoto] = useState<MediaWithProject | null>(null);

  const { data: allMedia, isLoading } = useQuery<MediaWithProject[]>({
    queryKey: ["/api/media"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const filtered = (allMedia || []).filter((m) => {
    const matchesSearch =
      (m.caption || "").toLowerCase().includes(search.toLowerCase()) ||
      m.originalName.toLowerCase().includes(search.toLowerCase()) ||
      (m.tags || []).some((t) => t.toLowerCase().includes(search.toLowerCase()));
    const matchesProject = projectFilter === "all" || m.projectId.toString() === projectFilter;
    return matchesSearch && matchesProject;
  });

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-photos-title">Photos</h1>
        <p className="text-sm text-muted-foreground mt-1">Browse all uploaded photos across projects</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by caption, tag, or filename..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-photos"
          />
        </div>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-[180px]" data-testid="select-project-filter">
            <SelectValue placeholder="All Projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {(projects || []).map((p) => (
              <SelectItem key={p.id} value={p.id.toString()}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="text-sm text-muted-foreground">
        {filtered.length} photo{filtered.length !== 1 ? "s" : ""} found
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-12">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold" data-testid="text-no-photos">No photos found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {search || projectFilter !== "all"
                ? "Try adjusting your search or filter."
                : "Upload photos to your projects to see them here."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((item) => (
            <Card
              key={item.id}
              className="overflow-visible cursor-pointer hover-elevate group"
              onClick={() => setSelectedPhoto(item)}
              data-testid={`card-photo-${item.id}`}
            >
              <div className="aspect-square overflow-hidden rounded-t-md relative">
                <img
                  src={item.url}
                  alt={item.caption || item.originalName}
                  className="w-full h-full object-cover md:transition-transform md:duration-300 md:group-hover:scale-105"
                />
                {item.uploadedBy && (
                  <div
                    className="absolute top-2 left-2 h-7 w-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-bold shadow-md"
                    data-testid={`avatar-uploader-${item.id}`}
                  >
                    {`${(item.uploadedBy.firstName || "")[0] || ""}${(item.uploadedBy.lastName || "")[0] || ""}`.toUpperCase() || "U"}
                  </div>
                )}
              </div>
              <div className="p-2 space-y-0.5">
                {item.project && (
                  <p className="text-xs font-medium truncate" data-testid={`text-photo-project-${item.id}`}>
                    {item.project.name}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground" data-testid={`text-photo-date-${item.id}`}>
                  {new Date(item.createdAt).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })} | {new Date(item.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!selectedPhoto} onOpenChange={(open) => !open && setSelectedPhoto(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-4 w-4" />
              {selectedPhoto?.caption || selectedPhoto?.originalName}
            </DialogTitle>
          </DialogHeader>
          {selectedPhoto && (
            <div className="space-y-4">
              <div className="rounded-md overflow-hidden bg-muted">
                <img
                  src={selectedPhoto.url}
                  alt={selectedPhoto.caption || ""}
                  className="w-full h-auto max-h-[60vh] object-contain"
                />
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                {selectedPhoto.project && (
                  <span className="flex items-center gap-1.5">
                    <FolderKanban className="h-3.5 w-3.5" />
                    {selectedPhoto.project.name}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(selectedPhoto.createdAt).toLocaleString()}
                </span>
                {selectedPhoto.latitude && selectedPhoto.longitude && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5" />
                    {selectedPhoto.latitude.toFixed(4)}, {selectedPhoto.longitude.toFixed(4)}
                  </span>
                )}
              </div>
              {selectedPhoto.tags && selectedPhoto.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                  {selectedPhoto.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              )}
              {selectedPhoto.uploadedBy && (
                <p className="text-xs text-muted-foreground">
                  Uploaded by {selectedPhoto.uploadedBy.firstName} {selectedPhoto.uploadedBy.lastName}
                </p>
              )}
              <Button variant="outline" asChild>
                <a href={selectedPhoto.url} download={selectedPhoto.originalName} data-testid="button-download-photo">
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </a>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
