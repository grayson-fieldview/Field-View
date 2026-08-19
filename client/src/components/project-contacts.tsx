import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Mail, Phone, Plus, UserRound, X } from "lucide-react";
import type { Contact, ProjectContact } from "@shared/schema";

// PII note: contact data is admin/manager only — the server 403s other
// roles on every route, and these components render nothing for them.
// recap_frequency deliberately NOT surfaced yet (dead control until the
// recap email feature lands).

export type ProjectContactRow = ProjectContact & { contact: Contact };
export type ContactWithCount = Contact & { projectCount: number };

export const CONTACT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "renter", label: "Renter" },
  { value: "property_manager", label: "Property manager" },
  { value: "gc", label: "GC" },
  { value: "other", label: "Other" },
];

export function contactTypeLabel(value: string): string {
  return CONTACT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function contactName(c: Contact): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ");
}

export function useCanManageContacts(): boolean {
  const { user } = useAuth();
  return user?.role === "admin" || user?.role === "manager";
}

// ── Inline create form (shared by attach dialog and directory) ────────────

type ContactFormValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
};

const EMPTY_FORM: ContactFormValues = { firstName: "", lastName: "", email: "", phone: "", address: "", notes: "" };

function toPayload(v: ContactFormValues) {
  return {
    firstName: v.firstName.trim(),
    lastName: v.lastName.trim() || null,
    email: v.email.trim() || null,
    phone: v.phone.trim() || null,
    address: v.address.trim() || null,
    notes: v.notes.trim() || null,
  };
}

