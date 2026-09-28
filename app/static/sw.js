// Service worker for the adults' phones (the kids' pages have their own, kids-sw.js): shows the 8 pm "tomorrow"
// check and homelab alerts, and opens the planner on tap. Web push on an iPhone needs the planner added to the
// Home Screen and opened from there.

self.addEventListener("push", event => {
  const d = event.data ? event.data.json() : { title: "Family Planner", body: "" };
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "/icon-180.png", badge: "/icon-180.png", data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
