import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SiGoogle, SiApple } from "react-icons/si";

type Providers = { google: boolean; microsoft: boolean; apple?: boolean };

/**
 * OAuth sign-in row: Google (rendered only when the server reports it
 * enabled) and Apple (always rendered; disabled with "Coming soon" until
 * the server reports providers.apple === true — /api/auth/apple does not
 * exist yet, so the disabled state must not link anywhere).
 *
 * If the /api/auth/providers fetch fails, renders nothing at all so a
 * server problem never shows a broken auth row.
 */
export function SocialAuthButtons({
  inviteToken,
  showTermsNote = false,
}: {
  inviteToken?: string | null;
  /** Register page only: consent note below the button row. */
  showTermsNote?: boolean;
}) {
  const { data: providers } = useQuery<Providers>({
    queryKey: ["/api/auth/providers"],
  });
  if (!providers) return null;

  const qs = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  const appleEnabled = providers.apple === true;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {providers.google === true && (
          <Button asChild variant="outline" className="w-full" data-testid="button-google-auth">
            <a href={`/api/auth/google${qs}`}>
              <SiGoogle className="mr-2 h-4 w-4" />
              Google
            </a>
          </Button>
        )}
        {appleEnabled ? (
          <Button asChild variant="outline" className="w-full" data-testid="button-apple-auth">
            <a href={`/api/auth/apple${qs}`}>
              <SiApple className="mr-2 h-4 w-4" />
              Apple
            </a>
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-full opacity-50 cursor-not-allowed"
            aria-disabled="true"
            onClick={(e) => e.preventDefault()}
            data-testid="button-apple-auth"
            title="Coming soon"
          >
            <SiApple className="mr-2 h-4 w-4" />
            Apple
            <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">Soon</span>
          </Button>
        )}
      </div>
      {showTermsNote && (
        <p className="text-xs text-muted-foreground">
          By continuing, you agree to the{" "}
          <a
            href="https://www.field-view.com/legal/terms-and-conditions"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#F09000] underline hover:no-underline"
            data-testid="link-terms-oauth"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="https://www.field-view.com/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#F09000] underline hover:no-underline"
            data-testid="link-privacy-oauth"
          >
            Privacy Policy
          </a>
        </p>
      )}
      <div className="relative my-2">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">or</span>
        </div>
      </div>
    </div>
  );
}
