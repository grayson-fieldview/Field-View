import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Star } from "lucide-react";
import { INDUSTRIES, COMPANY_SIZES } from "@shared/constants";
import faviconImg from "@assets/Favicon-01-brand_1778259672.png";

// Shared input styling: white background, grey-300 outline, brand-orange focus.
// Override on each usage so we don't touch the global Input/SelectTrigger
// components. Tech debt: this string is duplicated on register.tsx (trial
// branch); if the styling rules change, update both pages.
const FIELD_CLASS =
  "bg-white border-2 border-slate-300 focus:border-[#F09000] focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none";

export default function WelcomePage() {
  const [, setLocation] = useLocation();
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const isAdmin = (user as any)?.role === "admin";

  const [firstName, setFirstName] = useState((user as any)?.firstName ?? "");
  const [lastName, setLastName] = useState((user as any)?.lastName ?? "");
  const [phone, setPhone] = useState("");
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [tcpaAccepted, setTcpaAccepted] = useState(false);

  const submit = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
      };
      if (isAdmin) {
        body.industry = industry;
        body.companySize = companySize;
      }
      const res = await apiRequest("PATCH", "/api/auth/me", body);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/user"] });
      setLocation("/verify-email");
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't save your profile",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: "Name required", description: "Please enter your first and last name.", variant: "destructive" });
      return;
    }
    if (!tcpaAccepted) {
      toast({ title: "Consent required", description: "Please accept the SMS consent to continue.", variant: "destructive" });
      return;
    }
    submit.mutate();
  };

  // NOTE: Left peach panel JSX duplicated from client/src/pages/register.tsx
  // (trial branch). Verification #1 of the spec mandates "exactly 2 files
  // changed" so we can't extract a shared <SignupLeftPanel /> component yet.
  // Tech debt: any future edit to the left-panel copy/styling must be made in
  // BOTH this file and register.tsx.
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 p-3 sm:p-4">
      <div className="grid grid-cols-1 md:grid-cols-[40%_1fr] gap-3 sm:gap-4 min-h-[calc(100vh-1.5rem)] sm:min-h-[calc(100vh-2rem)]">
        {/* Left peach panel */}
        <div
          className="bg-[#fceed8] rounded-3xl p-8 sm:p-10 lg:p-14 flex flex-col justify-between min-h-[400px] md:min-h-0"
          data-testid="panel-brand"
        >
          {/* Logo */}
          <div className="flex items-center gap-2" data-testid="brand-logo-row">
            <img
              src={faviconImg}
              alt="Field View"
              className="h-10 w-10 rounded-md"
              data-testid="img-brand-logo"
            />
            <span className="text-2xl font-bold tracking-tight text-slate-900">
              Field View
            </span>
          </div>

          {/* Headline */}
          <h1
            className="text-5xl sm:text-6xl lg:text-7xl font-extrabold leading-[0.95] tracking-tight text-slate-900 my-12"
            data-testid="text-brand-tagline"
          >
            Join hundreds of contractors who rely on FieldView
          </h1>

          {/* Testimonial card */}
          <figure
            className="bg-white rounded-2xl shadow-md p-5 max-w-sm"
            data-testid="card-testimonial"
          >
            <div className="flex items-center gap-0.5 mb-3" data-testid="testimonial-stars">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} className="w-3.5 h-3.5" style={{ color: "#F09000", fill: "#F09000" }} />
              ))}
            </div>
            <blockquote className="text-slate-800 text-sm leading-relaxed mb-4">
              "FieldView keeps the whole crew organized. It clocks everyone in
              when they hit the job, and the photo logs alone have settled two
              disputes for us this year."
            </blockquote>
            <figcaption className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-[#F09000] flex items-center justify-center text-white text-xs font-bold">
                LO
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-bold text-slate-900">Luke Ousdigian</span>
                <span className="text-[11px] text-slate-600">Owner · Palm Beach Painters</span>
              </div>
            </figcaption>
          </figure>
        </div>

        {/* Right form panel */}
        <div className="flex items-center justify-center px-4 py-8 sm:px-6 lg:px-12 relative">
          <div className="w-full max-w-md">
            <div className="flex justify-end mb-4" data-testid="row-logged-in-as">
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Logged in as {(user as any)?.email}
                {" · "}
                <button
                  type="button"
                  onClick={() => logout()}
                  className="font-bold text-[#f09004] hover:underline"
                  data-testid="button-sign-out-welcome"
                >
                  Sign out
                </button>
              </span>
            </div>
            <h2
              className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white text-center mb-6"
              data-testid="text-welcome-title"
            >
              Take a second to finish up your profile.
            </h2>

            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    className={FIELD_CLASS}
                    data-testid="input-first-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    className={FIELD_CLASS}
                    data-testid="input-last-name"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={FIELD_CLASS}
                  data-testid="input-phone"
                />
              </div>

              {isAdmin && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="industry">Industry</Label>
                    <Select value={industry} onValueChange={setIndustry}>
                      <SelectTrigger id="industry" className={FIELD_CLASS} data-testid="select-industry">
                        <SelectValue placeholder="Select your industry" />
                      </SelectTrigger>
                      <SelectContent>
                        {INDUSTRIES.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} data-testid={`option-industry-${opt.value}`}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="companySize">Company size</Label>
                    <Select value={companySize} onValueChange={setCompanySize}>
                      <SelectTrigger id="companySize" className={FIELD_CLASS} data-testid="select-company-size">
                        <SelectValue placeholder="Select company size" />
                      </SelectTrigger>
                      <SelectContent>
                        {COMPANY_SIZES.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value} data-testid={`option-company-size-${opt.value}`}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={tcpaAccepted}
                  onChange={(e) => setTcpaAccepted(e.target.checked)}
                  required
                  className="mt-0.5 h-4 w-4 rounded border-input accent-[#F09000]"
                  data-testid="checkbox-tcpa"
                />
                <span>
                  I agree to receive product updates and SMS from Field View at the
                  phone number provided. Message and data rates may apply. Reply
                  STOP to opt out.
                </span>
              </label>

              <Button
                type="submit"
                className="w-full bg-[#F09000] hover:bg-[#d98000] text-white"
                disabled={submit.isPending || !tcpaAccepted}
                data-testid="button-complete-setup"
              >
                {submit.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Complete Setup"
                )}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
