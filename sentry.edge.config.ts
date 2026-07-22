// Tujuan: Inisialisasi Sentry untuk error dan trace pada Next.js Edge runtime.
// Caller: instrumentation.ts saat runtime Next.js adalah edge.
// Dependensi: @sentry/nextjs dan project Sentry Cloud javascript-nextjs.
// Main Functions: Sentry.init.
// Side Effects: Mengirim error dan sampel trace edge ke Sentry; PII serta HTTP body dinonaktifkan.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://6ed2d4438f3ed0d1d40afb280b44a746@o4511749112201216.ingest.us.sentry.io/4511749120524288",

  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.05 : 0,

  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection
    userInfo: false,
    httpBodies: [],
  },
});
