import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Smartphone, X } from "lucide-react";
import { APP_STORE_URL, PLAY_STORE_URL, APP_DOWNLOAD_PAGE_URL } from "@/lib/appLinks";
import { detectDeviceOS } from "@/lib/device";

const MODAL_SEEN_KEY = "fv_app_prompt_seen";
const BANNER_DISMISSED_KEY = "fv_app_banner_dismissed";
const BANNER_SHOWN_KEY = "fv_app_banner_shown";
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

type Surface = "modal" | "banner";
type Action = "shown" | "clicked_ios" | "clicked_android" | "dismissed";

// Fire-and-forget telemetry — failures are silent by design; an analytics
// hiccup must never affect the UI.
function logAppInstallPromptEvent(surface: Surface, action: Action): void {
  try {
    fetch("/api/app-install-prompt-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ surface, action }),
    }).catch(() => {});
  } catch {}
}

function safeGetStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null; // Safari private mode etc.
  }
}

function safeSetStorage(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {}
}

// Store CTA buttons shared by modal and (conceptually) banner. Device-aware:
// phones see only their own store; desktop sees both.
function StoreButtons({ surface, onClicked }: { surface: Surface; onClicked?: () => void }) {
  const os = detectDeviceOS();
  const showIos = os === "ios" || os === "desktop";
  const showAndroid = os === "android" || os === "desktop";
  return (
    <div className="flex flex-col sm:flex-row gap-2 w-full">
      {showIos && (
        <Button
          asChild
          className="bg-[#F09000] hover:bg-[#d98000] text-white flex-1"
          data-testid={`button-app-${surface}-ios`}
        >
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              logAppInstallPromptEvent(surface, "clicked_ios");
              onClicked?.();
            }}
          >
            Download on the App Store
          </a>
        </Button>
      )}
      {showAndroid && (
        <Button
          asChild
          variant={showIos ? "outline" : undefined}
          className={showIos ? "flex-1" : "bg-[#F09000] hover:bg-[#d98000] text-white flex-1"}
          data-testid={`button-app-${surface}-android`}
        >
          <a
            href={PLAY_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              logAppInstallPromptEvent(surface, "clicked_android");
              onClicked?.();
            }}
          >
            Get it on Google Play
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * One-time install-prompt modal + persistent slim banner.
 *
 * Modal shows once (localStorage-gated) for accounts created in the last 14
 * days that have never uploaded from the mobile app. Banner persists until
 * the account's first mobile upload, dismissible per-session.
 */
export function AppInstallPrompt() {
  const { user } = useAuth();

  const firstMobileUploadAt = (user as any)?.accountFirstMobileUploadAt ?? null;
  const accountCreatedAt = (user as any)?.accountCreatedAt ?? null;

  const [modalOpen, setModalOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => safeGetStorage(typeof window !== "undefined" ? window.sessionStorage : undefined, BANNER_DISMISSED_KEY) === "1",
  );
  const modalDecidedRef = useRef(false);

  useEffect(() => {
    if (modalDecidedRef.current) return;
    if (!user) return;
    modalDecidedRef.current = true;
    if (firstMobileUploadAt) return;
    const createdMs = accountCreatedAt ? new Date(accountCreatedAt).getTime() : NaN;
    if (!Number.isFinite(createdMs) || Date.now() - createdMs > FOURTEEN_DAYS_MS) return;
    if (safeGetStorage(window.localStorage, MODAL_SEEN_KEY)) return;
    safeSetStorage(window.localStorage, MODAL_SEEN_KEY, "1");
    setModalOpen(true);
    logAppInstallPromptEvent("modal", "shown");
  }, [user, firstMobileUploadAt, accountCreatedAt]);

  // Banner impression: log once per browser session (sessionStorage-throttled
  // so remounts within the same tab don't overcount).
  const showBanner = !!user && !firstMobileUploadAt && !modalOpen && !bannerDismissed;
  useEffect(() => {
    if (showBanner && !safeGetStorage(window.sessionStorage, BANNER_SHOWN_KEY)) {
      safeSetStorage(window.sessionStorage, BANNER_SHOWN_KEY, "1");
      logAppInstallPromptEvent("banner", "shown");
    }
  }, [showBanner]);

  if (!user) return null;

  const os = detectDeviceOS();
  // Banner always links to the marketing download page (device-agnostic);
  // the click action keeps its device attribution for telemetry.
  const bannerClickAction: Action = os === "android" ? "clicked_android" : "clicked_ios";

  return (
    <>
      <Dialog
        open={modalOpen}
        onOpenChange={(v) => {
          if (!v) {
            logAppInstallPromptEvent("modal", "dismissed");
            setModalOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md" data-testid="dialog-app-install">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold text-[#F09000]" data-testid="text-app-install-title">
              Field View works from the job site
            </DialogTitle>
            <DialogDescription className="text-base text-foreground/80">
              Get the app so photos file themselves to the right project —
              automatically tagged with GPS, time, and who took them.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            {detectDeviceOS() === "desktop" ? (
              /* Desktop: QR instead of store buttons — encodes
                 https://field-view.com/app (the marketing download page).
                 Static SVG in client/public (no QR library, per constraints). */
              <div className="flex flex-col items-center gap-2">
                <a
                  href={APP_DOWNLOAD_PAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-app-install-qr"
                >
                  <img
                    src="/get-app-qr.svg"
                    alt="QR code linking to the Field View mobile app"
                    width={160}
                    height={160}
                    className="rounded"
                    data-testid="img-app-install-qr"
                  />
                </a>
                <p className="text-sm text-muted-foreground" data-testid="text-app-install-qr-caption">
                  Scan with your phone camera to get the app
                </p>
              </div>
            ) : (
              <StoreButtons surface="modal" />
            )}
          </div>
          <DialogFooter>
            {/* Dismiss telemetry fires only in onOpenChange to avoid
                double-logging (this close path also triggers it). */}
            <Button
              variant="ghost"
              onClick={() => setModalOpen(false)}
              data-testid="button-app-install-close"
            >
              Maybe later
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating card: fixed bottom-right on desktop (~360px), full-width
          with side margins on mobile. z-40 sits above page content but below
          shadcn Dialog overlays (z-50), so the modal always covers it. */}
      {showBanner && (
        <div
          className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 sm:w-[360px] z-40 flex items-start gap-3 rounded-xl border border-border bg-[#1E1E1E] text-white p-4 shadow-lg"
          data-testid="banner-app-install"
        >
          <Smartphone className="h-5 w-5 shrink-0 mt-0.5 text-[#F09000]" />
          <div className="min-w-0 text-sm">
            Get the mobile app — photos auto-file from the field.{" "}
            <a
              href={APP_DOWNLOAD_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium text-[#F09000] hover:text-[#ffb340]"
              onClick={() => logAppInstallPromptEvent("banner", bannerClickAction)}
              data-testid="link-app-install-banner"
            >
              Download it here
            </a>
          </div>
          <button
            type="button"
            className="ml-auto -mr-1 -mt-1 p-1 rounded hover:bg-white/10"
            aria-label="Dismiss"
            onClick={() => {
              safeSetStorage(window.sessionStorage, BANNER_DISMISSED_KEY, "1");
              setBannerDismissed(true);
              logAppInstallPromptEvent("banner", "dismissed");
            }}
            data-testid="button-app-banner-dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  );
}
