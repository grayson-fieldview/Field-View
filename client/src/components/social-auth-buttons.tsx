import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SiApple } from "react-icons/si";

type Providers = { google: boolean; microsoft: boolean; apple?: boolean };

/** Google's official four-color "G" mark (standard brand colors). */
function GoogleGIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

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
  action = "signup",
}: {
  inviteToken?: string | null;
  /** Register page only: consent note below the button row. */
  showTermsNote?: boolean;
  /** Verb on the buttons: "Sign in with …" (login) vs "Sign up with …" (register). */
  action?: "signin" | "signup";
}) {
  const { data: providers } = useQuery<Providers>({
    queryKey: ["/api/auth/providers"],
  });
  if (!providers) return null;

  const qs = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
  const appleEnabled = providers.apple === true;
  const verb = action === "signin" ? "Sign in" : "Sign up";
  const buttonFill =
    "w-full bg-[#F1F3F6] border-transparent hover:bg-[#E7EAEF] text-foreground";

  return (
    <div className="space-y-2">
      <div className={providers.google === true ? "grid grid-cols-2 gap-2" : "grid grid-cols-1 gap-2"}>
        {providers.google === true && (
          <Button asChild variant="outline" className={buttonFill} data-testid="button-google-auth">
            <a href={`/api/auth/google${qs}`}>
              <GoogleGIcon className="mr-2 h-4 w-4" />
              {verb} with Google
            </a>
          </Button>
        )}
        {appleEnabled ? (
          <Button asChild variant="outline" className={buttonFill} data-testid="button-apple-auth">
            <a href={`/api/auth/apple${qs}`}>
              <SiApple className="mr-2 h-4 w-4" />
              {verb} with Apple
            </a>
          </Button>
        ) : (
          <Button
            variant="outline"
            className={`${buttonFill} opacity-50 cursor-not-allowed`}
            aria-disabled="true"
            onClick={(e) => e.preventDefault()}
            data-testid="button-apple-auth"
            title="Coming soon"
          >
            <SiApple className="mr-2 h-4 w-4" />
            {verb} with Apple
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
            className="text-[#f09004] underline hover:no-underline"
            data-testid="link-terms-oauth"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="https://www.field-view.com/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#f09004] underline hover:no-underline"
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
