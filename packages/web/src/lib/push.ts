import { hubClient } from "./hubClient.js";

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushPermission(): NotificationPermission {
  return "Notification" in window ? Notification.permission : "denied";
}

export async function isPushEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

export async function enablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.register("/sw.js");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(`notifications ${permission}`);
  const { key } = await hubClient.getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
  });
  await hubClient.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await hubClient.pushUnsubscribe(endpoint);
}

// The SW posts {type:"navigate", url} when it focuses an already-open window
// (focusing does not navigate). Route the thread id to the running app.
export function initPushNavigation(onNavigate: (threadId: string) => void): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { type?: string; url?: string } | null;
    if (!data || data.type !== "navigate" || !data.url) return;
    const threadId = new URL(data.url, location.origin).searchParams.get("thread");
    if (threadId) onNavigate(threadId);
  });
}
