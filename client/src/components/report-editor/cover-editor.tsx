import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Image as ImageIcon } from "lucide-react";
import type { CoverConfig, EditorMode } from "./types";

export function CoverEditor(props: {
  title: string;
  description: string;
  cover: CoverConfig;
  coverPhotoUrl: string | null;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCoverChange: (c: CoverConfig) => void;
  onPickCoverPhoto: () => void;
  onClearCoverPhoto: () => void;
  mode?: EditorMode;
}) {
  const {
    title,
    description,
    cover,
    coverPhotoUrl,
    onTitleChange,
    onDescriptionChange,
    onCoverChange,
    onPickCoverPhoto,
    onClearCoverPhoto,
    mode = "report",
  } = props;
  const toggles: { key: keyof CoverConfig; label: string }[] = useMemo(() => [
    { key: "showCoverPhoto", label: "Cover photo" },
    { key: "showCompanyLogo", label: "Company logo" },
    { key: "showCompanyName", label: "Company name" },
    { key: "showCreatorName", label: "Created by name" },
    { key: "showPhotoCount", label: "Photo count" },
    { key: "showDateCreated", label: "Date created" },
  ], []);

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="pane-cover">
      <div>
        <h2 className="text-lg font-semibold mb-1">Cover Page</h2>
        <p className="text-sm text-muted-foreground">Title and description always render. Toggle which optional fields appear.</p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cover-title">Title</Label>
          <Input
            id="cover-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Untitled Report"
            data-testid="input-report-title"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cover-description">Description</Label>
          <Textarea
            id="cover-description"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Add a short description of this report (optional)..."
            className="min-h-[100px]"
            data-testid="input-report-description"
          />
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">Show on cover</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {toggles.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-3 p-3 rounded-md border">
              <Label htmlFor={`toggle-${key}`} className="text-sm font-normal cursor-pointer">{label}</Label>
              <Switch
                id={`toggle-${key}`}
                checked={Boolean(cover[key])}
                onCheckedChange={(checked) => onCoverChange({ ...cover, [key]: checked })}
                data-testid={`switch-${key}`}
              />
            </div>
          ))}
        </div>
      </Card>

      {mode !== "template" && (
      <Card className="p-4 space-y-3" data-testid="card-cover-photo-override">
        <h3 className="text-sm font-semibold">Cover Photo</h3>
        {cover.coverPhotoMediaId && coverPhotoUrl ? (
          <div className="flex items-center gap-3">
            <img
              src={coverPhotoUrl}
              alt="Selected cover"
              className="h-20 w-20 rounded object-cover border"
              data-testid="img-cover-override-thumb"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onPickCoverPhoto}
                data-testid="button-change-cover-photo"
              >
                Change
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearCoverPhoto}
                data-testid="button-clear-cover-photo"
              >
                Use project default
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1">
              Will use project default cover photo.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onPickCoverPhoto}
              data-testid="button-choose-cover-photo"
            >
              <ImageIcon className="h-4 w-4 mr-1.5" />
              Choose cover photo
            </Button>
          </div>
        )}
      </Card>
      )}
    </div>
  );
}
