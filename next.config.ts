/*
 * Tujuan: Konfigurasi Next.js untuk checkout Smart ERP.
 * Caller: `next dev`, `next build`, dan runtime Next.js.
 * Dependensi: NextConfig dan working directory project.
 * Main Functions: `nextConfig`.
 * Side Effects: Mengarahkan root tracing/Turbopack ke folder project aktif; tidak ada DB/HTTP/file I/O.
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
