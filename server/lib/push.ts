import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "@shared/models/auth";
import { Sentry } from "./sentry";

const expo = new Expo();

export async function sendPushNotification(opts: {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
}): Promise<void> {
  try {
    const [row] = await db
      .select({ token: users.expoPushToken })
      .from(users)
      .where(eq(users.id, opts.userId))
      .limit(1);
    const token = row?.token;
    if (!token) return;

    if (!Expo.isExpoPushToken(token)) {
      console.warn(`[push] invalid token format for user ${opts.userId} — clearing`);
      await db
        .update(users)
        .set({ expoPushToken: null })
        .where(eq(users.id, opts.userId));
      return;
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

    const tickets = await expo.sendPushNotificationsAsync(messages);
    const ticket = tickets[0];
    if (ticket && ticket.status === "error") {
      const errCode = (ticket.details as any)?.error;
      if (errCode === "DeviceNotRegistered") {
        await db
          .update(users)
          .set({ expoPushToken: null })
          .where(eq(users.id, opts.userId));
        console.warn(`[push] DeviceNotRegistered for user ${opts.userId} — token cleared`);
      } else {
        console.error(
          `[push] ticket error for user ${opts.userId}: ${ticket.message} (code=${errCode ?? "unknown"})`,
        );
      }
    }
  } catch (err) {
    console.error(`[push] send failed for user ${opts.userId}:`, err);
    try {
      Sentry.captureException(err);
    } catch {
      // Sentry itself failed — never throw from push send
    }
  }
}
