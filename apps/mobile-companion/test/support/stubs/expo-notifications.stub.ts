// Test-only stub of `expo-notifications`: records scheduled local notifications.

export interface ScheduledNotification {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

const scheduled: ScheduledNotification[] = [];
let permissionGranted = true;
let handler: ((notification: unknown) => Promise<unknown>) | null = null;
const responseListeners = new Set<(response: unknown) => void>();

export function setNotificationHandler(next: (notification: unknown) => Promise<unknown>): void {
  handler = next;
}

export async function getPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return { granted: permissionGranted, canAskAgain: true };
}

export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: permissionGranted };
}

export async function scheduleNotificationAsync(request: {
  content: { title: string; body: string; data?: Record<string, unknown> };
  trigger: unknown;
}): Promise<string> {
  const id = `notification-${scheduled.length + 1}`;
  scheduled.push({ title: request.content.title, body: request.content.body, data: request.content.data ?? {} });
  return id;
}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {
  scheduled.length = 0;
}

export function addNotificationResponseReceivedListener(listener: (response: unknown) => void) {
  responseListeners.add(listener);
  return {
    remove() {
      responseListeners.delete(listener);
    },
  };
}

export async function getLastNotificationResponseAsync(): Promise<unknown> {
  return null;
}

/** Test helper: what the app scheduled. */
export function scheduledNotifications(): ScheduledNotification[] {
  return scheduled.map((entry) => ({ ...entry }));
}

/** Test helper: simulate the user tapping a notification. */
export function emitNotificationResponse(url: string): void {
  for (const listener of [...responseListeners]) {
    listener({ notification: { request: { content: { data: { url } } } } });
  }
}

export function resetNotifications(permission = true): void {
  scheduled.length = 0;
  permissionGranted = permission;
  responseListeners.clear();
  handler = null;
}
