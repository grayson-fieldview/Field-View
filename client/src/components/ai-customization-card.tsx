import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import { INDUSTRIES } from "@shared/constants";
import type { AccountSettings } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const EXAMPLE_CONTEXT =
  "We do high-end residential repaints in Palm Beach. Most jobs are occupied homes, so masking and daily cleanup matter to our clients. We spray cabinets off-site.";

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function AiCustomizationCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";
  const { data, isLoading, isError, refetch } = useQuery<AccountSettings>({
    queryKey: ["/api/account/settings"],
  });

  const [industry, setIndustry] = useState("");
  const [aiContext, setAiContext] = useState("");
  useEffect(() => {
    if (!data) return;
    setIndustry(data.industry ?? "");
    setAiContext(data.aiContext ?? "");
  }, [data]);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/account/settings", {
        industry: industry || null,
        aiContext: aiContext.trim() || null,
      });
      return (await res.json()) as AccountSettings;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/account/settings"], next);
      queryClient.invalidateQueries({ queryKey: ["/api/account/settings"] });
      toast({ title: "AI customization updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't save AI customization",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // The route's requireAdmin middleware is authoritative; hiding the card
  // keeps non-admin settings pages free of controls they cannot change.
  if (!isAdmin) return null;

  const wordCount = countWords(aiContext);
  const overLimit = wordCount > 500;
  const dirty =
    data !== undefined &&
    (industry !== (data.industry ?? "") ||
      aiContext.trim() !== (data.aiContext ?? ""));

  return (
    <Card className="p-6" data-testid="card-ai-customization">
      <div className="flex items-center gap-2 mb-1">
        <Bot className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">AI Customization</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Give reports and checklists the vocabulary and priorities of your business.
      </p>

      {isError ? (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
          data-testid="error-ai-customization"
        >
          <p className="text-sm text-destructive">Couldn't load AI customization.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            data-testid="button-retry-ai-customization"
          >
            Retry
          </Button>
        </div>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="ai-industry">Industry</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger id="ai-industry" data-testid="select-ai-industry">
                <SelectValue placeholder="Select your industry" />
              </SelectTrigger>
              <SelectContent>
                {INDUSTRIES.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    data-testid={`option-ai-industry-${option.value}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="ai-business-context">About your business</Label>
              <span
                className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}
                data-testid="text-ai-context-word-count"
              >
                {wordCount} / 500 words
              </span>
            </div>
            <Textarea
              id="ai-business-context"
              value={aiContext}
              onChange={(event) => setAiContext(event.target.value)}
              placeholder={EXAMPLE_CONTEXT}
              rows={5}
              aria-invalid={overLimit}
              data-testid="textarea-ai-business-context"
            />
            <p className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
              {overLimit
                ? "Business context must be 500 words or fewer."
                : "Used as reference context. Field View's safety and output rules always take priority."}
            </p>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => mutation.mutate()}
              disabled={!dirty || overLimit || mutation.isPending}
              data-testid="button-save-ai-customization"
            >
              {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}