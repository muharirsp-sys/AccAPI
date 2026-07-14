/*
 * Tujuan: Konfigurasi Next.js untuk checkout Smart ERP.
 * Caller: `next dev`, `next build`, dan runtime Next.js.
 * Dependensi: NextConfig dan working directory project.
 * Main Functions: `nextConfig`.
 * Side Effects: Mengarahkan root tracing/Turbopack ke folder project aktif dan mencegah route cleanup menyalin data runtime ke standalone.
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  // Route ini membaca folder runtime eksternal saat request; source/data root tidak dibutuhkan di standalone.
  outputFileTracingExcludes: {
    "/api/cron/cleanup-runtime": [
      "./.env*",
      "./*.{csv,xls,xlsx,rar,db,sqlite,sqlite3,log,jsonl,apl}",
      "./{.agents,.claude,.claude-plugin,.codex,.git,.github,.vscode}/**/*",
      "./{agency-agents,app,components,dashboard-generator,Data_Penjualan,db,docs,lib,master_barang_principle,outputs,ponytail,poster,public,python_backend,reference_surat_program,runtime,runtime_logs,scripts,tests,tmp}/**/*",
    ],
  },
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    // Tree-shakes icon/utility packages that lack proper ESM exports
    // ponytail: lucide-react is 577 icons; this drops login page to only Mail+Lock
    optimizePackageImports: ["lucide-react", "sonner", "date-fns"],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // ponytail: reduces initial chunk count from ~11 to ~5-6 by merging small vendor chunks
      config.optimization.splitChunks = {
        ...config.optimization.splitChunks,
        maxInitialRequests: 6,
        cacheGroups: {
          ...(config.optimization.splitChunks?.cacheGroups ?? {}),
          framework: {
            name: "framework",
            test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            priority: 40,
            enforce: true,
          },
        },
      };
    }
    return config;
  },
  headers: async () => [
    {
      source: "/login",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Pragma", value: "no-cache" },
        { key: "Expires", value: "0" },
      ],
    },
    {
      source: "/reset-password",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      ],
    },
    {
      source: "/forgot-password",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      ],
    },
    {
      // Root dashboard — prevent bfcache after logout
      source: "/",
      headers: [
        { key: "Cache-Control", value: "private, no-cache, no-store, must-revalidate" },
      ],
    },
    {
      // All authenticated dashboard routes — prevent bfcache serving stale content after logout
      source: "/(principles|finance|payments|summary|validator|off-program-control|api-wrapper|insentif-sales|form-kontrol|claim-workflow|admin)/:path*",
      headers: [
        { key: "Cache-Control", value: "private, no-cache, no-store, must-revalidate" },
      ],
    },
    {
      source: "/api/(auth|login|logout)/:path*",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      ],
    },
    {
      source: "/api/form-kontrol/:path*",
      headers: [
        { key: "Cache-Control", value: "private, max-age=300" },
      ],
    },
  ],
};

export default nextConfig;
