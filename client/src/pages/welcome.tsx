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
import { Loader2 } from "lucide-react";
import { INDUSTRIES, COMPANY_SIZES } from "@shared/constants";
import faviconImg from "@assets/Favicon-01_1772067008525.png";

export default function WelcomePage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
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
      setLocation("/");
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

  return (
    <div className="min-h-screen flex bg-white dark:bg-gray-950">
      {/* Left brand panel — desktop only */}
      <div
        className="hidden lg:flex lg:w-2/5 flex-col p-12 bg-[#F09000]/50"
        data-testid="panel-brand"
      >
        <div className="flex items-center gap-2" data-testid="brand-logo-row">
          <img src={faviconImg} alt="Field View" className="h-10 w-10 rounded-md" data-testid="img-brand-logo" />
          <span className="text-2xl font-bold tracking-tight text-gray-900">Field View</span>
        </div>

        <div className="mt-12 flex flex-col gap-10">
          <h1
            className="text-4xl lg:text-5xl font-bold leading-tight text-gray-900"
            data-testid="text-brand-tagline"
          >
            Trusted by hundreds of contractors across the country.
          </h1>
          <figure
            className="bg-zinc-900 text-white rounded-2xl shadow-2xl shadow-black/40 p-8"
            data-testid="card-testimonial"
          >
            <blockquote className="text-lg leading-relaxed">
              "FieldView has helped our team stay organized across multiple
              projects, automatically clocks in all of our employees when they
              get to the job, and has been a big help with the growth of our
              company."
            </blockquote>
            <figcaption className="mt-4 text-base font-medium text-white/80">
              — Luke Ousdigian, Palm Beach Painters
            </figcaption>
          </figure>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex flex-col flex-1 lg:w-3/5 items-center justify-center px-4 py-8 sm:px-6 lg:px-12">
        <div className="w-full max-w-md">
          <div className="text-center space-y-2 mb-6">
            <div className="flex items-center justify-center gap-2 lg:hidden mb-4">
              <img src={faviconImg} alt="Field View" className="h-8 w-8" />
              <span className="text-xl font-bold text-[#1E1E1E] dark:text-white">Field View</span>
            </div>
            <h2 className="text-2xl font-bold text-foreground" data-testid="text-welcome-title">
              Tell us about your business
            </h2>
            <p className="text-sm text-muted-foreground">
              A few quick details so we can set things up for you
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="firstName">First name</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
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
                data-testid="input-phone"
              />
            </div>

            {isAdmin && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="industry">Industry</Label>
                  <Select value={industry} onValueChange={setIndustry}>
                    <SelectTrigger id="industry" data-testid="select-industry">
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
                    <SelectTrigger id="companySize" data-testid="select-company-size">
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
  );
}
