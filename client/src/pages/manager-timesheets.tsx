import { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  AlertTriangle,
  Users,
  Activity,
  Download,
  BarChart3,
  TableIcon,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import type { TimeEntry, User, Project } from "@shared/schema";
import { centsToCurrency } from "@/lib/money";
import {
  formatHours,
  hoursFromInterval,
  formatLocalDateTime,
  dateToLocalDatetimeInput,
} from "@/lib/duration";
import {
  DATE_RANGE_LABELS,
  formatDateInput,
  getDateRange,
  type DateRangePreset,
} from "@/lib/date-range";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

type ViewMode = "table" | "chart";
type ExportFormat = "generic" | "gusto" | "quickbooks";

const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  generic: "Generic CSV",
  gusto: "Gusto CSV",
  quickbooks: "QuickBooks CSV",
};

interface AddFormState {
  userId: string;
  projectId: string;
  clockIn: string;
  clockOut: string;
  notes: string;
}
const EMPTY_ADD_FORM: AddFormState = {
  userId: "",
  projectId: "",
  clockIn: "",
  clockOut: "",
  notes: "",
};

interface EditFormState {
  projectId: string;
  clockIn: string;
  clockOut: string;
  notes: string;
}

function getBrowserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface UserRow {
  userId: string;
  user: User | undefined;
  totalHours: number;
  totalCostCents: number;
  entryCount: number;
  activeCount: number;
  missingRateCount: number;
  entries: TimeEntry[];
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  auto_geofence: "Auto",
  edited: "Edited",
};

const SOURCE_BADGE_CLASS: Record<string, string> = {
  manual: "bg-muted text-muted-foreground",
  auto_geofence: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  edited: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
};

function userInitials(u: User | undefined): string {
  if (!u) return "?";
  const f = (u.firstName || "")[0] || "";
  const l = (u.lastName || "")[0] || "";
  return (f + l).toUpperCase() || (u.email || "?")[0].toUpperCase();
}

function userDisplayName(u: User | undefined, fallbackId: string): string {
  if (!u) return fallbackId;
  const name = `${u.firstName || ""} ${u.lastName || ""}`.trim();
  return name || u.email || fallbackId;
}

