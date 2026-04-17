import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronLeft, ChevronRight, ClipboardList, ClipboardCheck, Calendar as CalendarIcon,
  Plus, X, Users, Clock, Repeat, MapPin, AlignLeft, FolderKanban, Loader2, RefreshCw, AlertCircle, Trash2, Check, ChevronsUpDown,
} from "lucide-react";

type CalendarEventItem = {
  id: string;
  rawId?: number;
  type: "task" | "checklist" | "event";
  title: string;
  date: string;
  endsAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  attendees?: string[];
  repeat?: string;
  status: string;
  priority: string | null;
  projectId: number | null;
  projectName: string;
  color: string;
  assignedTo: string | null;
  syncMessage?: string | null;
};

type ProjectLite = { id: number; name: string; color: string | null; address?: string | null };

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  not_started: "Not Started",
  completed: "Completed",
  pending: "Sync pending",
  synced: "Synced",
  failed: "Sync failed",
  disabled: "Local only",
};

const repeatLabels: Record<string, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d: Date, n: number) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function buildMonthGrid(viewDate: Date): Date[] {
  const first = startOfMonth(viewDate);
  const startWeekday = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startWeekday);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}
function toDateInputValue(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function combineDateAndTime(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
}
function nextHalfHour(d: Date): Date {
  const out = new Date(d);
  out.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return out;
}
function formatTime(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type ConnectionLite = { id: number; provider: string; status: string };

function ProjectCombobox({
  projects,
  value,
  onChange,
}: {
  projects: ProjectLite[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value === "none" ? null : projects.find(p => String(p.id) === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="min-w-[240px] justify-between font-normal"
          data-testid="select-event-project"
        >
          {selected ? (
            <span className="flex items-center gap-2 truncate">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: selected.color || "#F09000" }} />
              <span className="truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Link to a project (optional)</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search projects..." data-testid="input-project-search" />
          <CommandList>
            <CommandEmpty>
              {projects.length === 0 ? "No projects yet. Create one first." : "No matching projects."}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="no project"
                onSelect={() => { onChange("none"); setOpen(false); }}
                data-testid="option-project-none"
              >
                <Check className={`mr-2 h-4 w-4 ${value === "none" ? "opacity-100" : "opacity-0"}`} />
                <span className="text-muted-foreground">No project</span>
              </CommandItem>
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.address || ""}`}
                  onSelect={() => { onChange(String(p.id)); setOpen(false); }}
                  data-testid={`option-project-${p.id}`}
                >
                  <Check className={`mr-2 h-4 w-4 ${String(p.id) === value ? "opacity-100" : "opacity-0"}`} />
                  <span className="h-2.5 w-2.5 rounded-full mr-2 shrink-0" style={{ backgroundColor: p.color || "#F09000" }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{p.name}</p>
                    {p.address && <p className="truncate text-xs text-muted-foreground">{p.address}</p>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function NewEventDialog({
  open,
  onOpenChange,
  initialDate,
  projects,
  connections,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialDate: Date;
  projects: ProjectLite[];
  connections: ConnectionLite[];
}) {
  const { toast } = useToast();
  const startSeed = nextHalfHour(initialDate);
  const endSeed = new Date(startSeed.getTime() + 30 * 60 * 1000);

  const [title, setTitle] = useState("");
  const [attendeesInput, setAttendeesInput] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
  const [date, setDate] = useState(toDateInputValue(startSeed));
  const [startTime, setStartTime] = useState(`${String(startSeed.getHours()).padStart(2, "0")}:${String(startSeed.getMinutes()).padStart(2, "0")}`);
  const [endTime, setEndTime] = useState(`${String(endSeed.getHours()).padStart(2, "0")}:${String(endSeed.getMinutes()).padStart(2, "0")}`);
  const [allDay, setAllDay] = useState(false);
  const [repeat, setRepeat] = useState("none");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("none");
  const [pushToConnected, setPushToConnected] = useState(true);

  const reset = () => {
    setTitle(""); setAttendeesInput(""); setAttendees([]);
    setDate(toDateInputValue(startSeed));
    setStartTime(`${String(startSeed.getHours()).padStart(2, "0")}:${String(startSeed.getMinutes()).padStart(2, "0")}`);
    setEndTime(`${String(endSeed.getHours()).padStart(2, "0")}:${String(endSeed.getMinutes()).padStart(2, "0")}`);
    setAllDay(false); setRepeat("none"); setLocation(""); setDescription(""); setProjectId("none"); setPushToConnected(true);
  };

  const addAttendee = () => {
    const trimmed = attendeesInput.trim().replace(/,$/, "");
    if (!trimmed) return;
    if (!/.+@.+\..+/.test(trimmed)) {
      toast({ title: "Invalid email", description: trimmed, variant: "destructive" });
      return;
    }
    if (!attendees.includes(trimmed)) setAttendees([...attendees, trimmed]);
    setAttendeesInput("");
  };

  const createEvent = useMutation({
    mutationFn: async () => {
      const startsAt = allDay ? combineDateAndTime(date, "00:00") : combineDateAndTime(date, startTime);
      const endsAt = allDay ? combineDateAndTime(date, "23:59") : combineDateAndTime(date, endTime);
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        allDay,
        repeat,
        attendees,
        projectId: projectId === "none" ? null : Number(projectId),
        pushToConnected,
      };
      const res = await apiRequest("POST", "/api/calendar-events", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-events"] });
      const msg = data?.syncMessage || "Event saved.";
      toast({ title: "Event created", description: msg });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't create event", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!title.trim()) {
      toast({ title: "Add a title for the event", variant: "destructive" });
      return;
    }
    if (!allDay && combineDateAndTime(date, endTime) <= combineDateAndTime(date, startTime)) {
      toast({ title: "End time must be after start time", variant: "destructive" });
      return;
    }
    createEvent.mutate();
  };

  const activeConnectionLabel = connections.length > 0
    ? connections.map(c => c.provider).join(", ")
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden border-0 [&>button]:hidden"
        data-testid="dialog-new-event"
        onPointerDownOutside={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".pac-container") || t.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".pac-container") || t.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
        onFocusOutside={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".pac-container") || t.closest("[data-radix-popper-content-wrapper]")) {
            e.preventDefault();
          }
        }}
      >
        <div className="bg-primary px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-primary-foreground">
            <CalendarIcon className="h-5 w-5" />
            <DialogTitle className="text-primary-foreground text-base font-semibold">New event</DialogTitle>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              className="bg-white text-primary hover:bg-white/90"
              onClick={handleSave}
              disabled={createEvent.isPending}
              data-testid="button-save-event"
            >
              {createEvent.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
            <DialogClose asChild>
              <button
                className="text-white opacity-90 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-white rounded-sm"
                aria-label="Close"
                data-testid="button-close-event"
              >
                <X className="h-5 w-5" />
              </button>
            </DialogClose>
          </div>
        </div>

        <DialogHeader className="sr-only">
          <DialogTitle>New event</DialogTitle>
        </DialogHeader>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="flex items-start gap-3">
            <div className="h-3 w-3 rounded-full bg-primary mt-2 shrink-0" />
            <div className="flex-1 min-w-0">
              <Label className="text-xs text-muted-foreground">Calendar</Label>
              <p className="text-sm font-medium">FieldView calendar</p>
              {activeConnectionLabel && (
                <p className="text-xs text-muted-foreground">Connected: {activeConnectionLabel}</p>
              )}
            </div>
          </div>

          <div>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a title"
              className="text-lg font-semibold border-0 border-b rounded-none px-0 focus-visible:ring-0 focus-visible:border-primary"
              data-testid="input-event-title"
            />
          </div>

          <div className="flex items-start gap-3">
            <Users className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {attendees.map((a) => (
                  <Badge key={a} variant="secondary" className="gap-1 pr-1 no-default-hover-elevate no-default-active-elevate">
                    {a}
                    <button
                      onClick={() => setAttendees(attendees.filter(x => x !== a))}
                      className="hover:text-destructive"
                      data-testid={`button-remove-attendee-${a}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <Input
                value={attendeesInput}
                onChange={(e) => setAttendeesInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addAttendee();
                  }
                }}
                onBlur={addAttendee}
                placeholder="Add people by email"
                data-testid="input-event-attendees"
              />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Clock className="h-4 w-4 mt-2.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-[auto_auto_1fr_auto_1fr_auto] gap-2 items-center">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-auto"
                data-testid="input-event-date"
              />
              <span className="text-xs text-muted-foreground hidden sm:inline">from</span>
              <Input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={allDay}
                data-testid="input-event-start-time"
              />
              <span className="text-xs text-muted-foreground hidden sm:inline">to</span>
              <Input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={allDay}
                data-testid="input-event-end-time"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground whitespace-nowrap">
                <Switch checked={allDay} onCheckedChange={setAllDay} data-testid="switch-event-all-day" />
                All day
              </label>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Repeat className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={repeat} onValueChange={setRepeat}>
              <SelectTrigger className="w-auto min-w-[180px]" data-testid="select-event-repeat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(repeatLabels).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <FolderKanban className="h-4 w-4 text-muted-foreground shrink-0" />
            <ProjectCombobox
              projects={projects}
              value={projectId}
              onChange={(id) => {
                setProjectId(id);
                if (id !== "none") {
                  const p = projects.find(pp => String(pp.id) === id);
                  if (p?.address && !location.trim()) {
                    setLocation(p.address);
                  }
                }
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <AddressAutocomplete
                value={location}
                onTextChange={setLocation}
                onChange={(r) => setLocation(r.address)}
                placeholder="Add a location"
                data-testid="input-event-location"
              />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <AlignLeft className="h-4 w-4 mt-2 text-muted-foreground shrink-0" />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add notes or a description"
              rows={3}
              className="resize-none"
              data-testid="textarea-event-description"
            />
          </div>

          <div className="rounded-md border p-3 flex items-start gap-3 bg-muted/30">
            <RefreshCw className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Push to connected calendars</p>
                <Switch
                  checked={pushToConnected}
                  onCheckedChange={setPushToConnected}
                  data-testid="switch-event-push"
                />
              </div>
              {connections.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                  No calendars are linked yet. Connect Google, Outlook, or Apple from Settings to enable two-way sync.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  This event will be sent to {connections.map(c => c.provider).join(", ")} so it appears alongside your other appointments.
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CalendarPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [viewDate, setViewDate] = useState<Date>(startOfMonth(new Date()));
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [newEventDate, setNewEventDate] = useState<Date>(new Date());
  const today = new Date();

  const { data: events, isLoading } = useQuery<CalendarEventItem[]>({
    queryKey: ["/api/calendar/events"],
  });

  const { data: projects } = useQuery<ProjectLite[]>({
    queryKey: ["/api/projects"],
  });

  const { data: connections } = useQuery<ConnectionLite[]>({
    queryKey: ["/api/calendar-connections"],
  });

  const deleteEvent = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/calendar-events/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
      toast({ title: "Event deleted" });
    },
  });

  const days = useMemo(() => buildMonthGrid(viewDate), [viewDate]);

  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEventItem[]> = {};
    (events || []).forEach((e) => {
      const d = new Date(e.date);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[key]) map[key] = [];
      map[key].push(e);
    });
    return map;
  }, [events]);

  const monthEvents = useMemo(() => {
    return (events || []).filter(e => {
      const d = new Date(e.date);
      return d.getFullYear() === viewDate.getFullYear() && d.getMonth() === viewDate.getMonth();
    }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [events, viewDate]);

  const goPrev = () => setViewDate(addMonths(viewDate, -1));
  const goNext = () => setViewDate(addMonths(viewDate, 1));
  const goToday = () => setViewDate(startOfMonth(new Date()));

  const openNewEvent = (forDate?: Date) => {
    setNewEventDate(forDate || new Date());
    setNewEventOpen(true);
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-calendar-title">Calendar</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(events || []).length} item{(events || []).length === 1 ? "" : "s"} scheduled across all projects
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={goToday} data-testid="button-today">Today</Button>
          <Button
            size="sm"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => openNewEvent()}
            data-testid="button-new-event"
          >
            <Plus className="h-4 w-4 mr-1" /> New Event
          </Button>
          <Button variant="ghost" size="icon" onClick={goPrev} data-testid="button-prev-month"><ChevronLeft className="h-4 w-4" /></Button>
          <div className="text-sm font-semibold min-w-[140px] text-center" data-testid="text-month-label">
            {MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}
          </div>
          <Button variant="ghost" size="icon" onClick={goNext} data-testid="button-next-month"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <Card className="flex-1 overflow-hidden flex flex-col" data-testid="card-calendar-grid">
        <div className="grid grid-cols-7 border-b bg-muted/30">
          {WEEKDAYS.map((d) => (
            <div key={d} className="p-2 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {d}
            </div>
          ))}
        </div>
        {isLoading ? (
          <div className="flex-1 grid grid-cols-7 grid-rows-6">
            {Array.from({ length: 42 }).map((_, i) => (
              <Skeleton key={i} className="m-1 rounded" />
            ))}
          </div>
        ) : (
          <div className="flex-1 grid grid-cols-7 grid-rows-6 min-h-0">
            {days.map((day, idx) => {
              const isCurrentMonth = day.getMonth() === viewDate.getMonth();
              const isToday = isSameDay(day, today);
              const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
              const dayEvents = eventsByDay[key] || [];
              return (
                <div
                  key={idx}
                  className={`group border-r border-b p-1.5 overflow-hidden flex flex-col gap-1 min-h-0 ${
                    !isCurrentMonth ? "bg-muted/20" : ""
                  }`}
                  data-testid={`day-${key}`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-semibold inline-flex h-6 w-6 items-center justify-center rounded-full ${
                        isToday
                          ? "bg-primary text-primary-foreground"
                          : isCurrentMonth
                          ? "text-foreground"
                          : "text-muted-foreground/50"
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-opacity"
                      onClick={() => openNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))}
                      data-testid={`button-add-event-${key}`}
                      aria-label="Add event"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                    {dayEvents.slice(0, 3).map((event) => (
                      <Popover key={event.id}>
                        <PopoverTrigger asChild>
                          <button
                            className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate font-medium hover-elevate"
                            style={{
                              backgroundColor: `${event.color}20`,
                              color: event.color,
                              borderLeft: `3px solid ${event.color}`,
                            }}
                            data-testid={`event-${event.id}`}
                          >
                            {event.title}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72" align="start">
                          <div className="space-y-2">
                            <div className="flex items-start gap-2">
                              {event.type === "task" ? (
                                <ClipboardList className="h-4 w-4 mt-0.5 shrink-0" style={{ color: event.color }} />
                              ) : event.type === "checklist" ? (
                                <ClipboardCheck className="h-4 w-4 mt-0.5 shrink-0" style={{ color: event.color }} />
                              ) : (
                                <CalendarIcon className="h-4 w-4 mt-0.5 shrink-0" style={{ color: event.color }} />
                              )}
                              <div className="min-w-0">
                                <p className="font-semibold text-sm">{event.title}</p>
                                {event.projectName && (
                                  <p className="text-xs text-muted-foreground">{event.projectName}</p>
                                )}
                              </div>
                            </div>
                            {event.type === "event" && !event.allDay && (
                              <p className="text-xs text-muted-foreground">
                                {formatTime(event.date)}{event.endsAt ? ` - ${formatTime(event.endsAt)}` : ""}
                              </p>
                            )}
                            {event.location && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1">
                                <MapPin className="h-3 w-3" /> {event.location}
                              </p>
                            )}
                            {event.attendees && event.attendees.length > 0 && (
                              <p className="text-xs text-muted-foreground flex items-start gap-1">
                                <Users className="h-3 w-3 mt-0.5" />
                                <span className="break-all">{event.attendees.join(", ")}</span>
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                              <Badge variant="secondary" className="text-xs">
                                {statusLabels[event.status] || event.status}
                              </Badge>
                              {event.priority && (
                                <Badge variant="outline" className="text-xs capitalize">{event.priority}</Badge>
                              )}
                              {event.repeat && event.repeat !== "none" && (
                                <Badge variant="outline" className="text-xs">{repeatLabels[event.repeat]}</Badge>
                              )}
                            </div>
                            {event.syncMessage && (
                              <p className="text-xs text-muted-foreground italic">{event.syncMessage}</p>
                            )}
                            <div className="flex gap-2">
                              {event.projectId && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() => navigate(`/projects/${event.projectId}`)}
                                  data-testid={`button-open-project-${event.projectId}`}
                                >
                                  Open project
                                </Button>
                              )}
                              {event.type === "event" && event.rawId && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => deleteEvent.mutate(event.rawId!)}
                                  data-testid={`button-delete-event-${event.rawId}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    ))}
                    {dayEvents.length > 3 && (
                      <div className="text-[10px] text-muted-foreground px-1.5">
                        +{dayEvents.length - 3} more
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {monthEvents.length > 0 && (
        <Card className="p-4" data-testid="card-month-list">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-primary" />
            This month ({monthEvents.length})
          </h2>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {monthEvents.map((event) => {
              const d = new Date(event.date);
              return (
                <button
                  key={event.id}
                  onClick={() => event.projectId && navigate(`/projects/${event.projectId}`)}
                  className="w-full flex items-center gap-3 p-2 rounded text-left hover-elevate"
                  data-testid={`list-event-${event.id}`}
                >
                  <div
                    className="h-9 w-9 rounded shrink-0 flex flex-col items-center justify-center text-xs font-semibold"
                    style={{ backgroundColor: `${event.color}20`, color: event.color }}
                  >
                    <span className="text-[9px] uppercase leading-none">{MONTHS[d.getMonth()].slice(0, 3)}</span>
                    <span className="text-sm leading-none">{d.getDate()}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {event.type === "task" ? (
                        <ClipboardList className="h-3 w-3 text-muted-foreground shrink-0" />
                      ) : event.type === "checklist" ? (
                        <ClipboardCheck className="h-3 w-3 text-muted-foreground shrink-0" />
                      ) : (
                        <CalendarIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <p className="text-sm font-medium truncate">{event.title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {event.projectName || (event.type === "event" ? "Personal event" : "")}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate">
                    {statusLabels[event.status] || event.status}
                  </Badge>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <NewEventDialog
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        initialDate={newEventDate}
        projects={projects || []}
        connections={connections || []}
      />
    </div>
  );
}
