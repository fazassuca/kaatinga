/* Service worker mínimo: permite instalar o site como app. Não guarda nada em cache (o conteúdo vem sempre da internet). */
self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});
self.addEventListener("fetch",function(){});
