import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { formatDistanceToNow } from "date-fns";
import { AtSign, Send, X } from "lucide-react";

interface MessageAuthor {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

interface ProjectMessage {
  id: number;
  projectId: number;
  userId: string;
  content: string;
  mentions: string[];
  createdAt: string;
  author: MessageAuthor | null;
}

interface MentionCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

function displayName(u: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (!u) return "Unknown user";
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || "Unnamed user";
}

function initials(u: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (!u) return "?";
  return (`${(u.firstName || "")[0] || ""}${(u.lastName || "")[0] || ""}`.toUpperCase()) || "U";
}

export function useProjectUnreadCount(projectId: string) {
  return useQuery<{ unread: number }>({
    queryKey: ["/api/projects", projectId, "messages", "unread-count"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/messages/unread-count`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch unread count");
      return res.json();
    },
  });
}

// Read-marking policy: the thread is marked read when the Messages tab is
// OPENED (component mount), and again whenever new messages arrive while
// the tab stays open. Chosen over scroll-to-bottom detection because the
// thread renders in full (no virtualization) — "tab visible" and "content
// seen" are the same event here, and a scroll listener would just be a
// less reliable proxy for the same thing.
export function ProjectMessagesTab({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState("");
  // Mentions staged for the next post: id -> display name at insert time
  // (names are only for chip display; the server stores ids).
  const [pendingMentions, setPendingMentions] = useState<{ id: string; name: string }[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // null = typeahead closed

  const { data, isLoading } = useQuery<{ messages: ProjectMessage[]; hasMore: boolean }>({
    queryKey: ["/api/projects", projectId, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/messages?limit=100`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
  });
  const messages = data?.messages ?? [];

  // Mention candidates + name resolution for stored mention ids — the same
  // visibility-filtered list the server validates against.
  const { data: candidates = [] } = useQuery<MentionCandidate[]>({
    queryKey: ["/api/users", { assignableForProjectId: projectId }],
    queryFn: async () => {
      const res = await fetch(`/api/users?assignableForProjectId=${projectId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
  });
  const userById = useMemo(() => {
    const m = new Map<string, MentionCandidate>();
    for (const c of candidates) m.set(c.id, c);
    return m;
  }, [candidates]);

  const markRead = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/projects/${projectId}/messages/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "messages", "unread-count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-counts"] });
    },
  });

  // Mark read on tab open and whenever new messages load while open.
  const lastMarkedCountRef = useRef(-1);
  useEffect(() => {
    if (isLoading) return;
    if (messages.length === lastMarkedCountRef.current) return;
    lastMarkedCountRef.current = messages.length;
    markRead.mutate();
    bottomRef.current?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, messages.length]);

  const post = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/messages`, {
        content: draft.trim(),
        mentions: pendingMentions.map((m) => m.id),
      });
      return res.json();
    },
    onSuccess: () => {
      setDraft("");
      setPendingMentions([]);
      setMentionQuery(null);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "messages"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to post message", description: err.message, variant: "destructive" });
    },
  });

  // Typeahead: an "@" token at the end of the draft (started after
  // whitespace or start-of-text) opens the picker; the text after it is
  // the filter query.
  const onDraftChange = (value: string) => {
    setDraft(value);
    const match = /(^|\s)@([\w ]{0,30})$/.exec(value);
    setMentionQuery(match ? match[2] : null);
  };

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return candidates
      .filter((c) => !pendingMentions.some((m) => m.id === c.id))
      .filter((c) => !q || displayName(c).toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, candidates, pendingMentions]);

  const selectMention = (c: MentionCandidate) => {
    const name = displayName(c);
    // Replace the trailing @token with the resolved @Name.
    setDraft((prev) => prev.replace(/(^|\s)@([\w ]{0,30})$/, `$1@${name} `));
    setPendingMentions((prev) => [...prev, { id: c.id, name }]);
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const removePendingMention = (id: string) => {
    setPendingMentions((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="px-4 sm:px-6 py-4 flex flex-col gap-4" data-testid="messages-tab">
      <div className="space-y-4 flex-1">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-10">
            <AtSign className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No messages yet. Start the conversation — use @ to mention a teammate.</p>
          </div>
        ) : (
          messages.map((msg) => {
            const author = msg.author ?? userById.get(msg.userId) ?? null;
            return (
              <div key={msg.id} className="flex gap-3" data-testid={`message-${msg.id}`}>
                <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                  <AvatarImage src={author?.profileImageUrl || undefined} />
                  <AvatarFallback className="text-[10px] bg-primary/10 text-primary">
                    {initials(author)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold truncate">{displayName(author)}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                  {msg.mentions.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {msg.mentions.map((id) => (
                        <Badge key={id} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                          @{displayName(userById.get(id)) /* resolved to CURRENT name; ids are what's stored */}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="relative border rounded-md bg-card p-2 space-y-2">
        {pendingMentions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pendingMentions.map((m) => (
              <Badge key={m.id} variant="secondary" className="text-xs gap-1 pr-1">
                @{m.name}
                <button
                  onClick={() => removePendingMention(m.id)}
                  className="hover:text-destructive"
                  data-testid={`button-remove-mention-${m.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        {mentionQuery !== null && mentionMatches.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 z-20 border rounded-md bg-popover shadow-md overflow-hidden" data-testid="mention-typeahead">
            {mentionMatches.map((c) => (
              <button
                key={c.id}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-accent text-left"
                onClick={() => selectMention(c)}
                data-testid={`mention-option-${c.id}`}
              >
                <Avatar className="h-5 w-5">
                  <AvatarImage src={c.profileImageUrl || undefined} />
                  <AvatarFallback className="text-[8px]">{initials(c)}</AvatarFallback>
                </Avatar>
                <span className="truncate">{displayName(c)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                e.preventDefault();
                post.mutate();
              }
            }}
            placeholder="Write a message... use @ to mention"
            className="min-h-[60px] resize-none"
            data-testid="input-message"
          />
          <Button
            size="icon"
            onClick={() => post.mutate()}
            disabled={!draft.trim() || post.isPending}
            data-testid="button-send-message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
