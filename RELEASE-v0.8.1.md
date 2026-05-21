# daimon v0.8.1 — Hotfix

Install: `npm i -g daimon@0.8.1`

Hotfix for three regressions caught running v0.8.0 against a real workspace within minutes of `npm publish`. **Recommended upgrade for everyone on v0.8.0** — the first fix is the most impactful: any browser open to the Errors page was hammering the daemon at ~1,900 req/sec.

## Fixed

- **Dashboard Errors page no longer storms the daemon.** The errors-panel `effect()` was tied to the `api.apps()` signal, which emits a new array reference on every SSE tick even when membership is unchanged — causing N parallel `/api/apps/<name>/errors` fetches per emission. The in-flight guard read `loading()` as a signal, which registered it as the effect's dependency, so `loading.set(true/false)` inside `fetchAll` re-fired the same effect in a tight loop (**~1,900 req/sec observed during the post-publish smoke test, 28,503 requests in 15 seconds**). Replaced with two narrower effects: one keyed on a membership `computed` (refetches only when the app set changes), and a push-driven effect that watches `api.events()` and only refetches when an `error-new` / `error-recur` / `status` event arrives on the existing SSE stream. The in-flight guard was decoupled from the signal via a plain `busy` boolean so writes can't re-fire the effect. The dashboard now consumes the event stream instead of polling it via HTTP.
- **Parser captures real-world Nx serve failures.** v0.7's M33 patterns required a leading `>` decoration (`^\s*>\s+NX\s+.*failed`) — the actual `nx run …:serve` output omits it. Loosened the regex to `^\s*(?:>\s+)?NX\s+.*failed`, added new patterns for `Failed tasks:` and `Task "…" is continuous but exited with code N`, and updated the nx tool-routing regex to recognize the same shapes. New fixture `test/fixtures/parsers/nx-serve-fail.{log,expected.json}` covers the workspace-realistic case where the failure signal lands without a structured `file/line/col`. Resolves the v0.8.0 status/errors disagreement where an app's status flipped to `error` (via process exit code) but the Errors tab said "No errors".
- **Nav-rail tooltip dismisses on click.** Material tooltip persisted on the just-clicked rail link because the link kept focus through the route change, leaving a stuck `g l` / `g e` floater after keyboard or mouse navigation. Added `matTooltipHideDelay="0"`, `matTooltipShowDelay="300"`, and an explicit `blur()` on click.

## Changed

- `parser-corpus.test.mjs` gains a branch for fixtures whose `expected.errors` is empty — it now asserts the failure signal lands (status flips, at least one error entry is recorded) but does not require a parsed file/line/col.

## Verification (live against the keyboard-studio workspace)

| Gate | v0.8.0 | v0.8.1 |
|---|---|---|
| `/errors` page fetch rate | **1,900 req/sec** | **0 req/sec on idle** |
| Stuck nav tooltip after click | `g l` lingers | 0 visible tooltips |
| Nx serve-fail parser coverage | gap | new fixture passing |
| `tsc -p .` (daemon) | clean | clean |
| `tsc -p dashboard/` | clean | clean |
| `npm test` (daemon) | 95/95 | 96/96 (+nx-serve-fail) |
| `npm test` (dashboard, Vitest) | 5/5 | 5/5 |
| Dashboard initial-route gzip | 126.99 KB | 127.07 KB |
| Tarball packed | 537.3 KB | 537.9 KB |

## Why this slipped past pre-publish gates

The pre-publish smoke test drove all 10 routes via Playwright MCP — but against a workspace where all 3 apps were `stopped` with no events firing. The storm only manifests when the SSE event stream has a non-trivial rate (which a real long-running workspace has). The Nx parser gap and the stuck-tooltip both required real navigation patterns on a real workspace too. Lesson recorded for v0.9: the live Playwright drive should be against a workspace with at least one app in `error` state and at least one in `serving`, not just stopped, before any publish.

**Full changelog:** [`CHANGELOG.md`](https://github.com/Yosi-Azulay/daimon/blob/v0.8.1/CHANGELOG.md)
