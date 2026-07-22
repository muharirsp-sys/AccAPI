# Reconciliation Division Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact `Jenis Rekonsiliasi` bar to the local reconciliation page showing Faktur as active and Pembelian and Return as static unavailable spaces.

**Architecture:** Keep the existing `/reconciliation` page and Faktur workflow unchanged. Add one semantic, responsive status section directly in the existing page header and cover it with one focused Playwright scenario; no division state, route, backend, or shared component is needed while only Faktur is operational.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Playwright.

## Global Constraints

- Work only in `D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation`; never switch, merge, push, deploy, or modify branch `main`.
- Keep the route exactly `/reconciliation` and keep the current Faktur principal, upload, result, filter, and export flows unchanged.
- Use the exact option labels `Faktur`, `Pembelian`, and `Return`.
- Show `Faktur` as `Aktif`; show `Pembelian` and `Return` as `Belum aktif`.
- Pembelian and Return are static information: no button, link, click handler, keyboard stop, route, upload, sample result, or release date.
- Reuse existing theme-aware Tailwind classes; do not modify global CSS and do not add a dependency.
- Preserve all existing API, parser, mapping, formula, tolerance, status, RBAC, and sidebar behavior.

## File Map

- Modify `app/(dashboard)/reconciliation/page.tsx`: render the semantic three-part status bar inside the existing header; keep all existing state and handlers untouched.
- Modify/Test `tests/reconciliation-ui.spec.ts`: add a focused authenticated UI test for labels, static behavior, three themes, and narrow-screen overflow.
- No files are created by the implementation.

---

