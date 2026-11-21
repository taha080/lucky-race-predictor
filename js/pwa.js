// Register the service worker so the app can be installed
// (Chrome: "Install app" / "Add to Home screen"; iPhone: Share -> "Add to Home Screen").
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
