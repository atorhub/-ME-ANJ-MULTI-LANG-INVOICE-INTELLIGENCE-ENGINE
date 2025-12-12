const CACHE_NAME = 'me-anj-cache-v1';
const RESOURCES = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(RESOURCES)));
});
self.addEventListener('fetch', (e)=>{
  e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request)));
});
self.addEventListener('activate', (e)=>{
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => { if(k !== CACHE_NAME) return caches.delete(k); }))));
});
