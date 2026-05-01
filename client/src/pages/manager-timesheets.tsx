import { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
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
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  AlertTriangle,
  Users,
  Activity,
} from "lucide-react";
import type { TimeEntry, User, Project } from "@shared/schema";
import { centsToCurrency } from "@/lib/money";
import { formatHours, hoursFromInterval, formatLocalDateTime } from "@/lib/duration";
import {
  DATE_RANGE_LABELS,
  formatDateInput,
  getDateRange,
  type DateRangePreset,
} from "@/lib/date-range";

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

      <Card className="overflow-hidden">
        {entriesLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : summary.length === 0 ? (
          <EmptyState enabledUsersCount={enabledUsersCount} />
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
                    now={now}
                  />
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
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
  now,
}: {
  row: UserRow;
  isOpen: boolean;
  onToggle: () => void;
  projectsById: Map<number, Project>;
  now: Date;
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
            <NestedEntries entries={row.entries} projectsById={projectsById} now={now} />
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
  now,
}: {
  entries: TimeEntry[];
  projectsById: Map<number, Project>;
  now: Date;
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
                  <Badge
                    variant="secondary"
                    className={`${SOURCE_BADGE_CLASS[entry.source] || "bg-muted"} text-[10px] px-1.5 py-0 h-5`}
                  >
                    {SOURCE_LABELS[entry.source] || entry.source}
                  </Badge>
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
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