function ContactFields({
  values,
  onChange,
  idPrefix,
}: {
  values: ContactFormValues;
  onChange: (v: ContactFormValues) => void;
  idPrefix: string;
}) {
  const set = (k: keyof ContactFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...values, [k]: e.target.value });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-first-name`}>First name *</Label>
          <Input id={`${idPrefix}-first-name`} value={values.firstName} onChange={set("firstName")} data-testid="input-contact-first-name" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-last-name`}>Last name</Label>
          <Input id={`${idPrefix}-last-name`} value={values.lastName} onChange={set("lastName")} data-testid="input-contact-last-name" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`${idPrefix}-email`}>Email</Label>
          <Input id={`${idPrefix}-email`} type="email" value={values.email} onChange={set("email")} data-testid="input-contact-email" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
          <Input id={`${idPrefix}-phone`} type="tel" value={values.phone} onChange={set("phone")} data-testid="input-contact-phone" />
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-address`}>Address</Label>
        <Input id={`${idPrefix}-address`} value={values.address} onChange={set("address")} data-testid="input-contact-address" />
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea id={`${idPrefix}-notes`} rows={2} value={values.notes} onChange={set("notes")} data-testid="input-contact-notes" />
      </div>
    </div>
  );
}

// ── Add-contact dialog: search existing → attach, or create-and-attach ────

function AddContactDialog({
  projectId,
  open,
  onOpenChange,
  attachedContactIds,
}: {
  projectId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachedContactIds: Set<number>;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [contactType, setContactType] = useState("owner");
  const [form, setForm] = useState<ContactFormValues>(EMPTY_FORM);

  const { data: allContacts, isLoading } = useQuery<ContactWithCount[]>({
    queryKey: ["/api/contacts"],
    enabled: open,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const candidates = (allContacts ?? []).filter((c) => !attachedContactIds.has(c.id));
    if (!q) return candidates;
    return candidates.filter((c) => contactName(c).toLowerCase().includes(q));
  }, [allContacts, attachedContactIds, search]);

  const reset = () => {
    setSearch("");
    setCreating(false);
    setContactType("owner");
    setForm(EMPTY_FORM);
  };

  const attach = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/contacts`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId.toString(), "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact added" });
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't add contact", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-add-contact">
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>
            {creating ? "Create a new contact and add them to this project." : "Search your contacts or create a new one."}
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label>Contact type</Label>
          <Select value={contactType} onValueChange={setContactType}>
            <SelectTrigger data-testid="select-attach-contact-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!creating ? (
          <>
            <Input
              placeholder="Search contacts by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-contact-search"
            />
            <div className="max-h-56 overflow-y-auto space-y-1" data-testid="list-contact-candidates">
              {isLoading ? (
                <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">
                  {search.trim() ? "No matching contacts." : "No contacts yet."}
                </p>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left rounded-md border p-2.5 hover-elevate disabled:opacity-50"
                    disabled={attach.isPending}
                    onClick={() => attach.mutate({ contactId: c.id, contactType })}
                    data-testid={`button-attach-contact-${c.id}`}
                  >
                    <p className="text-sm font-medium">{contactName(c)}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone"}
                    </p>
                  </button>
                ))
              )}
            </div>
            <Button variant="outline" onClick={() => setCreating(true)} data-testid="button-show-create-contact">
              <Plus className="h-4 w-4 mr-2" />
              Create new contact
            </Button>
          </>
        ) : (
          <>
            <ContactFields values={form} onChange={setForm} idPrefix="attach" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(false)} data-testid="button-back-to-search">
                Back to search
              </Button>
              <Button
                disabled={!form.firstName.trim() || attach.isPending}
                onClick={() => attach.mutate({ contact: toPayload(form), contactType })}
                data-testid="button-create-and-attach"
              >
                {attach.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create & add
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Project contacts section (project-detail) ─────────────────────────────

export function ProjectContactsSection({ projectId }: { projectId: number }) {
  const canManage = useCanManageContacts();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);

  const { data: rows } = useQuery<ProjectContactRow[]>({
    queryKey: ["/api/projects", projectId.toString(), "contacts"],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/contacts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch project contacts");
      return res.json();
    },
    enabled: canManage,
  });

  const updateType = useMutation({
    mutationFn: async ({ contactId, contactType }: { contactId: number; contactType: string }) => {
      const res = await apiRequest("PATCH", `/api/projects/${projectId}/contacts/${contactId}`, { contactType });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId.toString(), "contacts"] });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't update contact", description: e.message, variant: "destructive" });
    },
  });

  const detach = useMutation({
    mutationFn: async (contactId: number) => {
      await apiRequest("DELETE", `/api/projects/${projectId}/contacts/${contactId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId.toString(), "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact removed from project" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't remove contact", description: e.message, variant: "destructive" });
    },
  });

  // Server 403s non-managers; don't render the section (or fire the query)
  // for them at all.
  if (!canManage) return null;

  return (
    <div data-testid="section-project-contacts">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          <UserRound className="h-3.5 w-3.5" />
          Contacts
        </span>
        {(rows ?? []).map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
            data-testid={`row-project-contact-${row.contactId}`}
          >
            <span className="text-sm font-medium whitespace-nowrap">{contactName(row.contact)}</span>
            <Select
              value={row.contactType}
              disabled={updateType.isPending}
              onValueChange={(v) => updateType.mutate({ contactId: row.contactId, contactType: v })}
            >
              <SelectTrigger
                className="h-6 w-auto gap-1 border-none px-1.5 text-xs bg-secondary rounded-full [&>svg]:h-3 [&>svg]:w-3"
                data-testid={`select-contact-type-${row.contactId}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {row.contact.phone && (
              <a href={`tel:${row.contact.phone}`} className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground whitespace-nowrap">
                <Phone className="h-3 w-3" />{row.contact.phone}
              </a>
            )}
            {row.contact.email && (
              <a href={`mailto:${row.contact.email}`} className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground truncate max-w-[180px]">
                <Mail className="h-3 w-3 shrink-0" />{row.contact.email}
              </a>
            )}
            <button
              className="text-muted-foreground hover:text-destructive"
              disabled={detach.isPending}
              onClick={() => detach.mutate(row.contactId)}
              aria-label={`Remove ${contactName(row.contact)}`}
              data-testid={`button-detach-contact-${row.contactId}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setAddOpen(true)} data-testid="button-add-contact">
          <Plus className="h-3.5 w-3.5" />
          Add contact
        </Button>
      </div>
      <AddContactDialog
        projectId={projectId}
        open={addOpen}
        onOpenChange={setAddOpen}
        attachedContactIds={new Set((rows ?? []).map((r) => r.contactId))}
      />
    </div>
  );
}

// ── Account directory card (settings) ─────────────────────────────────────

export function ContactsDirectoryCard() {
  const canManage = useCanManageContacts();
  const { toast } = useToast();
  const [editing, setEditing] = useState<ContactWithCount | null>(null);
  const [form, setForm] = useState<ContactFormValues>(EMPTY_FORM);

  const { data: rows, isLoading } = useQuery<ContactWithCount[]>({
    queryKey: ["/api/contacts"],
    enabled: canManage,
  });

  const update = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/contacts/${id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact updated" });
      setEditing(null);
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/contacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact deleted" });
    },
    onError: (e: Error) => {
      // The server 409s with "attached to N projects..." — surface it as-is.
      toast({ title: "Couldn't delete", description: e.message, variant: "destructive" });
    },
  });

  if (!canManage) return null;

  const openEdit = (c: ContactWithCount) => {
    setEditing(c);
    setForm({
      firstName: c.firstName ?? "",
      lastName: c.lastName ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      address: c.address ?? "",
      notes: c.notes ?? "",
    });
  };

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-6" data-testid="card-contacts-directory">
      <div className="flex items-center gap-2 mb-1">
        <UserRound className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Contacts</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Client contacts across all projects. Attach them to projects from the project page.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : (rows ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-contacts">
          No contacts yet. Add one from a project's Contacts section.
        </p>
      ) : (
        <div className="space-y-2">
          {(rows ?? []).map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid={`row-directory-contact-${c.id}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {contactName(c)}
                  <Badge variant="secondary" className="ml-2 text-xs font-normal">
                    {c.projectCount} project{c.projectCount === 1 ? "" : "s"}
                  </Badge>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {[c.email, c.phone, c.address].filter(Boolean).join(" · ") || "No details"}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => openEdit(c)} data-testid={`button-edit-contact-${c.id}`}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(c.id)}
                  data-testid={`button-delete-contact-${c.id}`}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-edit-contact">
          <DialogHeader>
            <DialogTitle>Edit contact</DialogTitle>
          </DialogHeader>
          <ContactFields values={form} onChange={setForm} idPrefix="edit" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              disabled={!form.firstName.trim() || update.isPending}
              onClick={() => editing && update.mutate({ id: editing.id, body: toPayload(form) })}
              data-testid="button-save-contact"
            >
              {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
