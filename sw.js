self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
 let d={}; try { d=e.data?e.data.json():{}; } catch (_) {}
 const base=self.registration.scope;
 const icon=new URL("assets/dv-logo.png",base).href;
 e.waitUntil(self.registration.showNotification(d.title||"Delight Vendor Logs",{body:d.body||"You have a new notification.",icon,badge:icon,image:d.image||undefined,data:d.data||{url:"notification.html"}}));
});
self.addEventListener("notificationclick", e => {
 e.notification.close();
 const raw=e.notification.data&&e.notification.data.url?e.notification.data.url:"notification.html";
 let target;
 try {
   if(raw.startsWith("/notification.html")) target=new URL(raw.slice(1),self.registration.scope);
   else target=new URL(raw,self.registration.scope);
 } catch (_) { target=new URL("notification.html",self.registration.scope); }
 e.waitUntil(self.clients.openWindow(target.href));
});