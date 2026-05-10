import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import type { EditorMode, Section, SectionPhoto } from "./types";

export function SectionEditor(props: {
  section: Section;
  onChange: (updates: Partial<Section>) => void;
  onPhotoChange: (photoId: number, updates: Partial<SectionPhoto>) => void;
  onAddPhotos: () => void;
  onDeletePhoto: (photoId: number) => void;
  onDeleteSection: () => void;
  mode?: EditorMode;
}) {
  const { section, onChange, onPhotoChange, onAddPhotos, onDeletePhoto, onDeleteSection, mode = "report" } = props;
  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid={`pane-section-${section.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold mb-1">Section</h2>
          <p className="text-sm text-muted-foreground">Title, summary, and photos with optional captions.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDeleteSection} data-testid="button-delete-section">
          <Trash2 className="h-4 w-4 mr-1.5" />
          Delete section
        </Button>
      </div>

      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="section-title">Title</Label>
          <Input
            id="section-title"
            value={section.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Untitled Section"
            data-testid="input-section-title"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="section-summary">Summary</Label>
          <Textarea
            id="section-summary"
            value={section.summary ?? ""}
            onChange={(e) => onChange({ summary: e.target.value })}
            placeholder="Optional context for this section..."
            className="min-h-[100px]"
            data-testid="input-section-summary"
          />
        </div>
      </Card>

      {mode !== "template" && (
      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Photos ({section.photos.length})</h3>
          <Button variant="outline" size="sm" onClick={onAddPhotos} data-testid="button-add-photos">
            <Plus className="h-4 w-4 mr-1.5" />
            Add photos
          </Button>
        </div>
        {section.photos.length === 0 ? (
          <div className="text-center py-8 border-2 border-dashed rounded-md">
            <ImageIcon className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No photos in this section yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {section.photos.map((p) => (
              <div key={p.id} className="flex gap-3 p-3 rounded-md border" data-testid={`row-section-photo-${p.id}`}>
                <img src={p.media.url} alt="" className="h-24 w-24 object-cover rounded-md shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <Input
                    value={p.caption ?? ""}
                    placeholder="Caption (optional)"
                    onChange={(e) => onPhotoChange(p.id, { caption: e.target.value })}
                    data-testid={`input-photo-caption-${p.id}`}
                  />
                  <Textarea
                    value={p.description ?? ""}
                    placeholder="Description (optional)"
                    onChange={(e) => onPhotoChange(p.id, { description: e.target.value })}
                    className="min-h-[60px]"
                    data-testid={`input-photo-description-${p.id}`}
                  />
                </div>
                <Button variant="ghost" size="icon" onClick={() => onDeletePhoto(p.id)} data-testid={`button-delete-photo-${p.id}`}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      )}
    </div>
  );
}
