import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapPin, Image as ImageIcon, ListChecks, ExternalLink } from "lucide-react";

interface PublicProjectData {
  project: {
    id: number;
    name: string;
    address: string | null;
    status: string;
    color: string | null;
    photoCount: number;
    taskCount: number;
    completionPercent: number;
  };
  account: {
    name: string;
    companyLogoUrl: string | null;
  };
  coverPhoto: { url: string } | null;
  recentPhotos: Array<{ id: number; url: string; takenAt: string }>;
}

interface MeResponse {
  id?: string;
  accountId?: string;
}

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  on_hold: "On Hold",
  archived: "Archived",
};

export default function PublicProjectPage({ token }: { token: string }) {
  const { data, isLoading, error } = useQuery<PublicProjectData>({
    queryKey: ["/api/public/projects", token],
  });

  // Light client-side detection — if /api/me returns a user, link the CTA
  // straight to /projects/:id (full app); otherwise to /signup. We don't
  // gate any rendering on this — the public payload is always shown.
  const { data: me } = useQuery<MeResponse | null>({
    queryKey: ["/api/me"],
    retry: false,
  });

  useEffect(() => {
    // Keep public project pages out of search engines.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  useEffect(() => {
    if (data?.project.name) {
      const previous = document.title;
      document.title = `${data.project.name} — Field View`;
      return () => {
        document.title = previous;
      };
    }
  }, [data?.project.name]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <h1 className="text-2xl font-bold" data-testid="text-public-project-error">
            Project not found
          </h1>
          <p className="text-muted-foreground">
            This link may have been revoked or never existed.
          </p>
        </div>
      </div>
    );
  }

  const { project, account, coverPhoto, recentPhotos } = data;
  const statusLabel = STATUS_LABELS[project.status] || project.status;
  const ctaHref = me?.id ? `/projects/${project.id}` : "/signup";
  const ctaLabel = me?.id ? "Open in Field View" : "Sign in to view full project";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {account.companyLogoUrl && (
              <img
                src={account.companyLogoUrl}
                alt={account.name}
                className="h-8 w-auto object-contain shrink-0"
                data-testid="img-public-project-logo"
              />
            )}
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground truncate">Project shared with you</p>
              <h1 className="text-base font-semibold truncate" data-testid="text-public-project-account-name">
                {account.name}
              </h1>
            </div>
          </div>
          <Button asChild variant="secondary" size="sm" data-testid="button-public-project-cta">
            <a href={ctaHref}>
              <ExternalLink className="h-4 w-4 mr-1.5" />
              {ctaLabel}
            </a>
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        <section className="space-y-4" data-testid="section-public-project-header">
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-3xl font-serif" data-testid="text-public-project-name">
                {project.name}
              </h2>
              <Badge variant="secondary" data-testid="badge-public-project-status">
                {statusLabel}
              </Badge>
            </div>
            {project.address && (
              <p className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-public-project-address">
                <MapPin className="h-3.5 w-3.5" />
                {project.address}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Card className="p-4 space-y-1" data-testid="card-public-project-photos">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" />
                Photos
              </div>
              <p className="text-2xl font-semibold" data-testid="text-public-project-photo-count">
                {project.photoCount}
              </p>
            </Card>
            <Card className="p-4 space-y-1" data-testid="card-public-project-tasks">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ListChecks className="h-3.5 w-3.5" />
                Tasks
              </div>
              <p className="text-2xl font-semibold" data-testid="text-public-project-task-count">
                {project.taskCount}
              </p>
            </Card>
            <Card className="p-4 space-y-1" data-testid="card-public-project-completion">
              <div className="text-xs text-muted-foreground">Completion</div>
              <p className="text-2xl font-semibold" data-testid="text-public-project-completion-percent">
                {project.completionPercent}%
              </p>
            </Card>
          </div>

          {coverPhoto && (
            <div className="rounded-md overflow-hidden bg-muted">
              <img
                src={coverPhoto.url}
                alt={`${project.name} cover`}
                className="w-full max-h-96 object-cover"
                data-testid="img-public-project-cover"
              />
            </div>
          )}
        </section>

        <section className="space-y-4" data-testid="section-public-project-recent">
          <h3 className="text-xl font-semibold">Recent photos</h3>
          {recentPhotos.length === 0 ? (
            <Card className="p-12 text-center" data-testid="card-public-project-no-photos">
              <p className="text-sm text-muted-foreground">No photos yet.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {recentPhotos.map((photo) => (
                <a
                  key={photo.id}
                  href={photo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block aspect-[4/3] rounded-md overflow-hidden bg-muted"
                  data-testid={`img-public-project-photo-${photo.id}`}
                >
                  <img
                    src={photo.url}
                    alt="Project photo"
                    className="w-full h-full object-cover hover:opacity-90 transition-opacity"
                  />
                </a>
              ))}
            </div>
          )}
        </section>

        <section className="text-center pt-4">
          <Button asChild size="lg" data-testid="button-public-project-cta-bottom">
            <a href={ctaHref}>
              <ExternalLink className="h-4 w-4 mr-2" />
              {ctaLabel}
            </a>
          </Button>
        </section>
      </main>

      <footer className="border-t mt-8 py-4">
        <div className="max-w-5xl mx-auto px-4 text-center">
          <p className="text-xs text-muted-foreground">Shared via Field View</p>
        </div>
      </footer>
    </div>
  );
}
