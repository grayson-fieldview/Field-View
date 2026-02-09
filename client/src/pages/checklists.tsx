import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  ClipboardCheck,
  CheckCircle2,
  Clock,
  Circle,
} from "lucide-react";
import { Link } from "wouter";
import type { Checklist } from "@shared/schema";

type ChecklistWithDetails = Checklist & {
  project?: { name: string };
  assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
  itemCount: number;
  checkedCount: number;
};

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground" },
  in_progress: { label: "In Progress", icon: Clock, className: "text-amber-500" },
  completed: { label: "Completed", icon: CheckCircle2, className: "text-green-500" },
};

export default function ChecklistsPage() {
  const { data: allChecklists, isLoading } = useQuery<ChecklistWithDetails[]>({
    queryKey: ["/api/checklists"],
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-checklists-title">Checklists</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage and track checklists across all projects</p>
        </div>
      </div>

      {(!allChecklists || allChecklists.length === 0) ? (
        <Card className="p-12">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
              <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No checklists yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Checklists are created within projects. Go to a project to create your first checklist.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {allChecklists.map((cl) => {
            const config = statusConfig[cl.status] || statusConfig.not_started;
            const StatusIcon = config.icon;
            const progress = cl.itemCount > 0 ? Math.round((cl.checkedCount / cl.itemCount) * 100) : 0;
            return (
              <Card key={cl.id} className="p-4 hover-elevate" data-testid={`card-checklist-${cl.id}`}>
                <div className="flex items-start gap-3">
                  <StatusIcon className={`h-5 w-5 mt-0.5 shrink-0 ${config.className}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/projects/${cl.projectId}`}>
                        <span className="text-sm font-semibold hover:underline cursor-pointer" data-testid={`text-checklist-title-${cl.id}`}>
                          {cl.title}
                        </span>
                      </Link>
                      <Badge variant="secondary" className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate">
                        {cl.checkedCount}/{cl.itemCount} items
                      </Badge>
                    </div>
                    {cl.project && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {cl.project.name}
                      </p>
                    )}
                    {cl.itemCount > 0 && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">{progress}%</span>
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      {cl.assignedTo && (
                        <div className="flex items-center gap-1.5">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={cl.assignedTo.profileImageUrl || undefined} />
                            <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                              {getInitials(cl.assignedTo.firstName, cl.assignedTo.lastName)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-xs text-muted-foreground">
                            {cl.assignedTo.firstName} {cl.assignedTo.lastName}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
