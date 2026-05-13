import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

interface ReferralModalProps {
  open: boolean;
  onClose: () => void;
}

interface ReferralResponse {
  referralUrl: string;
  referralCode: string;
  stats: {
    visitors: number;
    leads: number;
    conversions: number;
    unpaidCommissionsCents: number;
    paidCommissionsCents: number;
  };
}

const PROGRAM_DETAILS_URL = "https://field-view.getrewardful.com/signup";

export default function ReferralModal({ open, onClose }: ReferralModalProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ReferralResponse>({
    queryKey: ["/api/me/referral"],
    enabled: open,
    staleTime: 60_000,
  });

  const handleCopy = async () => {
    if (!data?.referralUrl) return;
    try {
      await navigator.clipboard.writeText(data.referralUrl);
      setCopied(true);
      toast({ title: "Referral link copied" });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Select the link and copy it manually.",
        variant: "destructive",
      });
    }
  };

  const earnedDollars = data
    ? (
        (data.stats.unpaidCommissionsCents + data.stats.paidCommissionsCents) /
        100
      ).toFixed(2)
    : "0.00";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-referral">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-[#F09000]" data-testid="text-referral-title">
            Get $100 for Referrals
          </DialogTitle>
          <DialogDescription className="text-base text-foreground/80">
            Share your unique referral link via text, email, or whatever's
            easiest. You'll get $100 if your referral becomes a paying
            customer for 2 months.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-10" data-testid="state-referral-loading">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError || !data ? (
          <div className="py-6 space-y-3 text-center" data-testid="state-referral-error">
            <p className="text-sm text-muted-foreground">
              Couldn't load your referral link. Try again shortly.
            </p>
            <Button
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-referral-retry"
            >
              {isFetching ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Input
                value={data.referralUrl}
                readOnly
                className="font-mono text-xs bg-muted/50"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="input-referral-url"
              />
              <Button
                onClick={handleCopy}
                className="bg-[#F09000] hover:bg-[#d98000] text-white shrink-0"
                data-testid="button-copy-referral"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 mr-1.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-1.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-referral-stats"
            >
              Visitors: {data.stats.visitors} · Conversions:{" "}
              {data.stats.conversions} · Earned: ${earnedDollars}
            </p>
          </div>
        )}

        <DialogFooter className="sm:justify-between gap-2">
          <Button
            variant="ghost"
            onClick={onClose}
            data-testid="button-referral-close"
          >
            Close
          </Button>
          <Button
            variant="outline"
            asChild
            data-testid="button-referral-program-details"
          >
            <a
              href={PROGRAM_DETAILS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              See Program Details
              <ExternalLink className="h-4 w-4 ml-1.5" />
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