export default function ManagerTimesheetsPage() {
  const { user: currentUser, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();

  const isAdmin = currentUser?.role === "admin";
  const isManager = currentUser?.role === "manager";
  const canAccess = isAdmin || isManager;

  useEffect(() => {
    if (!authLoading && currentUser && !canAccess) {
      setLocation("/");
    }
  }, [authLoading, currentUser, canAccess, setLocation]);

  const [preset, setPreset] = useState<DateRangePreset>("last_week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const { toast } = useToast();

  // Add/Edit/Delete modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(EMPTY_ADD_FORM);
  const [addError, setAddError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<TimeEntry | null>(null);
  const [editForm, setEditForm] = useState<EditFormState>({
    projectId: "",
    clockIn: "",
    clockOut: "",
    notes: "",
  });
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<TimeEntry | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const range = useMemo(
    () => getDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const queryParams = useMemo(() => {
    const params = new URLSearchParams({
      startDate: range.from.toISOString(),
      endDate: range.to.toISOString(),
    });
    if (projectFilter !== "all") params.set("projectId", projectFilter);
    return params.toString();
  }, [range, projectFilter]);

  const { data: entries, isLoading: entriesLoading } = useQuery<TimeEntry[]>({
    queryKey: ["/api/timesheets", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/timesheets?${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load timesheets");
      return res.json();
    },
    enabled: canAccess,
  });

  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: canAccess,
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: canAccess,
  });

  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users || []) map.set(u.id, u);
    return map;
  }, [users]);

  const projectsById = useMemo(() => {
    const map = new Map<number, Project>();
    for (const p of projects || []) map.set(p.id, p);
    return map;
  }, [projects]);

  const userIdToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users || []) map.set(u.id, userDisplayName(u, u.id));
    return map;
  }, [users]);

  // For "Add entry" user-select: only timesheet-enabled users.
  // Per spec: do NOT default-select the current manager. Sort A→Z; the
  // current manager appears in the list but is not pre-selected.
  const enabledUsers = useMemo(() => {
    return (users || [])
      .filter((u) => u.timesheetEnabled)
      .sort((a, b) =>
        userDisplayName(a, a.id).localeCompare(userDisplayName(b, b.id)),
      );
  }, [users]);

  const summary = useMemo<UserRow[]>(() => {
    if (!entries) return [];
    const byUser = new Map<string, UserRow>();
    for (const entry of entries) {
      const userId = entry.userId;
      if (!byUser.has(userId)) {
        byUser.set(userId, {
          userId,
          user: usersById.get(userId),
          totalHours: 0,
          totalCostCents: 0,
          entryCount: 0,
          activeCount: 0,
          missingRateCount: 0,
          entries: [],
        });
      }
      const row = byUser.get(userId)!;
      row.entryCount += 1;
      row.entries.push(entry);
      const isActive = entry.clockOut == null;
      if (isActive) row.activeCount += 1;
      const hours = hoursFromInterval(entry.clockIn, entry.clockOut, now);
      row.totalHours += hours;
      if (entry.rateCentsSnapshot == null) {
        row.missingRateCount += 1;
      } else {
        row.totalCostCents += Math.round(hours * entry.rateCentsSnapshot);
      }
    }
    return Array.from(byUser.values()).sort((a, b) => {
      const an = userDisplayName(a.user, a.userId).toLowerCase();
      const bn = userDisplayName(b.user, b.userId).toLowerCase();
      return an.localeCompare(bn);
    });
  }, [entries, usersById, now]);

  const totals = useMemo(() => {
    let hours = 0;
    let costCents = 0;
    let active = 0;
    for (const row of summary) {
      hours += row.totalHours;
      costCents += row.totalCostCents;
      active += row.activeCount;
    }
    return { hours, costCents, active, userCount: summary.length };
  }, [summary]);

  const enabledUsersCount = useMemo(
    () => (users || []).filter((u) => u.timesheetEnabled).length,
    [users],
  );

  // Chart data: one bar per user, sorted hours descending. Mirrors the
  // analytics page "Photos by Team Member" pattern.
  const chartData = useMemo(() => {
    return summary
      .map((row) => ({
        name: userDisplayName(row.user, row.userId),
        hours: Number(row.totalHours.toFixed(2)),
        cost: row.totalCostCents,
      }))
      .sort((a, b) => b.hours - a.hours);
  }, [summary]);

  const createMutation = useMutation({
    mutationFn: async (payload: {
      userId: string;
      projectId: number;
      clockIn: string;
      clockOut: string;
      notes: string | null;
    }) => {
      const res = await apiRequest("POST", "/api/timesheets", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
      setAddOpen(false);
      setAddForm(EMPTY_ADD_FORM);
      setAddError(null);
      toast({ title: "Entry added" });
    },
    onError: async (error: any) => {
      // apiRequest throws Error("STATUS: body") for non-2xx
      const msg = String(error?.message || "");
      const overlapMatch = msg.match(/^409:\s*(.+)$/);
      if (overlapMatch) {
        try {
          const parsed = JSON.parse(overlapMatch[1]);
          if (parsed?.error === "overlap") {
            setAddError(parsed.message || "This entry overlaps with an existing entry.");
            return;
          }
        } catch {/* fall through */}
      }
      const display = msg.replace(/^\d+:\s*/, "");
      toast({ title: "Failed to add entry", description: display, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/timesheets/${id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
      setEditTarget(null);
      setEditError(null);
      toast({ title: "Entry updated" });
    },
    onError: (error: any) => {
      const msg = String(error?.message || "");
      const overlapMatch = msg.match(/^409:\s*(.+)$/);
      if (overlapMatch) {
        try {
          const parsed = JSON.parse(overlapMatch[1]);
          if (parsed?.error === "overlap") {
            setEditError(parsed.message || "This entry overlaps with an existing entry.");
            return;
          }
        } catch {/* fall through */}
      }
      const display = msg.replace(/^\d+:\s*/, "");
      toast({ title: "Failed to update entry", description: display, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/timesheets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
      setDeleteTarget(null);
      toast({ title: "Entry deleted" });
    },
    onError: (error: any) => {
      const display = String(error?.message || "Failed to delete entry").replace(/^\d+:\s*/, "");
      toast({ title: "Failed to delete entry", description: display, variant: "destructive" });
    },
  });

  const openAddModal = () => {
    setAddForm(EMPTY_ADD_FORM);
    setAddError(null);
    setAddOpen(true);
  };

  const handleAddSubmit = () => {
    setAddError(null);
    if (!addForm.userId) { setAddError("Select a user."); return; }
    if (!addForm.projectId) { setAddError("Select a project."); return; }
    if (!addForm.clockIn) { setAddError("Clock in is required."); return; }
    if (!addForm.clockOut) { setAddError("Clock out is required."); return; }
    const inDate = new Date(addForm.clockIn);
    const outDate = new Date(addForm.clockOut);
    if (Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime())) {
      setAddError("Enter valid clock in/out times.");
      return;
    }
    if (outDate <= inDate) {
      setAddError("Clock out must be after clock in.");
      return;
    }
    createMutation.mutate({
      userId: addForm.userId,
      projectId: Number(addForm.projectId),
      clockIn: inDate.toISOString(),
      clockOut: outDate.toISOString(),
      notes: addForm.notes.trim() ? addForm.notes.trim() : null,
    });
  };

  const openEditModal = (entry: TimeEntry) => {
    setEditTarget(entry);
    setEditError(null);
    setEditForm({
      projectId: String(entry.projectId),
      clockIn: dateToLocalDatetimeInput(new Date(entry.clockIn)),
      clockOut: entry.clockOut ? dateToLocalDatetimeInput(new Date(entry.clockOut)) : "",
      notes: entry.notes || "",
    });
  };

  const handleEditSubmit = () => {
    if (!editTarget) return;
    setEditError(null);
    if (!editForm.projectId) { setEditError("Select a project."); return; }
    if (!editForm.clockIn) { setEditError("Clock in is required."); return; }
    if (!editForm.clockOut) { setEditError("Clock out is required."); return; }
    const inDate = new Date(editForm.clockIn);
    const outDate = new Date(editForm.clockOut);
    if (Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime())) {
      setEditError("Enter valid clock in/out times.");
      return;
    }
    if (outDate <= inDate) {
      setEditError("Clock out must be after clock in.");
      return;
    }
    updateMutation.mutate({
      id: editTarget.id,
      payload: {
        projectId: Number(editForm.projectId),
        clockIn: inDate.toISOString(),
        clockOut: outDate.toISOString(),
        notes: editForm.notes.trim() ? editForm.notes.trim() : null,
      },
    });
  };

  const handleExport = (format: ExportFormat) => {
    const tz = getBrowserTz();
    const params = new URLSearchParams({
      startDate: range.from.toISOString(),
      endDate: range.to.toISOString(),
      format,
      tz,
    });
    if (projectFilter !== "all") params.set("projectId", projectFilter);
    toast({
      title: "Generating export...",
      description: `${EXPORT_FORMAT_LABELS[format]} • timezone ${tz}`,
    });
    window.location.assign(`/api/timesheets/export.csv?${params.toString()}`);
  };

  if (authLoading || !currentUser || !canAccess) return null;

  const toggleRow = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-manager-timesheets">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
          Timesheets
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track team hours and labor costs across projects.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as DateRangePreset)}>
          <SelectTrigger className="w-[180px]" data-testid="select-date-range">
            <Calendar className="h-4 w-4 mr-2 shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(DATE_RANGE_LABELS) as DateRangePreset[]).map((key) => (
              <SelectItem key={key} value={key} data-testid={`option-range-${key}`}>
                {DATE_RANGE_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={customFrom || formatDateInput(range.from)}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="w-[150px]"
              data-testid="input-custom-from"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="date"
              value={customTo || formatDateInput(range.to)}
              onChange={(e) => setCustomTo(e.target.value)}
              className="w-[150px]"
              data-testid="input-custom-to"
            />
          </div>
        )}
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-[200px]" data-testid="select-project-filter">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="option-project-all">All projects</SelectItem>
            {(projects || []).map((p) => (
              <SelectItem key={p.id} value={String(p.id)} data-testid={`option-project-${p.id}`}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1" data-testid="text-range-summary">
          {formatLocalDateTime(range.from)} – {formatLocalDateTime(range.to)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            onClick={openAddModal}
            className="bg-[#F09000] hover:bg-[#d98000] text-white"
            data-testid="button-add-entry"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add entry
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="button-export-menu"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Export
                    <ChevronDown className="h-4 w-4 ml-1.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => handleExport("generic")}
                    data-testid="menu-export-generic"
                  >
                    Generic CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("gusto")}
                    data-testid="menu-export-gusto"
                  >
                    Gusto CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport("quickbooks")}
                    data-testid="menu-export-quickbooks"
                  >
                    QuickBooks CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipTrigger>
            <TooltipContent>
              Active (clocked-in) entries are excluded from exports.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Clock}
          label="Total hours"
          value={formatHours(totals.hours)}
          testId="stat-total-hours"
        />
        <StatCard
          icon={DollarSign}
          label="Total labor cost"
          value={centsToCurrency(totals.costCents)}
          testId="stat-total-cost"
        />
        <StatCard
          icon={Activity}
          label="Active entries"
          value={String(totals.active)}
          testId="stat-active"
        />
        <StatCard
          icon={Users}
          label="Users tracked"
          value={String(totals.userCount)}
          testId="stat-users"
        />
      </div>

      <div className="flex items-center justify-end gap-1" role="group" aria-label="View mode">
        <Button
          variant={viewMode === "table" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("table")}
          aria-pressed={viewMode === "table"}
          data-testid="button-view-table"
        >
          <TableIcon className="h-4 w-4 mr-1.5" />
          Table
        </Button>
        <Button
          variant={viewMode === "chart" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("chart")}
          aria-pressed={viewMode === "chart"}
          data-testid="button-view-chart"
        >
          <BarChart3 className="h-4 w-4 mr-1.5" />
          Chart
        </Button>
      </div>

      <Card className="overflow-hidden">
        {entriesLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : summary.length === 0 ? (
          <EmptyState enabledUsersCount={enabledUsersCount} />
        ) : viewMode === "chart" ? (
          <HoursChart data={chartData} />
        ) : (
          <Table data-testid="table-timesheets">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]"></TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Total hours</TableHead>
                <TableHead className="text-right">Total labor cost</TableHead>
                <TableHead className="text-right"># Entries</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((row) => {
                const isOpen = expanded.has(row.userId);
                return (
                  <UserRowGroup
                    key={row.userId}
                    row={row}
                    isOpen={isOpen}
                    onToggle={() => toggleRow(row.userId)}
                    projectsById={projectsById}
                    userIdToName={userIdToName}
                    now={now}
                    onEdit={openEditModal}
                    onDelete={(entry) => setDeleteTarget(entry)}
                  />
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Add Entry modal */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open && !createMutation.isPending) {
            setAddOpen(false);
            setAddForm(EMPTY_ADD_FORM);
            setAddError(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-add-entry">
          <DialogHeader>
            <DialogTitle>Add timesheet entry</DialogTitle>
            <DialogDescription>
              Manually record hours for a team member. The user's current hourly rate will be snapshotted onto the entry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-user">User</Label>
              <Select
                value={addForm.userId}
                onValueChange={(v) => setAddForm((p) => ({ ...p, userId: v }))}
              >
                <SelectTrigger id="add-user" data-testid="select-add-user">
                  <SelectValue placeholder="Select user..." />
                </SelectTrigger>
                <SelectContent>
                  {enabledUsers.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No users have timesheet tracking enabled.
                    </div>
                  )}
                  {enabledUsers.map((u) => {
                    const name = userDisplayName(u, u.id);
                    const rateLabel =
                      u.hourlyRateCents != null
                        ? centsToCurrency(u.hourlyRateCents) + "/hr"
                        : "no rate";
                    return (
                      <SelectItem key={u.id} value={u.id} data-testid={`option-add-user-${u.id}`}>
                        {name} — {rateLabel}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-project">Project</Label>
              <Select
                value={addForm.projectId}
                onValueChange={(v) => setAddForm((p) => ({ ...p, projectId: v }))}
              >
                <SelectTrigger id="add-project" data-testid="select-add-project">
                  <SelectValue placeholder="Select project..." />
                </SelectTrigger>
                <SelectContent>
                  {(projects || []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)} data-testid={`option-add-project-${p.id}`}>
                      {p.name}
                      {p.address ? ` — ${p.address}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-clock-in">Clock in</Label>
                <Input
                  id="add-clock-in"
                  type="datetime-local"
                  value={addForm.clockIn}
                  onChange={(e) => setAddForm((p) => ({ ...p, clockIn: e.target.value }))}
                  data-testid="input-add-clock-in"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-clock-out">Clock out</Label>
                <Input
                  id="add-clock-out"
                  type="datetime-local"
                  value={addForm.clockOut}
                  onChange={(e) => setAddForm((p) => ({ ...p, clockOut: e.target.value }))}
                  data-testid="input-add-clock-out"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-notes">Notes (optional)</Label>
              <Textarea
                id="add-notes"
                rows={2}
                value={addForm.notes}
                onChange={(e) => setAddForm((p) => ({ ...p, notes: e.target.value }))}
                data-testid="input-add-notes"
              />
            </div>
            {addError && (
              <p className="text-xs text-destructive" data-testid="text-add-error">
                {addError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={createMutation.isPending}
              data-testid="button-add-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddSubmit}
              disabled={createMutation.isPending}
              className="bg-[#F09000] hover:bg-[#d98000] text-white"
              data-testid="button-add-save"
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Entry modal */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open && !updateMutation.isPending) {
            setEditTarget(null);
            setEditError(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-edit-entry">
          <DialogHeader>
            <DialogTitle>Edit entry</DialogTitle>
            <DialogDescription>
              {editTarget
                ? userIdToName.get(editTarget.userId) || editTarget.userId
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-user-display">User</Label>
              <Input
                id="edit-user-display"
                value={editTarget ? (userIdToName.get(editTarget.userId) || editTarget.userId) : ""}
                disabled
                data-testid="input-edit-user-display"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-project">Project</Label>
              <Select
                value={editForm.projectId}
                onValueChange={(v) => setEditForm((p) => ({ ...p, projectId: v }))}
              >
                <SelectTrigger id="edit-project" data-testid="select-edit-project">
                  <SelectValue placeholder="Select project..." />
                </SelectTrigger>
                <SelectContent>
                  {(projects || []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)} data-testid={`option-edit-project-${p.id}`}>
                      {p.name}
                      {p.address ? ` — ${p.address}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-clock-in">Clock in</Label>
                <Input
                  id="edit-clock-in"
                  type="datetime-local"
                  value={editForm.clockIn}
                  onChange={(e) => setEditForm((p) => ({ ...p, clockIn: e.target.value }))}
                  data-testid="input-edit-clock-in"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-clock-out">Clock out</Label>
                <Input
                  id="edit-clock-out"
                  type="datetime-local"
                  value={editForm.clockOut}
                  onChange={(e) => setEditForm((p) => ({ ...p, clockOut: e.target.value }))}
                  data-testid="input-edit-clock-out"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                rows={2}
                value={editForm.notes}
                onChange={(e) => setEditForm((p) => ({ ...p, notes: e.target.value }))}
                data-testid="input-edit-notes"
              />
            </div>
            {editError && (
              <p className="text-xs text-destructive" data-testid="text-edit-error">
                {editError}
              </p>
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="destructive"
              onClick={() => {
                if (editTarget) {
                  const target = editTarget;
                  setEditTarget(null);
                  setEditError(null);
                  setDeleteTarget(target);
                }
              }}
              disabled={updateMutation.isPending}
              data-testid="button-edit-delete"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete entry
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setEditTarget(null)}
                disabled={updateMutation.isPending}
                data-testid="button-edit-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={handleEditSubmit}
                disabled={updateMutation.isPending}
                className="bg-[#F09000] hover:bg-[#d98000] text-white"
                data-testid="button-edit-save"
              >
                {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save changes
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-delete-entry">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-description">
              {deleteTarget
                ? buildDeleteDescription(deleteTarget, userIdToName, projectsById, now)
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending} data-testid="button-delete-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-confirm"
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function buildDeleteDescription(
  entry: TimeEntry,
  userIdToName: Map<string, string>,
  projectsById: Map<number, Project>,
  now: Date,
): string {
  const userName = userIdToName.get(entry.userId) || entry.userId;
  const projectName = projectsById.get(entry.projectId)?.name || `Project #${entry.projectId}`;
  const isActive = entry.clockOut == null;
  if (isActive) {
    const hours = hoursFromInterval(entry.clockIn, null, now);
    return `Delete entry: ${userName}, ${projectName}, started ${formatLocalDateTime(entry.clockIn)} (currently active, ${formatHours(hours)} so far). This entry is currently active. Deleting it will cancel the in-progress clock-in.`;
  }
  const hours = hoursFromInterval(entry.clockIn, entry.clockOut);
  const costStr =
    entry.rateCentsSnapshot != null
      ? `, ${centsToCurrency(Math.round(hours * entry.rateCentsSnapshot))}`
      : "";
  return `Delete entry: ${userName}, ${projectName}, ${formatLocalDateTime(entry.clockIn)} – ${formatLocalDateTime(entry.clockOut!)} (${formatHours(hours)}${costStr}). This cannot be undone.`;
}

function HoursChart({
  data,
}: {
  data: { name: string; hours: number; cost: number }[];
}) {
  const heightPx = Math.max(280, data.length * 36 + 40);
  return (
    <div className="p-5" data-testid="chart-hours-by-user">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Hours by Team Member</h3>
      </div>
      <ResponsiveContainer width="100%" height={heightPx}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ left: 0, right: 16, top: 0, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            horizontal={false}
            stroke="hsl(var(--border))"
          />
          <XAxis
            type="number"
            tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
          />
          <YAxis
            dataKey="name"
            type="category"
            width={140}
            tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
          />
          <RechartsTooltip
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "6px",
              fontSize: 12,
              color: "hsl(var(--foreground))",
            }}
            formatter={(value: number, _name: string, item: any) => {
              const cost = item?.payload?.cost ?? 0;
              return [
                `${formatHours(value)} • ${centsToCurrency(cost)}`,
                "Hours • Cost",
              ];
            }}
          />
          <Bar
            dataKey="hours"
            fill="hsl(36, 100%, 47%)"
            radius={[0, 4, 4, 0]}
            name="Hours"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
          <p className="text-xl font-semibold mt-1 truncate">{value}</p>
        </div>
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
    </Card>
  );
}

function EmptyState({ enabledUsersCount }: { enabledUsersCount: number }) {
  return (
    <div className="p-12 text-center" data-testid="state-empty">
      <Clock className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
      <p className="text-sm font-medium">No timesheet entries in this range</p>
      <p className="text-xs text-muted-foreground mt-1">
        Try a different date range or project filter.
      </p>
      {enabledUsersCount === 0 && (
        <p className="text-xs text-muted-foreground mt-3" data-testid="text-enable-hint">
          Enable timesheet tracking for users on the{" "}
          <Link href="/team" className="text-[#F09000] hover:underline" data-testid="link-team">
            Team page
          </Link>{" "}
          to start collecting hours.
        </p>
      )}
    </div>
  );
}

function UserRowGroup({
  row,
  isOpen,
  onToggle,
  projectsById,
  userIdToName,
  now,
  onEdit,
  onDelete,
}: {
  row: UserRow;
  isOpen: boolean;
  onToggle: () => void;
  projectsById: Map<number, Project>;
  userIdToName: Map<string, string>;
  now: Date;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (entry: TimeEntry) => void;
}) {
  const name = userDisplayName(row.user, row.userId);
  const initials = userInitials(row.user);
  const ChevronIcon = isOpen ? ChevronDown : ChevronRight;
  const detailId = `timesheet-detail-${row.userId}`;
  const missingLabel =
    row.missingRateCount > 0
      ? `${row.missingRateCount} ${row.missingRateCount === 1 ? "entry" : "entries"} missing hourly rate`
      : "";
  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={onToggle}
        data-testid={`row-user-${row.userId}`}
      >
        <TableCell className="py-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={isOpen}
            aria-controls={detailId}
            aria-label={`${isOpen ? "Collapse" : "Expand"} entries for ${name}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`button-expand-${row.userId}`}
          >
            <ChevronIcon className="h-4 w-4 text-muted-foreground" />
          </button>
        </TableCell>
        <TableCell className="py-2">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar className="h-7 w-7">
              <AvatarImage src={row.user?.profileImageUrl || undefined} alt={name} />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <span className="font-medium truncate" data-testid={`text-user-name-${row.userId}`}>
              {name}
            </span>
            {row.activeCount > 0 && <ActiveBadge />}
          </div>
        </TableCell>
        <TableCell className="text-right py-2 tabular-nums" data-testid={`text-hours-${row.userId}`}>
          {formatHours(row.totalHours)}
        </TableCell>
        <TableCell className="text-right py-2 tabular-nums" data-testid={`text-cost-${row.userId}`}>
          <div className="inline-flex items-center gap-1.5 justify-end">
            <span>{centsToCurrency(row.totalCostCents)}</span>
            {row.missingRateCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    aria-label={missingLabel}
                    data-testid={`icon-missing-rate-${row.userId}`}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    <span className="sr-only">{missingLabel}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{missingLabel}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right py-2 tabular-nums" data-testid={`text-entries-${row.userId}`}>
          {row.entryCount}
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow id={detailId} data-testid={`row-detail-${row.userId}`}>
          <TableCell colSpan={5} className="bg-muted/30 p-0">
            <NestedEntries
              entries={row.entries}
              projectsById={projectsById}
              userIdToName={userIdToName}
              now={now}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ActiveBadge() {
  return (
    <Badge
      variant="secondary"
      className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 gap-1.5 px-2 py-0 h-5 text-[10px] font-medium"
      data-testid="badge-active"
      aria-label="Currently clocked in"
    >
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
      </span>
      Live
    </Badge>
  );
}

function NestedEntries({
  entries,
  projectsById,
  userIdToName,
  now,
  onEdit,
  onDelete,
}: {
  entries: TimeEntry[];
  projectsById: Map<number, Project>;
  userIdToName: Map<string, string>;
  now: Date;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (entry: TimeEntry) => void;
}) {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.clockIn).getTime() - new Date(a.clockIn).getTime(),
  );
  return (
    <div className="px-4 py-3">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-border/50">
            <TableHead className="text-xs">Project</TableHead>
            <TableHead className="text-xs">Clock in</TableHead>
            <TableHead className="text-xs">Clock out</TableHead>
            <TableHead className="text-right text-xs">Duration</TableHead>
            <TableHead className="text-right text-xs">Rate</TableHead>
            <TableHead className="text-right text-xs">Cost</TableHead>
            <TableHead className="text-xs">Source</TableHead>
            <TableHead className="text-xs">Notes</TableHead>
            <TableHead className="text-right text-xs">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((entry) => {
            const project = projectsById.get(entry.projectId);
            const isActive = entry.clockOut == null;
            const hours = hoursFromInterval(entry.clockIn, entry.clockOut, now);
            const hasRate = entry.rateCentsSnapshot != null;
            const costCents = hasRate ? Math.round(hours * (entry.rateCentsSnapshot as number)) : null;
            return (
              <TableRow
                key={entry.id}
                className={isActive ? "bg-green-50/40 dark:bg-green-900/10" : undefined}
                data-testid={`row-entry-${entry.id}`}
              >
                <TableCell className="py-1.5 text-xs">
                  {project ? (
                    <Link
                      href={`/projects/${project.id}`}
                      className="text-foreground hover:underline"
                      data-testid={`link-project-${entry.id}`}
                    >
                      {project.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Project #{entry.projectId}</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs whitespace-nowrap">
                  {formatLocalDateTime(entry.clockIn)}
                </TableCell>
                <TableCell className="py-1.5 text-xs whitespace-nowrap">
                  {entry.clockOut ? (
                    formatLocalDateTime(entry.clockOut)
                  ) : (
                    <span className="text-muted-foreground italic">Active</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-right tabular-nums">
                  {isActive ? (
                    <span className="text-green-700 dark:text-green-400">
                      {formatHours(hours)} so far
                    </span>
                  ) : (
                    formatHours(hours)
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-right tabular-nums">
                  {hasRate ? (
                    centsToCurrency(entry.rateCentsSnapshot)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-right tabular-nums">
                  {costCents == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : isActive ? (
                    <span className="text-green-700 dark:text-green-400">
                      {centsToCurrency(costCents)}{" "}
                      <span className="text-muted-foreground">(in progress)</span>
                    </span>
                  ) : (
                    centsToCurrency(costCents)
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge
                      variant="secondary"
                      className={`${SOURCE_BADGE_CLASS[entry.source] || "bg-muted"} text-[10px] px-1.5 py-0 h-5`}
                    >
                      {SOURCE_LABELS[entry.source] || entry.source}
                    </Badge>
                    {entry.editedAt && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-5 text-muted-foreground cursor-help"
                            data-testid={`badge-edited-${entry.id}`}
                          >
                            Edited
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          Edited by{" "}
                          {entry.editedByUserId
                            ? userIdToName.get(entry.editedByUserId) || "unknown"
                            : "unknown"}{" "}
                          on {formatLocalDateTime(entry.editedAt)}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </TableCell>
                <TableCell className="py-1.5 text-xs max-w-[200px]">
                  {entry.notes ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block truncate text-muted-foreground cursor-help">
                          {entry.notes}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">{entry.notes}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-right">
                  <div className="inline-flex items-center gap-0.5">
                    {isActive ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* span needed for tooltip on disabled button */}
                          <span className="inline-block">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              disabled
                              data-testid={`button-edit-entry-${entry.id}`}
                              aria-label="Edit entry (disabled — entry is active)"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          Cannot edit an active entry — clock the user out first
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => onEdit(entry)}
                            data-testid={`button-edit-entry-${entry.id}`}
                            aria-label="Edit entry"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit entry</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => onDelete(entry)}
                          data-testid={`button-delete-entry-${entry.id}`}
                          aria-label="Delete entry"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete entry</TooltipContent>
                    </Tooltip>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
