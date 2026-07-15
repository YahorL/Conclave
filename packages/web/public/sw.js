/* Conclave push service worker. Payload: {title, body, url, tag}. */
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON push — show a generic notification */
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "Conclave", {
      body: d.body || "",
      tag: d.tag,
      icon: "/icon-192.png",
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const open = clients.find((c) => "focus" in c);
        if (open) {
          // Focusing does not navigate — tell the running app where to go.
          open.postMessage({ type: "navigate", url });
          return open.focus();
        }
        return self.clients.openWindow(url);
      }),
  );
});
