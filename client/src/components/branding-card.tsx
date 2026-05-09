import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, Loader2, Upload, X } from "lucide-react";

type Branding = {
  companyLogoUrl: string | null;
  companyLegalName: string | null;
  companyAddress: string | null;
};

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export function BrandingCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canEdit = user?.role === "admin" || user?.role === "manager";

  const { data, isLoading } = useQuery<Branding>({ queryKey: ["/api/account/branding"] });

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Initialize local state from server data once it arrives.
  useEffect(() => {
    if (!data) return;
    setLogoUrl(data.companyLogoUrl);
    setLegalName(data.companyLegalName ?? "");
    setAddress(data.companyAddress ?? "");
    setLogoFile(null);
    setLogoPreview(null);
  }, [data]);

  // Build/revoke object URL for staged file preview.
  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  const initial: Branding = {
    companyLogoUrl: data?.companyLogoUrl ?? null,
    companyLegalName: data?.companyLegalName ?? null,
    companyAddress: data?.companyAddress ?? null,
  };
  const current: Branding & { hasStagedFile: boolean } = {
    companyLogoUrl: logoUrl,
    companyLegalName: legalName.trim() ? legalName : null,
    companyAddress: address.trim() ? address : null,
    hasStagedFile: !!logoFile,
  };
  const isDirty =
    current.hasStagedFile ||
    current.companyLogoUrl !== initial.companyLogoUrl ||
    current.companyLegalName !== initial.companyLegalName ||
    current.companyAddress !== initial.companyAddress;

  function pickFile(file: File | null) {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast({
        title: "Unsupported file type",
        description: "Logo must be a PNG, JPEG, or WebP image.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({
        title: "File too large",
        description: "Logo must be 5 MB or smaller.",
        variant: "destructive",
      });
      return;
    }
    setLogoFile(file);
  }

  function handleRemove() {
    setLogoFile(null);
    setLogoUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      let nextLogoUrl = logoUrl;
      if (logoFile) {
        const signRes = await apiRequest("POST", "/api/uploads/sign", {
          files: [
            {
              originalName: logoFile.name,
              mimeType: logoFile.type,
              fileSize: logoFile.size,
              folder: "branding",
            },
          ],
        });
        const signed = (await signRes.json()) as { uploadUrl: string; publicUrl: string }[];
        const { uploadUrl, publicUrl } = signed[0];
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": logoFile.type },
          body: logoFile,
        });
        if (!putRes.ok) throw new Error("Logo upload to S3 failed");
        nextLogoUrl = publicUrl;
      }
      const patchRes = await apiRequest("PATCH", "/api/account/branding", {
        companyLogoUrl: nextLogoUrl,
        companyLegalName: current.companyLegalName,
        companyAddress: current.companyAddress,
      });
      return (await patchRes.json()) as Branding;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/account/branding"] });
      toast({ title: "Branding updated." });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't save branding", description: e.message, variant: "destructive" }),
  });

  async function onSave() {
    setIsSaving(true);
    try {
      await saveMutation.mutateAsync();
    } finally {
      setIsSaving(false);
    }
  }

  const previewSrc = logoPreview ?? logoUrl;
  const inputsDisabled = !canEdit || isSaving;

  return (
    <Card className="p-6" data-testid="card-branding">
      <div className="flex items-center gap-2 mb-1">
        <Building2 className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Company Branding</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">These fields appear on PDF reports.</p>

      {!canEdit && (
        <p
          className="text-xs text-muted-foreground mb-4 italic"
          data-testid="text-branding-readonly-note"
        >
          Only account admins can edit branding.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-20 rounded" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <label className="text-sm font-medium block mb-2">Company Logo</label>
            <div className="flex items-start gap-4">
              {previewSrc ? (
                <div
                  className="h-20 w-20 rounded border border-border bg-background flex items-center justify-center overflow-hidden flex-shrink-0"
                  data-testid="img-branding-logo-preview"
                >
                  <img
                    src={previewSrc}
                    alt="Company logo"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div
                  className={`h-20 w-20 rounded border-2 border-dashed flex items-center justify-center flex-shrink-0 transition-colors ${
                    isDragging ? "border-primary bg-primary/5" : "border-border"
                  } ${inputsDisabled ? "opacity-50" : "cursor-pointer hover:border-primary"}`}
                  onClick={() => !inputsDisabled && fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    if (inputsDisabled) return;
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    if (inputsDisabled) return;
                    e.preventDefault();
                    setIsDragging(false);
                    pickFile(e.dataTransfer.files?.[0] ?? null);
                  }}
                  data-testid="dropzone-branding-logo"
                >
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={inputsDisabled}
                    data-testid="button-branding-logo-upload"
                  >
                    <Upload className="h-4 w-4 mr-1.5" />
                    {previewSrc ? "Replace logo" : "Upload logo"}
                  </Button>
                  {previewSrc && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemove}
                      disabled={inputsDisabled}
                      data-testid="button-branding-logo-remove"
                    >
                      <X className="h-4 w-4 mr-1.5" />
                      Remove logo
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP. Up to 5 MB.</p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                pickFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              data-testid="input-branding-logo-file"
            />
          </div>

          <div>
            <label
              htmlFor="branding-legal-name"
              className="text-sm font-medium block mb-2"
            >
              Legal name
            </label>
            <Input
              id="branding-legal-name"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              maxLength={200}
              disabled={inputsDisabled}
              placeholder="Acme Construction LLC"
              data-testid="input-branding-legal-name"
            />
          </div>

          <div>
            <label
              htmlFor="branding-address"
              className="text-sm font-medium block mb-2"
            >
              Address
            </label>
            <Textarea
              id="branding-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={inputsDisabled}
              placeholder="123 Main St, Suite 200&#10;Springfield, IL 62701"
              data-testid="input-branding-address"
            />
          </div>

          {canEdit && (
            <div className="flex justify-end">
              <Button
                onClick={onSave}
                disabled={!isDirty || isSaving}
                data-testid="button-branding-save"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
