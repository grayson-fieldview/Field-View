import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronLeft, ChevronRight, ClipboardList, ClipboardCheck, Calendar as CalendarIcon } from "lucide-react";

type CalendarEvent = {
  id: string;
  type: "task" | "checklist";
  title: string;
  date: string;
  status: string;
  priority: string | null;
  projectId: number;
  projectName: string;
  color: string;
  assignedTo: string | null;
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  not_started: "Not Started",
  completed: "Completed",
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function CalendarPage() {
  const [, navigate] = useLocation();
  const [viewDate, setViewDate] = useState<Date>(startOfMonth(new Date()));
  const today = new Date();

  const { data: events, isLoading } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/calendar/events"],
  });

  const days = useMemo(() => buildMonthGrid(viewDate), [viewDate]);

  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
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

  return (
    <div className="p-4 sm:p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-calendar-title">Calendar</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(events || []).length} item{(events || []).length === 1 ? "" : "s"} scheduled across all projects
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToday} data-testid="button-today">Today</Button>
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
                  className={`border-r border-b p-1.5 overflow-hidden flex flex-col gap-1 min-h-0 ${
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
                              ) : (
                                <ClipboardCheck className="h-4 w-4 mt-0.5 shrink-0" style={{ color: event.color }} />
                              )}
                              <div className="min-w-0">
                                <p className="font-semibold text-sm">{event.title}</p>
                                <p className="text-xs text-muted-foreground">{event.projectName}</p>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              <Badge variant="secondary" className="text-xs">
                                {statusLabels[event.status] || event.status}
                              </Badge>
                              {event.priority && (
                                <Badge variant="outline" className="text-xs capitalize">{event.priority}</Badge>
                              )}
                            </div>
                            {event.assignedTo && (
                              <p className="text-xs text-muted-foreground">Assigned to {event.assignedTo}</p>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full"
                              onClick={() => navigate(`/projects/${event.projectId}`)}
                              data-testid={`button-open-project-${event.projectId}`}
                            >
                              Open project
                            </Button>
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
                  onClick={() => navigate(`/projects/${event.projectId}`)}
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
                      ) : (
                        <ClipboardCheck className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <p className="text-sm font-medium truncate">{event.title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{event.projectName}</p>
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
    </div>
  );
}
