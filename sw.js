self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
 let d={}; try { d=e.data?e.data.json():{}; } catch (_) {}
 e.waitUntil(self.registration.showNotification(d.title||"Delight Vendor Logs",{body:d.body||"You have a new notification.",icon:"/assets/dv-logo.png",badge:"/assets/dv-logo.png",image:d.image||undefined,data:d.data||{url:"/notification.html"}}));
});
self.addEventListener("notificationclick", e => {
 e.notification.close();
 const path=e.notification.data&&e.notification.data.url?e.notification.data.url:"/notification.html";
 e.waitUntil(self.clients.openWindow(new URL(path,self.location.origin).href));
});