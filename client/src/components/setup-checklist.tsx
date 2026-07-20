// Persistent 3-item setup checklist shown at the top of the dashboard until
// the account "activates" (>= 1 project AND >= 5 photos). Reads only data
// the dashboard already fetches (/api/projects, /api/activity) plus the
// auth user's accountFirstMobileUploadAt — no new requests. Visible to all
// roles; disappears entirely once activated.

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_DOWNLOAD_PAGE_URL } from "@/lib/appLinks";
import { CheckCircle2, Circle, QrCode } from "lucide-react";

export const ACTIVATION_PHOTO_TARGET = 5;

export function isAccountActivated(projectCount: number, totalPhotos: number): boolean {
  return projectCount >= 1 && totalPhotos >= ACTIVATION_PHOTO_TARGET;
}

function ChecklistRow({
  done,
  label,
  detail,
  action,
  testId,
}: {
  done: boolean;
  label: string;
  detail?: string;
  action?: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2" data-testid={testId}>
      {done ? (
        <CheckCircle2 className="h-5 w-5 text-[#267D32] shrink-0" />
      ) : (
        <Circle className="h-5 w-5 text-muted-foreground shrink-0" />
      )}
      <span className={done ? "text-sm line-through text-muted-foreground" : "text-sm"}>
        {label}
      </span>
      {detail && (
        <span className="text-sm text-muted-foreground ml-auto tabular-nums">{detail}</span>
      )}
      {!detail && action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

export function SetupChecklist({
  projectCount,
  totalPhotos,
}: {
  projectCount: number;
  totalPhotos: number;
}) {
  const { user } = useAuth();
  const [qrOpen, setQrOpen] = useState(false);

  if (isAccountActivated(projectCount, totalPhotos)) return null;

  const hasMobileUpload = !!(user as any)?.accountFirstMobileUploadAt;
  const photosDone = totalPhotos >= ACTIVATION_PHOTO_TARGET;

  return (
    <Card className="p-4 sm:p-6" data-testid="card-setup-checklist">
      <h2 className="text-base font-semibold mb-1">Finish setting up Field View</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Teams that finish these three steps get the most out of their trial.
      </p>
      <div className="divide-y">
        <ChecklistRow
          done={projectCount >= 1}
          label="Create a project"
          testId="checklist-item-project"
        />
        <ChecklistRow
          done={hasMobileUpload}
          label="Get the mobile app"
          action={
            !hasMobileUpload && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setQrOpen(true)}
                data-testid="button-checklist-show-qr"
              >
                <QrCode className="h-4 w-4 mr-2" />
                Show QR
              </Button>
            )
          }
          testId="checklist-item-mobile"
        />
        <ChecklistRow
          done={photosDone}
          label="Add 5 photos"
          detail={`${Math.min(totalPhotos, ACTIVATION_PHOTO_TARGET)}/${ACTIVATION_PHOTO_TARGET}`}
          testId="checklist-item-photos"
        />
      </div>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Get the Field View app</DialogTitle>
            <DialogDescription>
              Scan with your phone camera to download the app.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-2 py-2">
            <a
              href={APP_DOWNLOAD_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-checklist-qr"
            >
              <img
                src="/get-app-qr.svg"
                alt="QR code linking to the Field View mobile app"
                width={160}
                height={160}
                className="rounded"
                data-testid="img-checklist-qr"
              />
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
