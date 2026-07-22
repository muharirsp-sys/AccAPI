// Tujuan: Inisialisasi Sentry untuk error dan tracing yang terjadi di browser.
// Caller: Next.js App Router saat bundle klien dimuat.
// Dependensi: @sentry/nextjs dan project Sentry Cloud javascript-nextjs.
// Main Functions: Sentry.init, onRouterTransitionStart.
// Side Effects: Mengirim error dan sampel trace ke Sentry; PII serta HTTP body dinonaktifkan.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://6ed2d4438f3ed0d1d40afb280b44a746@o4511749112201216.ingest.us.sentry.io/4511749120524288",

  // ponytail: 5% cukup untuk menemukan bottleneck tanpa menambah beban browser/kuota secara berlebihan.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.05 : 0,

  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection
    userInfo: false,
    httpBodies: [],
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
