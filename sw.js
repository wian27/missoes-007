const CACHE_NAME = "missoes-007-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request)
        .then((networkResponse) => {
          const copy = networkResponse.clone();

          if (
            event.request.url.startsWith(self.location.origin) &&
            networkResponse.status === 200
          ) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, copy);
            });
          }

          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Missões 007",
    body: "Agente, escolha uma pequena missão e comece agora.",
    url: "./",
    tag: "daily-reminder"
  };

  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    // Mantém a mensagem padrão se o conteúdo recebido não for JSON.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icon.svg",
      badge: "./icon.svg",
      tag: payload.tag || "daily-reminder",
      renotify: false,
      data: {
        url: payload.url || "./"
      }
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch {
    payload = {
      body: event.data ? event.data.text() : ""
    };
  }

  const title = payload.title || "Missões 007";

  const options = {
    body: payload.body || "Você tem uma nova missão.",
    icon: new URL("./icons/icon-192.png", self.registration.scope).href,
    data: {
      url: payload.url || "./"
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "./",
    self.registration.scope
  ).href;

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

