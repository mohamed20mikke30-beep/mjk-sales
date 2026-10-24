// Service Worker للإشعارات في الخلفية - Mjk Sales Tools

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// استقبال الإشعارات عندما يكون الهاتف/المتصفح مغلقاً
self.addEventListener('push', (event) => {
  let data = { title: 'تنبيه جديد - MJK Sales', body: 'لديك تحديث جديد في مساحة العمل.' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || 'لديك إشعار جديد',
    icon: 'favicon.ico', // لوجو التطبيق
    badge: 'favicon.ico',
    vibrate: [200, 100, 200, 100, 200], // نمط اهتزاز الهاتف عند وصول الإشعار
    sound: 'default',
    data: {
      url: self.registration.scope
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'MJK Sales', options)
  );
});

// عند نجر المستخدم/الموظف على الإشعار يفتح له موقع MJK فوراً
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});