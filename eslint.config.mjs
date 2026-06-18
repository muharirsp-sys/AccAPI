import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "runtime/**",
    "runtime_logs/**",
    "tmp/**",
    "test-results/**",
    "playwright-report/**",
    ".agents/**",
    ".claude/**",
    "awesome-codex-skills/**",
  ]),
  {
    files: [
      "app/(dashboard)/api-wrapper/**/*.{ts,tsx}",
      "app/(dashboard)/off-program-control/page.tsx",
      "app/(dashboard)/summary/page.tsx",
      "app/(dashboard)/validator/page.tsx",
      "app/api/auth/**/*.ts",
      "lib/apiFetcher.ts",
      "lib/sync.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    files: ["scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
