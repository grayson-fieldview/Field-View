import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Camera, Loader2 } from "lucide-react";
import type { AccountSettings, PhotoAspectRatio } from "@shared/schema";

const OPTIONS: { value: PhotoAspectRatio; label: string }[] = [
  { value: "4:3", label: "4:3 (Standard)" },
  { value: "1:1", label: "1:1 (Square)" },
  { value: "16:9", label: "16:9 (Widescreen)" },
];

export function AccountSettingsCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const { data, isLoading, isError, refetch } = useQuery<AccountSettings>({ queryKey: ["/api/account/settings"] });

  const [selected, setSelected] = useState<PhotoAspectRatio | null>(null);
  useEffect(() => {
    if (data) setSelected(data.defaultPhotoAspectRatio);
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (value: PhotoAspectRatio) => {
      const res = await apiRequest("PATCH", "/api/account/settings", { defaultPhotoAspectRatio: value });
      return (await res.json()) as AccountSettings;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/account/settings"], next);
      queryClient.invalidateQueries({ queryKey: ["/api/account/settings"] });
      toast({ title: "Default aspect ratio updated" });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't save", description: e?.message ?? "Please try again", variant: "destructive" });
    },
  });

  // Server-side requireAdmin is the real boundary; this hides the UI
  // entirely for non-admins so they don't see a setting they can't change.
  if (!isAdmin) return null;

  const dirty = selected !== null && data !== undefined && selected !== data.defaultPhotoAspectRatio;
  const disabled = isLoading || mutation.isPending || !selected;

  return (
    <Card className="p-6" data-testid="card-account-settings">
      <div className="flex items-center gap-2 mb-1">
        <Camera className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Photo Capture</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Default aspect ratio for the in-app camera. Affects all team members.
      </p>

      {isError ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3" data-testid="error-account-settings">
          <p className="text-sm text-destructive">Couldn't load settings.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-account-settings">
            Retry
          </Button>
        </div>
      ) : isLoading || !selected ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          <RadioGroup
            value={selected}
            onValueChange={(v) => setSelected(v as PhotoAspectRatio)}
            className="space-y-2"
          >
            {OPTIONS.map((opt) => (
              <div key={opt.value} className="flex items-center gap-3 rounded-md border p-3 hover-elevate">
                <RadioGroupItem
                  value={opt.value}
                  id={`aspect-ratio-${opt.value}`}
                  data-testid={`radio-aspect-ratio-${opt.value}`}
                />
                <Label htmlFor={`aspect-ratio-${opt.value}`} className="flex-1 cursor-pointer text-sm font-medium">
                  {opt.label}
                </Label>
              </div>
            ))}
          </RadioGroup>

          <p className="text-xs text-muted-foreground mt-3" data-testid="text-aspect-ratio-helper">
            Existing photos keep their captured ratio. This setting only affects new captures.
          </p>

          <div className="flex justify-end mt-4">
            <Button
              onClick={() => selected && mutation.mutate(selected)}
              disabled={disabled || !dirty}
              data-testid="button-save-aspect-ratio"
            >
              {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
