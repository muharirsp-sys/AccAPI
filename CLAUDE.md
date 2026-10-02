# CLAUDE.md

Project instructions for Claude Code. The general working rules live in `AGENTS.md` (read it too);
the implemented UI conventions live in `docs/UI_DESIGN_SYSTEM.md`.

## UI/UX Rule

Never redesign UI based on aesthetic preference alone.

Before modifying an existing screen:
1. inspect the rendered page,
2. understand its workflow,
3. identify the concrete UX problem,
4. preserve business semantics and information density,
5. implement the smallest coherent improvement,
6. verify it in the browser.

Do not introduce generic AI-dashboard patterns.

When using external UI libraries, reuse individual primitives/components
instead of replacing the project's visual identity.

For frontend/library questions, consult current documentation through Context7
when available.

For completed UI work, validate the rendered result using Playwright and,
when relevant, Chrome DevTools.
