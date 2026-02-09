import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Users, Search, Mail, Calendar } from "lucide-react";
import { useState } from "react";
import type { User } from "@shared/models/auth";

export default function TeamPage() {
  const [search, setSearch] = useState("");

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });

  const filtered = (users || []).filter((u) => {
    const name = `${u.firstName || ""} ${u.lastName || ""}`.toLowerCase();
    const email = (u.email || "").toLowerCase();
    return name.includes(search.toLowerCase()) || email.includes(search.toLowerCase());
  });

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-team-title">Team</h1>
        <p className="text-sm text-muted-foreground mt-1">View and manage team members</p>
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
              {search ? "Try adjusting your search." : "Team members will appear here once they sign in."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((member) => {
            const initials = `${(member.firstName || "")[0] || ""}${(member.lastName || "")[0] || ""}`.toUpperCase() || "U";
            return (
              <Card key={member.id} className="p-5 hover-elevate" data-testid={`card-member-${member.id}`}>
                <div className="flex items-center gap-3">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={member.profileImageUrl || undefined} alt={member.firstName || "User"} />
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">
                      {member.firstName} {member.lastName}
                    </p>
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
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
