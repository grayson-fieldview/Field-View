import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  FolderKanban,
  ClipboardList,
  Camera,
  MapPin,
  Users,
  Settings,
  LogOut,
  ClipboardCheck,
  FileBarChart,
  BarChart3,
  CalendarDays,
  Clock,
} from "lucide-react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/theme-toggle";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

type NavItem = {
  title: string;
  url: string;
  icon: typeof LayoutDashboard;
  roles: string[] | null;
};

const workspaceItems: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard, roles: null },
  { title: "Projects", url: "/projects", icon: FolderKanban, roles: null },
  { title: "Tasks", url: "/tasks", icon: ClipboardList, roles: null },
  { title: "Photos", url: "/photos", icon: Camera, roles: null },
  { title: "Checklists", url: "/checklists", icon: ClipboardCheck, roles: null },
  { title: "Reports", url: "/reports", icon: FileBarChart, roles: null },
  { title: "Analytics", url: "/analytics", icon: BarChart3, roles: null },
  { title: "Calendar", url: "/calendar", icon: CalendarDays, roles: null },
  { title: "Map", url: "/map", icon: MapPin, roles: null },
  { title: "Settings", url: "/settings", icon: Settings, roles: null },
];

const managerItems: NavItem[] = [
  { title: "Team", url: "/team", icon: Users, roles: ["admin", "manager"] },
  { title: "Timesheets", url: "/manager/timesheets", icon: Clock, roles: ["admin", "manager"] },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();

  const initials = user
    ? `${(user.firstName || "")[0] || ""}${(user.lastName || "")[0] || ""}`.toUpperCase() || "U"
    : "U";

  return (
    <Sidebar>
      <SidebarHeader className="p-4 pb-3">
        <Link href="/" data-testid="link-home">
          <div className="flex items-center gap-2.5" data-testid="img-logo">
            <img src={faviconImg} alt="Field View" className="h-9 w-9 rounded-md" />
            <span className="text-lg font-bold tracking-tight text-sidebar-foreground">Field View</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <div className="px-3 py-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/40" data-testid="text-org-name">
              Workspace
            </p>
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaceItems.filter(item => !item.roles || item.roles.includes(user?.role || "standard")).map((item) => {
                const isActive = item.url === "/"
                  ? location === "/"
                  : location.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`nav-${item.title.toLowerCase()}`}
                    >
                      <Link href={item.url} onClick={() => { if (isMobile) setOpenMobile(false); }}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {(() => {
          const visibleManagerItems = managerItems.filter(
            (item) => !item.roles || item.roles.includes(user?.role || "standard"),
          );
          if (visibleManagerItems.length === 0) return null;
          return (
            <SidebarGroup data-testid="group-manager">
              <div className="px-3 py-1">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/40" data-testid="text-manager-label">
                  Manager Workspace
                </p>
              </div>
              <SidebarGroupContent>
                <SidebarMenu>
                  {visibleManagerItems.map((item) => {
                    const isActive = location.startsWith(item.url);
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          data-testid={`nav-${item.title.toLowerCase()}`}
                        >
                          <Link href={item.url} onClick={() => { if (isMobile) setOpenMobile(false); }}>
                            <item.icon className="h-4 w-4" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })()}
      </SidebarContent>

      <SidebarFooter className="p-3 space-y-2">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={user?.profileImageUrl || undefined} alt={user?.firstName || "User"} />
            <AvatarFallback className="text-xs bg-sidebar-accent text-sidebar-accent-foreground">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-sidebar-foreground" data-testid="text-user-name">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="text-xs truncate text-sidebar-foreground/50" data-testid="text-user-email">
              {user?.email}
            </p>
          </div>
          <div className="flex items-center gap-0.5">
            <ThemeToggle />
            <Button
              size="icon"
              variant="ghost"
              onClick={() => logout()}
              className="text-sidebar-foreground/60"
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
