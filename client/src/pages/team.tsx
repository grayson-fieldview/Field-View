import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Users, Search, Mail, Calendar, Shield, UserPlus, X, Clock, Loader2, Trash2, Copy, Check } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/models/auth";

const roleLabels: Record<string, { label: string; description: string; color: string }> = {
  admin: { label: "Admin", description: "Has complete control over account.", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
  manager: { label: "Manager", description: "Access to all projects and can manage users.", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  standard: { label: "Standard", description: "Access to all projects but can't manage users.", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  restricted: { label: "Restricted", description: "Can only access projects they create or are assigned to.", color: "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-400" },
};

export default function TeamPage() {
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("standard");
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const isAdmin = currentUser?.role === "admin";
  const isManager = currentUser?.role === "manager";
  const canManageUsers = isAdmin || isManager;

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });

  const { data: pendingInvitations, isLoading: invitationsLoading } = useQuery<any[]>({
    queryKey: ["/api/invitations"],
    enabled: canManageUsers,
  });

  const updateRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: string }) => {
      const res = await apiRequest("PATCH", `/api/users/${userId}/role`, { role });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "Role updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const sendInvite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/invitations", { email: inviteEmail, role: inviteRole });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/invitations"] });
      setInviteEmail("");
      setInviteRole("standard");
      setInviteOpen(false);
      toast({ title: "Invitation sent", description: `Invite link created for ${data.email}` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to send invitation", description: error.message, variant: "destructive" });
    },
  });

  const cancelInvite = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/invitations/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invitations"] });
      toast({ title: "Invitation cancelled" });
    },
  });

  const removeUser = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/users/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User removed from account" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filtered = (users || []).filter((u) => {
    const name = `${u.firstName || ""} ${u.lastName || ""}`.toLowerCase();
    const email = (u.email || "").toLowerCase();
    return name.includes(search.toLowerCase()) || email.includes(search.toLowerCase());
  });

  const handleCopyLink = async (invToken: string, invId: string) => {
    const link = `${window.location.origin}/register?token=${invToken}`;
    await navigator.clipboard.writeText(link);
    setCopiedLink(invId);
    setTimeout(() => setCopiedLink(null), 2000);
  };

  const availableRoles = isAdmin
    ? ["admin", "manager", "standard", "restricted"]
    : ["standard", "restricted"];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-team-title">Team</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your team members and invitations</p>
        </div>
        {canManageUsers && (
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger asChild>
              <Button className="bg-[#F09000] hover:bg-[#d98000] text-white" data-testid="button-invite-user">
                <UserPlus className="h-4 w-4 mr-2" />
                Invite User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite a Team Member</DialogTitle>
                <DialogDescription>
                  Send an invitation to join your team. They'll receive a link to create their account.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="invite-email">Email address</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="colleague@company.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    data-testid="input-invite-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={inviteRole} onValueChange={setInviteRole}>
                    <SelectTrigger data-testid="select-invite-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableRoles.map((r) => (
                        <SelectItem key={r} value={r}>{roleLabels[r].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{roleLabels[inviteRole]?.description}</p>
                </div>
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Role Permissions</p>
                  {Object.entries(roleLabels).map(([key, val]) => (
                    <div key={key} className={`flex items-start gap-2 p-2 rounded ${key === inviteRole ? 'bg-muted' : ''}`}>
                      <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 mt-0.5 shrink-0 ${val.color}`}>{val.label}</Badge>
                      <span className="text-xs text-muted-foreground">{val.description}</span>
                    </div>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
                <Button
                  onClick={() => sendInvite.mutate()}
                  disabled={!inviteEmail || sendInvite.isPending}
                  className="bg-[#F09000] hover:bg-[#d98000] text-white"
                  data-testid="button-send-invite"
                >
                  {sendInvite.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Send Invitation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search team members..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
          data-testid="input-search-team"
        />
      </div>

      {canManageUsers && pendingInvitations && pendingInvitations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide" data-testid="text-pending-invites">
            Pending Invitations ({pendingInvitations.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingInvitations.map((inv: any) => {
              const roleInfo = roleLabels[inv.role || "standard"] || roleLabels.standard;
              return (
                <Card key={inv.id} className="p-4 border-dashed" data-testid={`card-invitation-${inv.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <p className="text-sm font-medium truncate">{inv.email}</p>
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${roleInfo.color}`}>{roleInfo.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Invited by {inv.invitedByFirst} {inv.invitedByLast}
                      </p>
                      <div className="flex gap-1 mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleCopyLink(inv.token, inv.id)}
                          data-testid={`button-copy-link-${inv.id}`}
                        >
                          {copiedLink === inv.id ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                          {copiedLink === inv.id ? "Copied" : "Copy Link"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-destructive hover:text-destructive"
                          onClick={() => cancelInvite.mutate(inv.id)}
                          data-testid={`button-cancel-invite-${inv.id}`}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Team Members ({filtered.length})
        </h2>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="p-5">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="p-12">
            <div className="text-center space-y-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                <Users className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold">No team members found</h3>
              <p className="text-sm text-muted-foreground">
                {search ? "Try adjusting your search." : "Invite team members to get started."}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((member) => {
              const initials = `${(member.firstName || "")[0] || ""}${(member.lastName || "")[0] || ""}`.toUpperCase() || "U";
              const roleInfo = roleLabels[member.role || "standard"] || roleLabels.standard;
              return (
                <Card key={member.id} className="p-5 hover-elevate" data-testid={`card-member-${member.id}`}>
                  <div className="flex items-center gap-3">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={member.profileImageUrl || undefined} alt={member.firstName || "User"} />
                      <AvatarFallback>{initials}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold truncate">
                          {member.firstName} {member.lastName}
                        </p>
                        <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${roleInfo.color}`} data-testid={`badge-role-${member.id}`}>
                          {roleInfo.label}
                        </Badge>
                      </div>
                      {member.email && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                          <Mail className="h-3 w-3 shrink-0" />
                          {member.email}
                        </p>
                      )}
                      {member.createdAt && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Calendar className="h-3 w-3 shrink-0" />
                          Joined {new Date(member.createdAt).toLocaleDateString()}
                        </p>
                      )}
                      {canManageUsers && member.id !== currentUser?.id && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <Shield className="h-3 w-3 text-muted-foreground shrink-0" />
                          <Select
                            value={member.role || "standard"}
                            onValueChange={(role) => updateRole.mutate({ userId: member.id, role })}
                          >
                            <SelectTrigger className="h-7 text-xs w-28" data-testid={`select-role-${member.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(isAdmin ? ["admin", "manager", "standard", "restricted"] : ["standard", "restricted"]).map((r) => (
                                <SelectItem key={r} value={r}>{roleLabels[r].label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" data-testid={`button-remove-user-${member.id}`}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove team member?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {member.firstName} {member.lastName} will be removed from your account. They will lose access to all projects and data.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => removeUser.mutate(member.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Remove
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
