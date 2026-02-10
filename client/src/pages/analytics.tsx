import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  BarChart3,
  Camera,
  FolderKanban,
  Users,
  ClipboardCheck,
  FileBarChart,
  MessageSquare,
  TrendingUp,
  MapPin,
  Calendar,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

type PeriodPreset = "7d" | "30d" | "90d" | "365d" | "all" | "custom";

function getDateRange(preset: PeriodPreset, customFrom?: string, customTo?: string) {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86400000).toISOString(), to };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86400000).toISOString(), to };
    case "90d":
      return { from: new Date(now.getTime() - 90 * 86400000).toISOString(), to };
    case "365d":
      return { from: new Date(now.getTime() - 365 * 86400000).toISOString(), to };
    case "all":
      return { from: new Date("2020-01-01").toISOString(), to };
    case "custom":
      return {
        from: customFrom ? new Date(customFrom).toISOString() : new Date(now.getTime() - 30 * 86400000).toISOString(),
        to: customTo ? new Date(customTo + "T23:59:59").toISOString() : to,
      };
    default:
      return { from: new Date(now.getTime() - 30 * 86400000).toISOString(), to };
  }
}

const CHART_COLORS = [
  "hsl(36, 100%, 47%)",
  "hsl(140, 50%, 35%)",
  "hsl(25, 100%, 40%)",
  "hsl(200, 70%, 45%)",
  "hsl(0, 65%, 45%)",
  "hsl(270, 50%, 50%)",
  "hsl(180, 55%, 40%)",
  "hsl(45, 90%, 48%)",
];

const TASK_STATUS_COLORS: Record<string, string> = {
  pending: "hsl(36, 100%, 47%)",
  "in-progress": "hsl(200, 70%, 45%)",
  completed: "hsl(140, 50%, 35%)",
  blocked: "hsl(0, 65%, 45%)",
};

interface AnalyticsData {
  totalPhotos: number;
  totalProjects: number;
  totalTasks: number;
  totalChecklists: number;
  totalReports: number;
  totalComments: number;
  activeUsers: number;
  photosByUser: { name: string; count: number }[];
  photosOverTime: { date: string; count: number }[];
  photoLocations: { id: number; latitude: number; longitude: number; projectId: number }[];
  photosByProject: { name: string; count: number }[];
  tasksByStatus: Record<string, number>;
}

