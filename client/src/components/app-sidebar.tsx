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
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FolderKanban,
  Camera,
  MapPin,
  Users,
  Settings,
  LogOut,
  Eye,
  Search,
  Bell,
  ClipboardCheck,
  FileBarChart,
} from "lucide-react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";

const navItems = [
  { title: "Projects", url: "/", icon: FolderKanban },
  { title: "Photos", url: "/photos", icon: Camera },
  { title: "Checklists", url: "/checklists", icon: ClipboardCheck },
  { title: "Reports", url: "/reports", icon: FileBarChart },
  { title: "Map", url: "/map", icon: MapPin },
  { title: "Team", url: "/team", icon: Users },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  const initials = user
    ? `${(user.firstName || "")[0] || ""}${(user.lastName || "")[0] || ""}`.toUpperCase() || "U"
    : "U";

  return (
    <Sidebar>
      <SidebarHeader className="p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Link href="/" data-testid="link-home">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                <Eye className="h-4 w-4" />
              </div>
              <span className="text-sm font-bold tracking-tight" data-testid="text-brand-name">FieldView</span>
            </div>
          </Link>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" data-testid="button-notifications">
              <Bell className="h-4 w-4" />
            </Button>
            <Avatar className="h-7 w-7">
              <AvatarImage src={user?.profileImageUrl || undefined} alt={user?.firstName || "User"} />
              <AvatarFallback className="text-[10px] bg-sidebar-accent text-sidebar-accent-foreground">{initials}</AvatarFallback>
            </Avatar>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-sidebar-foreground/50" />
          <Input
            type="search"
            placeholder="Search"
            className="h-8 pl-8 text-sm bg-sidebar-accent border-sidebar-border text-sidebar-foreground placeholder:text-sidebar-foreground/50"
            data-testid="input-sidebar-search"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <div className="px-3 py-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/50" data-testid="text-org-name">
              {user?.firstName ? `${user.firstName}'s Team` : "My Team"}
            </p>
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
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
                      <Link href={item.url}>
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
      </SidebarContent>

      <SidebarFooter className="p-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={user?.profileImageUrl || undefined} alt={user?.firstName || "User"} />
            <AvatarFallback className="text-xs bg-sidebar-accent text-sidebar-accent-foreground">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-sidebar-foreground" data-testid="text-user-name">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="text-xs truncate text-sidebar-foreground/60" data-testid="text-user-email">
              {user?.email}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => logout()}
            className="text-sidebar-foreground/70"
            data-testid="button-logout"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
