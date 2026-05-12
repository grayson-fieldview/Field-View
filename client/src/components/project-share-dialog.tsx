import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
} from "@/components/ui/alert-dialog";
import { Copy, Link2, Loader2, Trash2 } from "lucide-react";

interface ProjectShareDialogProps {
  projectId: number;
  shareToken: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ProjectShareDialog({ projectId, shareToken, open, onOpenChange }: ProjectShareDialogProps) {
  const { toast } = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const shareUrl = shareToken ? `${window.location.origin}/p/${shareToken}` : "";

  const generate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/share`);
      return (await res.json()) as { shareToken: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({ title: "Share link created" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't create link", description: e.message, variant: "destructive" });
    },
  });

  const revoke = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${projectId}/share`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setConfirmRevoke(false);
      toast({ title: "Share link revoked" });
    },
    onError: (e: Error) => {
      toast({ title: "Couldn't revoke link", description: e.message, variant: "destructive" });
    },
  });

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select and copy manually.", variant: "destructive" });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="dialog-share-project">
          <DialogHeader>
            <DialogTitle>Share Project</DialogTitle>
            <DialogDescription>
              Anyone with the link can view a read-only summary of this project — no login required.
              You can revoke access at any time.
            </DialogDescription>
          </DialogHeader>

          {!shareToken ? (
            <div className="py-4">
              <Button
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
                className="w-full"
                data-testid="button-generate-project-share-link"
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4 mr-2" />
                )}
                {generate.isPending ? "Generating..." : "Generate shareable link"}
              </Button>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2">
                <Input
                  value={shareUrl}
                  readOnly
                  className="font-mono text-xs"
                  data-testid="input-project-share-url"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" size="icon" onClick={copyToClipboard} data-testid="button-copy-project-share-link">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Button
                variant="destructive"
                onClick={() => setConfirmRevoke(true)}
                disabled={revoke.isPending}
                className="w-full"
                data-testid="button-revoke-project-share-link"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Revoke link
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="button-project-share-dialog-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent data-testid="dialog-confirm-revoke-project-share">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke share link?</AlertDialogTitle>
            <AlertDialogDescription>
              The current link will stop working immediately. Anyone you've sent it to will no longer be able to view the project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-revoke-project-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
              data-testid="button-confirm-revoke-project-confirm"
            >
              {revoke.isPending ? "Revoking..." : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
