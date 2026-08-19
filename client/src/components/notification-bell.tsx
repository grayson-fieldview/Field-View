import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDistanceToNow } from "date-fns";
import { AtSign, Bell, ClipboardList } from "lucide-react";
import type { Project } from "@shared/schema";

interface NotificationRow {
  id: number;
  type: string; // "project_mention" | "task_assigned"
  projectId: number | null;
  messageId: number | null;
  taskId: number | null;
  actorUserId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface AccountUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

function actorName(u: AccountUser | undefined): string {
  if (!u) return "Someone";
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || "Someone";
}

export function NotificationBell() {
  const [, navigate] = useLocation();

  const { data } = useQuery<{ notifications: NotificationRow[]; hasMore: boolean }>({
    queryKey: ["/api/notifications"],
    queryFn: async () => {
      const res = await fetch("/api/notifications?limit=20", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch notifications");
      return res.json();
    },
    refetchInterval: 30_000,
  });
  const rows = data?.notifications ?? [];
  const unreadCount = rows.filter((n) => n.readAt === null).length;

  // Name/project resolution — both lists are already cached app-wide.
  const { data: users = [] } = useQuery<AccountUser[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    staleTime: 60_000,
  });
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    staleTime: 60_000,
  });

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const markRead = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });
  const markAllRead = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/notifications/read-all"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
  });

  const openRow = (n: NotificationRow) => {
    if (n.readAt === null) markRead.mutate(n.id);
    if (n.type === "project_mention" && n.projectId) {
      navigate(`/projects/${n.projectId}?tab=messages`);
    } else if (n.type === "task_assigned" && n.projectId) {
      navigate(`/projects/${n.projectId}?tab=tasks`);
    }
  };

  const describe = (n: NotificationRow): { icon: JSX.Element; text: string } => {
    const who = actorName(n.actorUserId ? userById.get(n.actorUserId) : undefined);
    const project = n.projectId ? projectById.get(n.projectId)?.name ?? "a project" : "a project";
    if (n.type === "project_mention") {
      return { icon: <AtSign className="h-4 w-4 text-primary shrink-0" />, text: `${who} mentioned you in ${project}` };
    }
    if (n.type === "task_assigned") {
      return { icon: <ClipboardList className="h-4 w-4 text-primary shrink-0" />, text: `${who} assigned you a task in ${project}` };
    }
    return { icon: <Bell className="h-4 w-4 text-muted-foreground shrink-0" />, text: `Notification in ${project}` };
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8" data-testid="button-notifications">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center"
              data-testid="badge-notification-count"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="popover-notifications">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              data-testid="button-mark-all-read"
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No notifications yet.</p>
          ) : (
            rows.map((n) => {
              const d = describe(n);
              return (
                <button
                  key={n.id}
                  onClick={() => openRow(n)}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-accent border-b last:border-b-0 ${
                    n.readAt === null ? "bg-primary/5" : ""
                  }`}
                  data-testid={`notification-${n.id}`}
                >
                  {d.icon}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-snug ${n.readAt === null ? "font-medium" : "text-muted-foreground"}`}>
                      {d.text}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    </span>
                  </span>
                  {n.readAt === null && <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