function StatCard({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: typeof Camera;
  label: string;
  value: string | number;
  testId: string;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold" data-testid={`${testId}-value`}>{value}</p>
          <p className="text-xs text-muted-foreground truncate">{label}</p>
        </div>
      </div>
    </Card>
  );
}

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<PeriodPreset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const dateRange = useMemo(
    () => getDateRange(period, customFrom, customTo),
    [period, customFrom, customTo]
  );

  const analyticsUrl = `/api/analytics?from=${encodeURIComponent(dateRange.from)}&to=${encodeURIComponent(dateRange.to)}`;

  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: [analyticsUrl],
  });

  const formattedTimeline = useMemo(() => {
    if (!data?.photosOverTime) return [];
    return data.photosOverTime.map((d) => ({
      ...d,
      label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    }));
  }, [data?.photosOverTime]);

  const taskStatusData = useMemo(() => {
    if (!data?.tasksByStatus) return [];
    return Object.entries(data.tasksByStatus).map(([status, count]) => ({
      name: status.charAt(0).toUpperCase() + status.slice(1).replace("-", " "),
      value: count,
      color: TASK_STATUS_COLORS[status] || "hsl(0, 0%, 50%)",
    }));
  }, [data?.tasksByStatus]);

  const mapCenter = useMemo(() => {
    if (!data?.photoLocations?.length) return [39.8283, -98.5795] as [number, number];
    const lats = data.photoLocations.map((l) => l.latitude);
    const lngs = data.photoLocations.map((l) => l.longitude);
    return [
      lats.reduce((a, b) => a + b, 0) / lats.length,
      lngs.reduce((a, b) => a + b, 0) / lngs.length,
    ] as [number, number];
  }, [data?.photoLocations]);

  const periodLabel = {
    "7d": "Last 7 Days",
    "30d": "Last 30 Days",
    "90d": "Last 90 Days",
    "365d": "Last Year",
    all: "All Time",
    custom: "Custom Range",
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-analytics-title">
            Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track your team's activity and project progress
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodPreset)}>
            <SelectTrigger className="w-[160px]" data-testid="select-period">
              <Calendar className="h-4 w-4 mr-2 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
              <SelectItem value="365d">Last Year</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>
          {period === "custom" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-[140px]"
                data-testid="input-date-from"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-[140px]"
                data-testid="input-date-to"
              />
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-[88px]" />
            ))}
          </div>
          <div className="grid lg:grid-cols-2 gap-6">
            <Skeleton className="h-[350px]" />
            <Skeleton className="h-[350px]" />
          </div>
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard icon={Camera} label="Photos" value={data.totalPhotos} testId="stat-photos" />
            <StatCard icon={FolderKanban} label="Projects" value={data.totalProjects} testId="stat-projects" />
            <StatCard icon={Users} label="Active Users" value={data.activeUsers} testId="stat-users" />
            <StatCard icon={TrendingUp} label="Tasks" value={data.totalTasks} testId="stat-tasks" />
            <StatCard icon={ClipboardCheck} label="Checklists" value={data.totalChecklists} testId="stat-checklists" />
            <StatCard icon={FileBarChart} label="Reports" value={data.totalReports} testId="stat-reports" />
            <StatCard icon={MessageSquare} label="Comments" value={data.totalComments} testId="stat-comments" />
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card className="p-5" data-testid="chart-photos-by-user">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Photos by Team Member</h3>
              </div>
              {data.photosByUser.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={data.photosByUser} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      width={100}
                      tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "6px",
                        fontSize: 12,
                        color: "hsl(var(--foreground))",
                      }}
                    />
                    <Bar dataKey="count" fill="hsl(36, 100%, 47%)" radius={[0, 4, 4, 0]} name="Photos" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
                  No photo data for this period
                </div>
              )}
            </Card>

            <Card className="p-5" data-testid="chart-photos-over-time">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Photos Over Time</h3>
              </div>
              {formattedTimeline.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={formattedTimeline} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "6px",
                        fontSize: 12,
                        color: "hsl(var(--foreground))",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="hsl(36, 100%, 47%)"
                      strokeWidth={2}
                      dot={{ fill: "hsl(36, 100%, 47%)", r: 3 }}
                      activeDot={{ r: 5 }}
                      name="Photos"
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
                  No photo data for this period
                </div>
              )}
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card className="p-5" data-testid="chart-photo-map">
              <div className="flex items-center gap-2 mb-4">
                <MapPin className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Photo Locations</h3>
                <span className="text-xs text-muted-foreground ml-auto">
                  {data.photoLocations.length} geotagged
                </span>
              </div>
              <div className="h-[300px] rounded-md overflow-hidden">
                <MapContainer
                  center={mapCenter}
                  zoom={data.photoLocations.length > 0 ? 10 : 4}
                  className="h-full w-full"
                  scrollWheelZoom={true}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  {data.photoLocations.map((loc) => (
                    <CircleMarker
                      key={loc.id}
                      center={[loc.latitude, loc.longitude]}
                      radius={6}
                      pathOptions={{
                        fillColor: "hsl(36, 100%, 47%)",
                        color: "hsl(36, 100%, 35%)",
                        weight: 1,
                        fillOpacity: 0.8,
                      }}
                    >
                      <Popup>
                        <span className="text-xs">Photo #{loc.id}</span>
                      </Popup>
                    </CircleMarker>
                  ))}
                </MapContainer>
              </div>
            </Card>

            <div className="space-y-6">
              <Card className="p-5" data-testid="chart-photos-by-project">
                <div className="flex items-center gap-2 mb-4">
                  <FolderKanban className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Photos by Project</h3>
                </div>
                {data.photosByProject.length > 0 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={data.photosByProject.slice(0, 6)} margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="name"
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        interval={0}
                        angle={-20}
                        textAnchor="end"
                        height={50}
                      />
                      <YAxis tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                          fontSize: 12,
                          color: "hsl(var(--foreground))",
                        }}
                      />
                      <Bar dataKey="count" name="Photos" radius={[4, 4, 0, 0]}>
                        {data.photosByProject.slice(0, 6).map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
                    No project data for this period
                  </div>
                )}
              </Card>

              <Card className="p-5" data-testid="chart-tasks-by-status">
                <div className="flex items-center gap-2 mb-4">
                  <ClipboardCheck className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Tasks by Status</h3>
                </div>
                {taskStatusData.length > 0 ? (
                  <div className="flex items-center gap-6">
                    <ResponsiveContainer width="100%" height={140}>
                      <PieChart>
                        <Pie
                          data={taskStatusData}
                          cx="50%"
                          cy="50%"
                          innerRadius={35}
                          outerRadius={60}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {taskStatusData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: "6px",
                            fontSize: 12,
                            color: "hsl(var(--foreground))",
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex-1 space-y-2">
                      {taskStatusData.map((entry) => (
                        <div key={entry.name} className="flex items-center justify-between gap-4 text-sm">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: entry.color }}
                            />
                            <span>{entry.name}</span>
                          </div>
                          <span className="font-medium">{entry.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="h-[140px] flex items-center justify-center text-sm text-muted-foreground">
                    No task data for this period
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
