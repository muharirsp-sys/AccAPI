// Tujuan: Memuat konfigurasi Sentry sesuai runtime Next.js dan meneruskan request error.
// Caller: Next.js instrumentation hook.
// Dependensi: @sentry/nextjs, sentry.server.config.ts, dan sentry.edge.config.ts.
// Main Functions: register, onRequestError.
// Side Effects: Menginisialisasi SDK dan mengirim error request ke Sentry.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
