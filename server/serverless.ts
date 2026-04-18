import { app, ensureAppReady } from "./index";

let ready: Promise<void> | null = null;

export default async function handler(req: any, res: any) {
  if (!ready) ready = ensureAppReady();
  await ready;
  return (app as any)(req, res);
}
