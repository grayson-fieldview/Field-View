import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTheme } from "@/components/theme-provider";
import { useToast } from "@/hooks/use-toast";
import { SiGoogle, SiGooglecalendar, SiApple } from "react-icons/si";
import {
  Settings as SettingsIcon,
  User,
  Palette,
  Bell,
  Shield,
  LogOut,
  Sun,
  Moon,
  Mail,
  Calendar,
  CalendarCheck,
  CreditCard,
  Loader2,
  Tag,
  Plus,
  X,
  Camera,
  FolderKanban,
  Trash2,
  Users,
} from "lucide-react";

type CalendarConnection = {
  id: number;
  provider: "google" | "outlook" | "apple" | "ical";
  externalEmail: string | null;
  syncTasks: boolean;
  syncChecklists: boolean;
  status: string;
  createdAt: string;
};

const calendarProviders = [
  { id: "google" as const, name: "Google Calendar", icon: SiGoogle, color: "#4285F4" },
  { id: "outlook" as const, name: "Microsoft Outlook", icon: Mail, color: "#0078D4" },
  { id: "apple" as const, name: "Apple Calendar", icon: SiApple, color: "#000000" },
];

function ConnectedCalendarsCard() {
  const { toast } = useToast();
  const [openProvider, setOpenProvider] = useState<null | "google" | "outlook" | "apple">(null);
  const [emailInput, setEmailInput] = useState("");
  const [syncTasks, setSyncTasks] = useState(true);
  const [syncChecklists, setSyncChecklists] = useState(false);

  const { data: connections, isLoading } = useQuery<CalendarConnection[]>({
    queryKey: ["/api/calendar-connections"],
  });

  const createConnection = useMutation({
    mutationFn: async (data: { provider: string; externalEmail: string; syncTasks: boolean; syncChecklists: boolean }) => {
      const res = await apiRequest("POST", "/api/calendar-connections", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-connections"] });
      toast({
        title: "Calendar linked",
        description: "We've saved your connection. Live two-way sync will activate once OAuth is enabled by your admin.",
      });
      setOpenProvider(null);
      setEmailInput("");
      setSyncTasks(true);
      setSyncChecklists(false);
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't connect", description: error.message, variant: "destructive" });
    },
  });

  const deleteConnection = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/calendar-connections/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-connections"] });
      toast({ title: "Calendar disconnected" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateConnection = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await apiRequest("PATCH", `/api/calendar-connections/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-connections"] });
    },
  });

  const handleConnect = () => {
    if (!openProvider) return;
    if (!emailInput.trim() || !/.+@.+\..+/.test(emailInput)) {
      toast({ title: "Enter a valid email", variant: "destructive" });
      return;
    }
    createConnection.mutate({
      provider: openProvider,
      externalEmail: emailInput.trim(),
      syncTasks,
      syncChecklists,
    });
  };

  const connectionByProvider: Record<string, CalendarConnection | undefined> = {};
  (connections || []).forEach((c) => { connectionByProvider[c.provider] = c; });

  const openProviderInfo = openProvider ? calendarProviders.find(p => p.id === openProvider) : null;
  const OpenProviderIcon = openProviderInfo?.icon;

  return (
    <Card className="p-6" data-testid="card-connected-calendars">
      <div className="flex items-center gap-2 mb-2">
        <CalendarCheck className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Connected Calendars</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Link an external calendar so your Field View tasks and checklist due dates appear alongside your other appointments.
      </p>

      <div className="space-y-3">
        {calendarProviders.map((provider) => {
          const conn = connectionByProvider[provider.id];
          const Icon = provider.icon;
          return (
            <div
              key={provider.id}
              className="flex items-center gap-3 p-3 rounded-md border"
              data-testid={`row-calendar-${provider.id}`}
            >
              <div
                className="h-10 w-10 rounded-md flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${provider.color}15` }}
              >
                <Icon className="h-5 w-5" style={{ color: provider.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{provider.name}</p>
                {conn ? (
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <p className="text-xs text-muted-foreground truncate">{conn.externalEmail}</p>
                    <Badge variant="secondary" className="text-[10px] no-default-hover-elevate no-default-active-elevate">
                      {conn.status === "active" ? "Connected" : "Pending sync setup"}
                    </Badge>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">Not connected</p>
                )}
                {conn && (
                  <div className="flex items-center gap-4 mt-2">
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <Switch
                        checked={conn.syncTasks}
                        onCheckedChange={(v) => updateConnection.mutate({ id: conn.id, data: { syncTasks: v } })}
                        data-testid={`switch-sync-tasks-${provider.id}`}
                      />
                      Sync tasks
                    </label>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <Switch
                        checked={conn.syncChecklists}
                        onCheckedChange={(v) => updateConnection.mutate({ id: conn.id, data: { syncChecklists: v } })}
                        data-testid={`switch-sync-checklists-${provider.id}`}
                      />
                      Sync checklists
                    </label>
                  </div>
                )}
              </div>
              {conn ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteConnection.mutate(conn.id)}
                  disabled={deleteConnection.isPending}
                  data-testid={`button-disconnect-${provider.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setOpenProvider(provider.id); setEmailInput(""); setSyncTasks(true); setSyncChecklists(false); }}
                  data-testid={`button-connect-${provider.id}`}
                >
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {isLoading && (
        <p className="text-xs text-muted-foreground mt-3">Loading your connections...</p>
      )}

      <Dialog open={openProvider !== null} onOpenChange={(o) => { if (!o) setOpenProvider(null); }}>
        <DialogContent data-testid="dialog-connect-calendar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {OpenProviderIcon && openProviderInfo && (
                <OpenProviderIcon className="h-5 w-5" style={{ color: openProviderInfo.color }} />
              )}
              Connect {openProviderInfo?.name}
            </DialogTitle>
            <DialogDescription>
              Enter the email address of the calendar you'd like to link. We'll save your preference and surface a sync prompt the next time it's available.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Calendar email</label>
              <Input
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                type="email"
                placeholder={openProvider === "google" ? "you@gmail.com" : openProvider === "outlook" ? "you@outlook.com" : "you@icloud.com"}
                data-testid="input-calendar-email"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Sync tasks</p>
                  <p className="text-xs text-muted-foreground">Push task due dates as calendar events</p>
                </div>
                <Switch checked={syncTasks} onCheckedChange={setSyncTasks} data-testid="switch-dialog-sync-tasks" />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Sync checklists</p>
                  <p className="text-xs text-muted-foreground">Push checklist due dates as calendar events</p>
                </div>
                <Switch checked={syncChecklists} onCheckedChange={setSyncChecklists} data-testid="switch-dialog-sync-checklists" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground border-l-2 border-primary/30 pl-3 py-1.5">
              Live two-way sync uses each provider's OAuth flow and is being rolled out account-by-account. Your selection is saved so it activates automatically when ready.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenProvider(null)} data-testid="button-cancel-connect">
              Cancel
            </Button>
            <Button onClick={handleConnect} disabled={createConnection.isPending} data-testid="button-confirm-connect">
              {createConnection.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type SeatUsage = {
  used: number;
  total: number;
  available: number;
  overCapacity: boolean;
};

function SeatCountWidget() {
  const { data, isLoading, isError } = useQuery<SeatUsage>({
    queryKey: ["/api/account/seats"],
  });

  return (
    <Card className="p-6" data-testid="card-seats">
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Seats</h2>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground" data-testid="text-seats-error">
          Unable to load seat count
        </p>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-sm font-medium" data-testid="text-seats-usage">
            {data.used} of {data.total} seats used
            {data.available > 0 && (
              <span className="text-muted-foreground font-normal">
                {" "}
                - {data.available} available
              </span>
            )}
          </p>
          {data.overCapacity && (
            <Badge className="bg-red-500 text-white" data-testid="badge-seats-over-capacity">
              Over capacity by {data.used - data.total}
            </Badge>
          )}
        </div>
      )}
    </Card>
  );
}

function BillingCard() {
  const { user } = useAuth();
  const { toast } = useToast();

  const portalMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/create-portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to open billing portal");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const status = user?.subscriptionStatus || "none";
  const statusLabel: Record<string, string> = {
    active: "Active",
    trialing: "Trial",
    trial: "Trial",
    past_due: "Past Due",
    canceled: "Canceled",
    none: "No Plan",
  };
  const statusColor: Record<string, string> = {
    active: "bg-[#267D32] text-white",
    trialing: "bg-[#F09000] text-white",
    trial: "bg-[#F09000] text-white",
    past_due: "bg-red-500 text-white",
    canceled: "bg-gray-500 text-white",
    none: "bg-gray-400 text-white",
  };

  return (
    <Card className="p-6" data-testid="card-billing">
      <div className="flex items-center gap-2 mb-4">
        <CreditCard className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Billing & Subscription</h2>
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Subscription Status</p>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={statusColor[status] || statusColor.none}>
                {statusLabel[status] || status}
              </Badge>
              {status === "trial" && user?.trialEndsAt && (
                <span className="text-xs text-muted-foreground">
                  Ends {new Date(user.trialEndsAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          {user?.stripeCustomerId && (
            <Button
              variant="outline"
              onClick={() => portalMutation.mutate()}
              disabled={portalMutation.isPending}
              data-testid="button-manage-billing"
            >
              {portalMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Manage Billing"
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function TagManagerCard({ type, title, icon: Icon }: { type: "photo" | "project"; title: string; icon: any }) {
  const { toast } = useToast();
  const [newTagName, setNewTagName] = useState("");

  const { data: tags, isLoading } = useQuery<{ id: number; name: string; type: string }[]>({
    queryKey: ["/api/tags", { type }],
    queryFn: async () => {
      const res = await fetch(`/api/tags?type=${type}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createTag = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/tags", { name, type });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags", { type }] });
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
      setNewTagName("");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteTag = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/tags/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags", { type }] });
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleAdd = () => {
    const name = newTagName.trim();
    if (!name) return;
    if ((tags || []).some(t => t.name.toLowerCase() === name.toLowerCase())) {
      toast({ title: "Tag already exists", variant: "destructive" });
      return;
    }
    createTag.mutate(name);
  };

  return (
    <Card className="p-6" data-testid={`card-${type}-tags`}>
      <div className="flex items-center gap-2 mb-4">
        <Icon className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Define the tags your team can use when tagging {type === "photo" ? "photos" : "projects"}. Tags help organize and filter your content.
      </p>
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={newTagName}
          onChange={(e) => setNewTagName(e.target.value)}
          placeholder={`Add a ${type} tag...`}
          className="flex-1"
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          data-testid={`input-new-${type}-tag`}
        />
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!newTagName.trim() || createTag.isPending}
          data-testid={`button-add-${type}-tag`}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (tags || []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No tags defined yet</p>
        ) : (
          (tags || []).map((tag) => (
            <Badge key={tag.id} variant="secondary" className="text-sm gap-1.5 py-1 px-3" data-testid={`badge-${type}-tag-${tag.id}`}>
              {tag.name}
              <X
                className="h-3.5 w-3.5 cursor-pointer hover:text-destructive transition-colors"
                onClick={() => deleteTag.mutate(tag.id)}
              />
            </Badge>
          ))
        )}
      </div>
    </Card>
  );
}

type AccountUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  accountId: string | null;
  role: string;
};

function TransferOwnershipDialog({
  open,
  onOpenChange,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  currentUserId: string;
}) {
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const { toast } = useToast();

  const { data: usersList, isLoading: usersLoading } = useQuery<AccountUser[]>({
    queryKey: ["/api/users"],
    enabled: open,
  });

  const transferable = (usersList || []).filter(
    (u) => u.id !== currentUserId && !!u.accountId,
  );
  const selectedUser = transferable.find((u) => u.id === selectedUserId);
  const displayName = (u: AccountUser) =>
    [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;

  const transfer = useMutation({
    mutationFn: async (newOwnerId: string) => {
      const res = await apiRequest("POST", "/api/account/transfer-ownership", { newOwnerId });
      return res.json() as Promise<{ success: true; newOwnerId: string; newOwnerName: string | null }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Ownership transferred",
        description: data.newOwnerName
          ? `${data.newOwnerName} is now the account owner.`
          : "The new owner has been set.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/account/seats"] });
      setSelectedUserId("");
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({
        title: "Transfer failed",
        description: err?.message || "Could not transfer ownership.",
        variant: "destructive",
      });
    },
  });

  const handleOpenChange = (next: boolean) => {
    if (!next) setSelectedUserId("");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="dialog-transfer-ownership">
        <DialogHeader>
          <DialogTitle>Transfer Account Ownership</DialogTitle>
          <DialogDescription>
            Transferring ownership makes another user responsible for billing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {usersLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : transferable.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-no-other-users"
            >
              No other users in this account. Invite someone first.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium">New Owner</p>
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger data-testid="select-new-owner">
                    <SelectValue placeholder="Choose a user..." />
                  </SelectTrigger>
                  <SelectContent>
                    {transferable.map((u) => (
                      <SelectItem
                        key={u.id}
                        value={u.id}
                        data-testid={`option-user-${u.id}`}
                      >
                        {displayName(u)}{" "}
                        <span className="text-muted-foreground">({u.email})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedUser && (
                <div
                  className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/20"
                  data-testid="text-transfer-confirmation"
                >
                  You're about to transfer ownership of this account to{" "}
                  <strong>{displayName(selectedUser)}</strong>. They'll become
                  responsible for billing and the primary Admin. You'll remain
                  an Admin but lose owner status.
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            data-testid="button-cancel-transfer"
          >
            Cancel
          </Button>
          <Button
            onClick={() => selectedUserId && transfer.mutate(selectedUserId)}
            disabled={!selectedUserId || transfer.isPending}
            data-testid="button-confirm-transfer"
          >
            {transfer.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Transfer Ownership
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountOwnershipCard() {
  const { user } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: seatStatus } = useQuery<{ ownerId: string | null }>({
    queryKey: ["/api/account/seats"],
    enabled: !!user?.id && user?.role === "admin",
  });

  const isOwner =
    !!user?.id && !!seatStatus?.ownerId && user.id === seatStatus.ownerId;

  if (!isOwner || !user?.id) return null;

  return (
    <Card className="p-6" data-testid="card-account-ownership">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Account Ownership</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            You are the owner of this account. Transferring ownership will make
            another user responsible for billing.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setDialogOpen(true)}
          data-testid="button-open-transfer-ownership"
        >
          Transfer Ownership
        </Button>
      </div>
      <TransferOwnershipDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        currentUserId={user.id}
      />
    </Card>
  );
}

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const initials = user
    ? `${(user.firstName || "")[0] || ""}${(user.lastName || "")[0] || ""}`.toUpperCase() || "U"
    : "U";

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-settings-title">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account and preferences</p>
      </div>

      <Card className="p-6" data-testid="card-profile">
        <div className="flex items-center gap-2 mb-4">
          <User className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Profile</h2>
        </div>
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={user?.profileImageUrl || undefined} alt={user?.firstName || "User"} />
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold" data-testid="text-settings-name">
              {user?.firstName} {user?.lastName}
            </h3>
            {user?.email && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                {user.email}
              </p>
            )}
            {user?.createdAt && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                <Calendar className="h-3 w-3" />
                Member since {new Date(user.createdAt).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6" data-testid="card-appearance">
        <div className="flex items-center gap-2 mb-4">
          <Palette className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Appearance</h2>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              <div>
                <p className="text-sm font-medium">Dark Mode</p>
                <p className="text-xs text-muted-foreground">Switch between light and dark themes</p>
              </div>
            </div>
            <Switch
              checked={theme === "dark"}
              onCheckedChange={toggleTheme}
              data-testid="switch-dark-mode"
            />
          </div>
        </div>
      </Card>

      <Card className="p-6" data-testid="card-notifications">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Notifications</h2>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Project Updates</p>
              <p className="text-xs text-muted-foreground">Get notified when projects are updated</p>
            </div>
            <Switch defaultChecked data-testid="switch-project-notifications" />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Task Assignments</p>
              <p className="text-xs text-muted-foreground">Get notified when tasks are assigned to you</p>
            </div>
            <Switch defaultChecked data-testid="switch-task-notifications" />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Comments</p>
              <p className="text-xs text-muted-foreground">Get notified when someone comments on your photos</p>
            </div>
            <Switch defaultChecked data-testid="switch-comment-notifications" />
          </div>
        </div>
      </Card>

      <ConnectedCalendarsCard />

      <TagManagerCard type="photo" title="Photo Tags" icon={Camera} />
      <TagManagerCard type="project" title="Project Tags" icon={FolderKanban} />

      {user?.role === "admin" && <SeatCountWidget />}

      <BillingCard />

      <AccountOwnershipCard />

      <Card className="p-6" data-testid="card-account">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Account</h2>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Sign Out</p>
              <p className="text-xs text-muted-foreground">Sign out of your Field View account</p>
            </div>
            <Button variant="outline" onClick={() => logout()} data-testid="button-settings-logout">
              <LogOut className="h-4 w-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
