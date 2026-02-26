import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Mail } from "lucide-react";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function ForgotPasswordPage() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Request failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    resetMutation.mutate();
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
        <Card className="w-full max-w-md shadow-lg border-0">
          <CardContent className="pt-8 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-[#267D32]/10 flex items-center justify-center">
              <Mail className="h-6 w-6 text-[#267D32]" />
            </div>
            <h2 className="text-xl font-semibold" data-testid="text-email-sent">Check your email</h2>
            <p className="text-sm text-muted-foreground">
              If an account exists for <strong>{email}</strong>, we've sent password reset instructions.
            </p>
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F0EDEA] dark:bg-gray-950 px-4">
      <Card className="w-full max-w-md shadow-lg border-0">
        <CardHeader className="text-center space-y-4 pb-2">
          <div className="flex items-center justify-center gap-2">
            <img src={faviconImg} alt="Field View" className="h-8 w-8" />
            <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
          </div>
          <CardTitle className="text-2xl" data-testid="text-forgot-title">Reset password</CardTitle>
          <CardDescription>Enter your email and we'll send you a reset link</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>
            <Button
              type="submit"
              className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
              disabled={resetMutation.isPending}
              data-testid="button-reset"
            >
              {resetMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send Reset Link"
              )}
            </Button>
          </form>
          <div className="mt-6 text-center">
            <a
              href="/login"
              className="inline-flex items-center gap-1 text-sm text-[#F09000] hover:underline font-medium"
              data-testid="link-back-to-login"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
