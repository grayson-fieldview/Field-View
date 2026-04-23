import { useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function CheckEmailPage() {
  const { toast } = useToast();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const email = params.get("email") || "";

  const resendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err: any = new Error(data.error || data.message || "Request failed");
        err.status = res.status;
        throw err;
      }
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Verification email sent",
        description: data.message || "Check your inbox for the verification link.",
      });
    },
    onError: (error: any) => {
      toast({
        title: error.status === 429 ? "Too many requests" : "Couldn't resend email",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardContent className="pt-8 text-center space-y-4">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          <div className="mx-auto w-12 h-12 rounded-full bg-[#267D32]/10 flex items-center justify-center">
            <Mail className="h-6 w-6 text-[#267D32]" />
          </div>
          <h2 className="text-xl font-semibold" data-testid="text-check-email-title">Check your email</h2>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to{" "}
            <strong data-testid="text-check-email-address">{email || "your email"}</strong>. Click the link to activate
            your account.
          </p>
          <p className="text-xs text-muted-foreground">
            The link will expire in 1 hour. Don't see it? Check your spam folder.
          </p>
          <Button
            onClick={() => resendMutation.mutate()}
            disabled={resendMutation.isPending || !email}
            variant="outline"
            className="w-full"
            data-testid="button-resend-verification"
          >
            {resendMutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              "Resend email"
            )}
          </Button>
          <a
            href="/login"
            className="inline-flex items-center gap-1 text-sm text-[#F09000] hover:underline font-medium"
            data-testid="link-back-to-login"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
