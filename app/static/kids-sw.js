// Service worker for the kids' pages: shows the morning summary notification and opens their page on tap.

self.addEventListener("push", event => {
  const d = event.data ? event.data.json() : { title: "Family Planner", body: "" };
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "/icon-180.png", badge: "/icon-180.png", data: { url: d.url || "/kids" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
