// Shared create-project mutation — single source of truth for the dashboard
// dialog, projects-page dialog, and the first-run guided flow. Handles the
// POST, cache invalidation, success/error toasts, and the unauthorized
// redirect; callers do their own navigation/dialog cleanup in onSuccess.

import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { insertProjectSchema, type Project } from "@shared/schema";

export const createProjectSchema = insertProjectSchema.extend({
  name: z.string().min(1, "Project name is required"),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export function useCreateProject(options?: {
  onSuccess?: (project: Project) => void;
}) {
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: CreateProjectInput) => {
      const res = await apiRequest("POST", "/api/projects", data);
      return (await res.json()) as Project;
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      toast({ title: "Project created", description: "Your new project is ready." });
      options?.onSuccess?.(project);
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
}
