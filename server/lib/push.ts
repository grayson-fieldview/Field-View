import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/models/auth";
import { Sentry } from "./sentry";

const expo = new Expo();

const PUSH_TIMEOUT_MS = 5000;

function safeCapture(fn: () => void) {
  try {
    fn();
  } catch {
    // Sentry itself failed — never let observability break the caller
  }
}

export async function sendPushNotification(opts: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
}): Promise<void> {
  const typeTag = String(opts.data?.type ?? "unknown");

  const [row] = await db
    .select({ token: users.expoPushToken })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  const token = row?.token;
  if (!token) return;

  if (!Expo.isExpoPushToken(token)) {
    console.warn(`[push] invalid token format for user ${opts.userId} — clearing`);
    safeCapture(() =>
      Sentry.captureMessage("push.invalid_token", {
        level: "warning",
        tags: { userId: opts.userId, type: typeTag },
      }),
    );
    await db
      .update(users)
      .set({ expoPushToken: null })
      .where(eq(users.id, opts.userId));
    throw new Error("push.invalid_token");
  }

  const messages: ExpoPushMessage[] = [
    {
      to: token,
      title: opts.title,
      body: opts.body,
      data: opts.data,
      sound: "default",
    },
  ];

  let tickets;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    tickets = await Promise.race([
      expo.sendPushNotificationsAsync(messages),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`push timeout after ${PUSH_TIMEOUT_MS}ms`)),
          PUSH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    console.error(`[push] send failed for user ${opts.userId}:`, err);
    safeCapture(() => Sentry.captureException(err));
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const ticket = tickets[0];
  if (ticket && ticket.status === "error") {
    const errCode = (ticket.details as any)?.error;
    if (errCode === "DeviceNotRegistered") {
      console.warn(`[push] DeviceNotRegistered for user ${opts.userId} — token cleared`);
      safeCapture(() =>
        Sentry.captureMessage("push.device_not_registered", {
          level: "info",
          tags: { userId: opts.userId, type: typeTag },
        }),
      );
      await db
        .update(users)
        .set({ expoPushToken: null })
        .where(eq(users.id, opts.userId));
      throw new Error("push.device_not_registered");
    }
    console.error(
      `[push] ticket error for user ${opts.userId}: ${ticket.message} (code=${errCode ?? "unknown"})`,
    );
    safeCapture(() =>
      Sentry.captureMessage("push.ticket_error", {
        level: "error",
        tags: {
          userId: opts.userId,
          type: typeTag,
          errCode: String(errCode ?? "unknown"),
        },
        extra: { ticketMessage: ticket.message },
      }),
    );
    throw new Error(`push.ticket_error:${errCode ?? "unknown"}`);
  }
}
