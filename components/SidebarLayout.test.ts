import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSidebarNavClasses, parseSidebarExpanded, persistSidebarExpanded, scheduleSidebarHydration, selectSidebarTooltip } from "./SidebarLayout";

test("sidebar preference accepts only explicit booleans", () => {
  assert.equal(parseSidebarExpanded("true"), true);
  assert.equal(parseSidebarExpanded("false"), false);
  assert.equal(parseSidebarExpanded(null), true);
  assert.equal(parseSidebarExpanded("broken"), true);
});

test("sidebar preference writes only after hydration and survives storage errors", () => {
  const writes: string[] = [];
  const storage = { setItem: (_key: string, value: string) => writes.push(value) };
  assert.equal(persistSidebarExpanded(storage, false, false), false);
  assert.deepEqual(writes, []);
  assert.equal(persistSidebarExpanded(storage, false, true), true);
  assert.deepEqual(writes, ["false"]);
  assert.equal(persistSidebarExpanded({ setItem: () => { throw new Error("blocked"); } }, true, true), false);
});

test("sidebar motion is enabled on the next frame and scheduled work is cancellable", () => {
  let frameCallback: (() => void) | undefined;
  let cancelledFrame: number | undefined;
  let hydrated = false;
  const cleanup = scheduleSidebarHydration(
    (callback) => { frameCallback = callback; return 7; },
    (frame) => { cancelledFrame = frame; },
    () => { hydrated = true; },
  );

  assert.equal(hydrated, false);
  assert.ok(frameCallback);
  frameCallback();
  assert.equal(hydrated, true);
  cleanup();
  assert.equal(cancelledFrame, 7);
});

test("desktop motion stays isolated from mobile navigation", () => {
  const expanded = getSidebarNavClasses(false, true, true, true);
  const collapsed = getSidebarNavClasses(true, true, true, true);
  const collapsedInactive = getSidebarNavClasses(true, true, false, true);
  const hydrating = getSidebarNavClasses(true, true, true, false);
  const mobile = getSidebarNavClasses(false, false, true);
  const source = readFileSync(new URL("./SidebarLayout.tsx", import.meta.url), "utf8");

  assert.match(expanded.link, /hover:translate-x-\[3px\]/);
  assert.match(expanded.link, /focus-visible:bg-indigo-500\/20/);
  assert.match(expanded.link, /focus-visible:text-indigo-300/);
  assert.match(expanded.link, /focus-visible:translate-x-\[3px\]/);
  assert.doesNotMatch(collapsed.link, /hover:translate-x-\[3px\]/);
  assert.doesNotMatch(collapsed.link, /focus-visible:translate-x-\[3px\]/);
  assert.match(expanded.icon, /group-focus-visible:scale-\[1\.04\]/);
  assert.match(collapsed.link, /before:opacity-100/);
  assert.match(collapsed.icon, /sidebar-active-icon/);
  assert.equal(collapsed.iconStrokeWidth, 2.5);
  assert.doesNotMatch(collapsedInactive.icon, /sidebar-active-icon/);
  assert.equal(collapsedInactive.iconStrokeWidth, undefined);
  assert.doesNotMatch(expanded.icon, /sidebar-active-icon/);
  assert.equal(expanded.iconStrokeWidth, undefined);
  assert.equal(mobile.iconStrokeWidth, undefined);
  assert.match(expanded.label!, /max-w-\[180px\].*opacity-100/);
  assert.match(collapsed.label!, /max-w-0.*opacity-0/);
  assert.match(expanded.label!, /duration-\[280ms\]/);
  assert.match(hydrating.label!, /duration-0/);
  assert.doesNotMatch(hydrating.label!, /duration-\[280ms\]/);
  for (const className of [expanded.link, expanded.icon, expanded.label!, collapsed.label!]) {
    assert.match(className, /ease-\[cubic-bezier\(0\.22,1,0\.36,1\)\]/);
    assert.match(className, /motion-reduce:transition-none/);
  }
  assert.equal(mobile.link, "flex items-center py-2.5 hover:bg-indigo-500/20 hover:text-indigo-300 rounded-lg transition-colors group px-3 bg-indigo-500/20 text-indigo-300");
  assert.equal(mobile.icon, "min-w-[20px]");
  assert.equal(mobile.label, "ml-3 text-sm font-medium whitespace-nowrap");
  assert.match(source, /className="absolute right-4 p-1 hover:bg-white\/10 focus-visible:bg-white\/10 rounded-md transition-colors"/);
  assert.match(source, /!isSidebarOpen \? "\[scrollbar-width:none\] \[&::-webkit-scrollbar\]:hidden" : ""/);
  assert.match(source, /overflow-y-auto/);
  assert.doesNotMatch(source, /ease-in-out/);
  assert.equal(source.match(/ease-\[cubic-bezier\(0\.22,1,0\.36,1\)\]/g)?.length, 7);
});

test("collapsed desktop tooltip stays fixed, centered, and dismissible", () => {
  const source = readFileSync(new URL("./SidebarLayout.tsx", import.meta.url), "utf8");
  const tooltip = source.match(/<div\s+role="tooltip"[\s\S]*?<\/div>/)?.[0];

  assert.ok(tooltip);
  assert.match(source, /isDesktop && collapsed/);
  assert.match(source, /Math\.min\(Math\.max\(rect\.top \+ rect\.height \/ 2, 32\), window\.innerHeight - 32\)/);
  const focusedA = { label: "A", top: 40 };
  const hoveredB = { label: "B", top: 80 };
  assert.equal(selectSidebarTooltip(null, focusedA), focusedA, "focus A shows A");
  assert.equal(selectSidebarTooltip(hoveredB, focusedA), hoveredB, "hover B overrides focus A");
  assert.equal(selectSidebarTooltip(null, focusedA), focusedA, "leaving B restores focused A");
  assert.equal(selectSidebarTooltip(hoveredB, null), hoveredB, "blurring A keeps hovered B");
  assert.equal(selectSidebarTooltip(null, null), null, "tooltip hides after both sources end");
  assert.match(source, /selectSidebarTooltip\(hoveredSidebarTooltip, focusedSidebarTooltip\)/);
  assert.match(source, /onClick=\{\(\) => \{\s*clearSidebarTooltips\(\);\s*setIsSidebarOpen\(!isSidebarOpen\);/);
  assert.match(source, /onScroll=\{clearSidebarTooltips\}/);
  assert.match(source, /<\/aside>\s*<div\s+role="tooltip"/);
  assert.match(tooltip, /fixed/);
  assert.match(tooltip, /-translate-y-1\/2/);
  assert.match(tooltip, /motion-reduce:transition-none/);
  assert.doesNotMatch(tooltip, /motion-reduce:transform-none/);
  assert.equal(tooltip.match(/visibleSidebarTooltip/g)?.length, 4);
  assert.doesNotMatch(source, /title=\{collapsed \? item\.name/);
});
