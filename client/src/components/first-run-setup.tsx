// Guided first-run flow for zero-project accounts (admins/owners only —
// gating lives in DashboardPage). Step 1 creates the first project (name +
// address only), step 2 pushes the mobile app install, then hands off to
// the normal dashboard or the new project.

import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { APP_DOWNLOAD_PAGE_URL } from "@/lib/appLinks";
import { useCreateProject, createProjectSchema } from "@/hooks/use-create-project";
import { Loader2, ArrowRight, Smartphone } from "lucide-react";

export function FirstRunSetup({
  onProjectCreated,
  onSkip,
}: {
  // Called when step 1 completes. The parent must keep rendering this
  // component afterwards (the projects query refetch means the account is
  // no longer zero-project, so the parent's own condition flips).
  onProjectCreated: () => void;
  onSkip: () => void;
}) {
  const [, navigate] = useLocation();
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);

  const form = useForm({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      status: "active" as const,
      address: "",
      latitude: null as number | null,
      longitude: null as number | null,
      color: "#F09000",
    },
  });

  const createProject = useCreateProject({
    // Advance in place to step 2 — deliberately no navigation here.
    onSuccess: (project) => {
      setCreatedProjectId(project.id);
      onProjectCreated();
    },
  });

  const handleAddressSelect = useCallback(
    (result: { address: string; latitude: number; longitude: number }) => {
      form.setValue("address", result.address, { shouldValidate: true, shouldDirty: true });
      form.setValue("latitude", result.latitude, { shouldDirty: true });
      form.setValue("longitude", result.longitude, { shouldDirty: true });
    },
    [form],
  );

  const handleAddressTextChange = useCallback(
    (text: string) => {
      form.setValue("address", text, { shouldDirty: true });
      form.setValue("latitude", null);
      form.setValue("longitude", null);
    },
    [form],
  );

  if (createdProjectId !== null) {
    return (
      <div className="flex justify-center py-10 px-4" data-testid="first-run-step-2">
        <Card className="p-8 max-w-lg w-full text-center">
          <div className="flex justify-center mb-4">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Smartphone className="h-6 w-6 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold mb-2" data-testid="text-first-run-step-2-heading">
            Photos happen in the field
          </h1>
          <p className="text-muted-foreground mb-6" data-testid="text-first-run-step-2-subtext">
            Get the app on your phone — snap photos at the job and they file
            themselves into this project.
          </p>
          <div className="flex flex-col items-center gap-2 mb-8">
            <a
              href={APP_DOWNLOAD_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-first-run-qr"
            >
              <img
                src="/get-app-qr.svg"
                alt="QR code linking to the Field View mobile app"
                width={160}
                height={160}
                className="rounded"
                data-testid="img-first-run-qr"
              />
            </a>
            <p className="text-sm text-muted-foreground">
              Scan with your phone camera to get the app
            </p>
          </div>
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <Button
              onClick={() => navigate(`/projects/${createdProjectId}`)}
              data-testid="button-first-run-open-project"
            >
              Open my project
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
            <Button variant="outline" onClick={onSkip} data-testid="button-first-run-later">
              I'll do this later
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-10 px-4" data-testid="first-run-step-1">
      <Card className="p-8 max-w-lg w-full">
        <h1 className="text-2xl font-semibold mb-2" data-testid="text-first-run-step-1-heading">
          Let's add your first job
        </h1>
        <p className="text-muted-foreground mb-6">
          Projects keep every photo, task, and note for a job in one place.
        </p>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((data) => createProject.mutate(data))}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., 442 Banyan Rd job"
                      {...field}
                      data-testid="input-first-run-name"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <AddressAutocomplete
                      value={field.value ?? ""}
                      onChange={handleAddressSelect}
                      onTextChange={handleAddressTextChange}
                      data-testid="input-first-run-address"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={createProject.isPending}
              data-testid="button-first-run-create"
            >
              {createProject.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create project
            </Button>
          </form>
        </Form>
      </Card>
    </div>
  );
}
