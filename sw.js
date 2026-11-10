const CACHE_NAME = "missoes-007-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    (async () => {
      const cachedResponse = await caches.match(event.request);

      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        const networkResponse = await fetch(event.request);

        if (
          event.request.url.startsWith(self.location.origin) &&
          networkResponse.status === 200
        ) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, networkResponse.clone());
        }

        return networkResponse;
      } catch (error) {
        if (event.request.mode === "navigate") {
          const offlinePage = await caches.match("./index.html");

          if (offlinePage) {
            return offlinePage;
          }
        }

        throw error;
      }
    })()
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Missões 007",
    body: "Agente, escolha uma pequena missão e comece agora.",
    url: "./",
    tag: "daily-reminder"
  };

  if (event.data) {
    try {
      const receivedPayload = event.data.json();

      if (
        receivedPayload &&
        typeof receivedPayload === "object" &&
        !Array.isArray(receivedPayload)
      ) {
        payload = {
          ...payload,
          ...receivedPayload
        };
      }
    } catch {
      const text = event.data.text();

      if (text) {
        payload.body = text;
      }
    }
  }

  event.waitUntil(
    self.registration.showNotification(
      payload.title || "Missões 007",
      {
        body: payload.body || "Você tem uma nova missão.",
        icon: "./icon.svg",
        badge: "./icon.svg",
        tag: payload.tag || "daily-reminder",
        renotify: false,
        data: {
          url: payload.url || "./"
        }
      }
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const targetUrl = new URL(
        event.notification.data?.url || "./",
        self.registration.scope
      );

      if (targetUrl.origin !== self.location.origin) {
        return;
      }

      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });

      for (const windowClient of windows) {
        if ("focus" in windowClient) {
          if (
            "navigate" in windowClient &&
            windowClient.url !== targetUrl.href
          ) {
            await windowClient.navigate(targetUrl.href);
          }

          return windowClient.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
    })()
  );
});