### Task 1: Add and Verify the Reconciliation Type Bar

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx:364-406`
- Modify/Test: `tests/reconciliation-ui.spec.ts:1-80`

**Interfaces:**
- Consumes: existing `/reconciliation` page, `ThemeSwitcher`, and global remapping for `border-white/10`, `bg-white/5`, `bg-indigo-500/10`, `text-slate-400`, and `text-indigo-300`.
- Produces: a region named `Jenis Rekonsiliasi` with one `[aria-current="page"]` item and two static unavailable items.
- Preserves: `principal`, `changePrincipal`, both uploaded files, reconciliation result, status filter, error state, API requests, and export behavior.

- [ ] **Step 1: Add the focused failing Playwright test**

Insert this test before `shows the progressive reconciliation workflow` in `tests/reconciliation-ui.spec.ts`:

```ts
test("shows the available reconciliation types without fake controls", async ({
  page,
  baseURL,
}) => {
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: baseURL || "http://localhost:3000" },
    data: { email: QA_EMAIL, password: QA_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/reconciliation");
  const types = page.getByRole("region", { name: "Jenis Rekonsiliasi" });
  const current = types.locator('[aria-current="page"]');

  await expect(types).toBeVisible();
  await expect(current.getByText("Faktur", { exact: true })).toBeVisible();
  await expect(current.getByText("Aktif", { exact: true })).toBeVisible();
  await expect(types.getByText("Pembelian", { exact: true })).toBeVisible();
  await expect(types.getByText("Return", { exact: true })).toBeVisible();
  await expect(types.getByText("Belum aktif", { exact: true })).toHaveCount(2);
  await expect(types.getByRole("button")).toHaveCount(0);
  await expect(types.getByRole("link")).toHaveCount(0);
  await expect(types.locator('[tabindex]:not([tabindex="-1"])')).toHaveCount(0);
  expect(
    await types
      .getByText("Pembelian", { exact: true })
      .locator("..")
      .evaluate((element) => (element as HTMLElement).tabIndex),
  ).toBe(-1);
  expect(
    await types
      .getByText("Return", { exact: true })
      .locator("..")
      .evaluate((element) => (element as HTMLElement).tabIndex),
  ).toBe(-1);

  const themes = [
    ["Office Calm", "office-calm"],
    ["Neon HUD", "neon"],
    ["iOS Liquid Glass", "ios"],
  ] as const;

  for (const [label, key] of themes) {
    await page.getByRole("button", { name: "Ganti tema" }).click();
    await page.getByRole("button", { name: new RegExp(label) }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", key);
    await expect(types).toBeVisible();
  }

  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await types.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});
```

- [ ] **Step 2: Start a worktree-owned server and verify RED**

From a dedicated terminal whose current directory is exactly `D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation`, start a temporary verification server:

```powershell
npm run dev -- --port 3100
```

Expected: Next.js reports `http://localhost:3100`. Keep this terminal running through Step 5. Port 3100 is deliberate: it proves the test is using this worktree and does not replace or trust an unknown process already bound to port 3000.

From a second terminal in the same worktree, run:

```powershell
$env:PLAYWRIGHT_BASE_URL='http://localhost:3100'; npx playwright test tests/reconciliation-ui.spec.ts --project=msedge --grep "shows the available reconciliation types"
```

Expected: FAIL because no region named `Jenis Rekonsiliasi` exists yet.

- [ ] **Step 3: Add the minimal semantic status bar**

In `app/(dashboard)/reconciliation/page.tsx`, keep the existing Faktur/principal badge row and principal selector, but move that row below the title/description. Insert the following section between the title/description and that existing row:

```tsx
<section
  aria-labelledby="reconciliation-type-heading"
  className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-3 shadow-lg backdrop-blur-xl"
>
  <h2
    id="reconciliation-type-heading"
    className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400"
  >
    Jenis Rekonsiliasi
  </h2>
  <ul className="grid list-none grid-cols-3 gap-2">
    <li
      aria-current="page"
      className="min-w-0 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-2 py-3 text-center"
    >
      <span className="block text-sm font-semibold text-indigo-300">
        Faktur
      </span>
      <span className="mt-1 block text-xs text-indigo-300">Aktif</span>
    </li>
    <li className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-2 py-3 text-center">
      <span className="block text-sm font-semibold text-slate-300">
        Pembelian
      </span>
      <span className="mt-1 block text-xs text-slate-400">Belum aktif</span>
    </li>
    <li className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-2 py-3 text-center">
      <span className="block text-sm font-semibold text-slate-300">
        Return
      </span>
      <span className="mt-1 block text-xs text-slate-400">Belum aktif</span>
    </li>
  </ul>
</section>
```

The resulting header order must be:

```tsx
<header className="space-y-5">
  <div>
    {/* existing h1 and description */}
  </div>
  {/* new Jenis Rekonsiliasi section */}
  {/* existing Faktur/principal badges and Prinsipal select row */}
</header>
```

Do not introduce an array, component, state, handler, or conditional rendering for these three fixed items.

- [ ] **Step 4: Run GREEN and the existing Faktur workflow regression**

Run the focused scenario:

```powershell
$env:PLAYWRIGHT_BASE_URL='http://localhost:3100'; npx playwright test tests/reconciliation-ui.spec.ts --project=msedge --grep "shows the available reconciliation types"
```

Expected: 1 test passes; each theme applies, the region stays visible, and the 375 px check reports no section overflow.

Run the full reconciliation UI test file:

```powershell
$env:PLAYWRIGHT_BASE_URL='http://localhost:3100'; npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
```

Expected: both the new status-bar scenario and the existing progressive Faktur scenario pass.

- [ ] **Step 5: Inspect all three themes and run static checks**

Using the browser against `http://localhost:3100/reconciliation`, select `Office Calm`, `Neon HUD`, and `iOS Liquid Glass` one at a time. At both desktop width and 375 px width, verify for every theme:

- all six texts (`Faktur`, `Aktif`, `Pembelian`, both `Belum aktif`, and `Return`) remain readable against their cell backgrounds;
- active and unavailable cells remain visually distinguishable without relying only on color because their status text differs;
- all three cells remain inside the page with no horizontal scrollbar.

If any theme fails this inspection, adjust only the Tailwind classes in the new section and rerun Step 4. Do not modify `app/globals.css`.

Then run:

```powershell
npx eslint "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
npx tsc --noEmit
```

Expected: both commands exit 0 with no new lint or TypeScript errors.

- [ ] **Step 6: Review the exact diff and commit the implementation**

```powershell
git diff --check
git diff -- "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
git add "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
git commit -m "feat(reconciliation): show division spaces"
```

Expected: the diff contains only the status bar, header ordering, and focused UI test; the commit succeeds on `codex/shinzui-reconciliation`.

## Final Acceptance Checklist

- [ ] `/reconciliation` shows `Jenis Rekonsiliasi`, `Faktur`, `Pembelian`, and `Return` together.
- [ ] Faktur is marked `Aktif` and `aria-current="page"`.
- [ ] Pembelian and Return each show `Belum aktif` and expose no interactive control.
- [ ] Office Calm, Neon HUD, and iOS Liquid Glass keep the status region visible.
- [ ] A 375 px viewport does not create overflow inside the status region.
- [ ] The complete existing Faktur UI scenario still passes.
- [ ] No API, backend, parser, mapping, sidebar, RBAC, global CSS, dependency, or `main` change exists.
