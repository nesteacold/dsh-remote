// Local notifications (A025 / US6 / FR-010): raised by the live connection when an
// `approval-requested` push arrives while the app is backgrounded. LOCAL ONLY — no APNs/FCM,
// no third-party push server, no analytics.
//
// Payload discipline (contract §5, FR-010, B3): the notification carries only ids and a short
// title; the card content is fetched over the authenticated connection after the user opens
// the app. Never the args preview, never a token, never the approval arguments.
//
// The code runs on a native build (expo-notifications); in Expo Go SDK 53+ remote push is
// unsupported, but local notifications still schedule. Every call is wrapped so a missing
// permission or unsupported runtime degrades to "no notification", never a crash.

import * as Notifications from 'expo-notifications';

import type { ApprovalRequestedFrame } from '../core';
import { sessionDeepLink } from '../core';

/** Deep link the notification opens (A025): `dshcompanion://s/<sessionId>?a=<approvalId>`. */
export function approvalDeepLink(approval: { sessionId: string; approvalId: string }): string {
  return sessionDeepLink(approval.sessionId, approval.approvalId);
}

let configured = false;

/** Minimal presentation and tapping behaviour; safe to call repeatedly. */
export function configureNotifications(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** Ask once; returns whether notifications may be shown. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (current.canAskAgain === false) return false;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

export interface ApprovalNotification {
  title: string;
  body: string;
  data: { sessionId: string; approvalId: string; rpcId: string; url: string };
}

/**
 * The only place a notification payload is built. Ids + a short title; the tool name is a
 * fixed vocabulary word, not user content, so it is safe to show.
 */
export function approvalNotification(
  approval: Pick<ApprovalRequestedFrame, 'sessionId' | 'approvalId' | 'rpcId' | 'toolName' | 'argsHash'>,
  copy: { title: string; body: (toolName: string) => string },
): ApprovalNotification {
  return {
    title: copy.title,
    body: copy.body(approval.toolName),
    data: {
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      rpcId: approval.rpcId,
      url: approvalDeepLink(approval),
    },
  };
}

/** Schedule an immediate local notification for one approval. Returns its id, or null. */
export async function notifyApproval(notification: ApprovalNotification): Promise<string | null> {
  try {
    configureNotifications();
    if (!(await ensureNotificationPermission())) return null;
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: notification.title,
        body: notification.body,
        data: notification.data,
        sound: false,
      },
      trigger: null, // immediate
    });
  } catch {
    return null;
  }
}

/** Cancel every scheduled local notification (e.g. after pairing changes). */
export async function clearNotifications(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    // nothing scheduled / unsupported runtime
  }
}

/**
 * Subscribe to taps. The listener returns the deep-link URL so the router can navigate
 * directly (`openURL`), keeping navigation out of this module.
 */
export function addNotificationUrlListener(handler: (url: string) => void): () => void {
  try {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { url?: unknown } | null;
      if (typeof data?.url === 'string') handler(data.url);
    });
    return () => subscription.remove();
  } catch {
    return () => {
      // runtime without notifications
    };
  }
}

/** The URL a cold start was launched from (tap while the app was killed). */
export async function initialNotificationUrl(): Promise<string | null> {
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    const data = response?.notification.request.content.data as { url?: unknown } | undefined;
    return typeof data?.url === 'string' ? data.url : null;
  } catch {
    return null;
  }
}
