// Framework adapter registry (M65). Every framework daimon understands is a
// declarative row here — detection markers, spawn command, readiness/URL
// patterns, and error-parser id. discovery.ts iterates this table; new
// frameworks are new rows (plus a fixture in test/fixtures/frameworks/),
// never new branches in discovery.ts.
//
// Custom user profiles (`frameworks: []` in daimon.config.json) are DATA:
// validated regex strings and references to built-in parser ids. They are
// never loaded code.

import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredApp } from './types.js';

export type FrameworkFamily =
  | 'js' | 'python' | 'ruby' | 'go' | 'rust' | 'dotnet' | 'jvm' | 'php' | 'mobile';

export interface FileContainsRule {
  file: string;
  pattern: string; // compiled case-insensitively at match time
}

export interface FrameworkDetect {
  // Every listed path (file or directory, relative to root) must exist.
  files?: string[];
  // At least one listed path must exist.
  anyFiles?: string[];
  // At least one entry must match: its file exists and its content matches.
  fileContains?: FileContainsRule[];
  // At least one root-level file matching the glob contains the pattern
  // (dotnet's "*.csproj with Sdk=Web"). Built-in rows only.
  globContains?: { glob: string; pattern: string }[];
  // package.json probes: dependsOn = at least one dep/devDep present;
  // script = at least one script name present. Both clauses must hold when given.
  packageJson?: { dependsOn?: string[]; script?: string[] };
}

export interface FrameworkProfile {
  id: string;
  family: FrameworkFamily;
  detect: FrameworkDetect;
  // Spawn command. Workspace enumerators (nx/angular) use the {name} placeholder.
  command: string;
  // "server is up" stdout line — drives compiling→serving for profiles whose
  // output the generic parser doesn't recognise (M67).
  readiness?: { pattern: string; timeoutMs?: number };
  // Announced-URL extraction; first capture group is the URL (M67).
  url?: { pattern: string };
  // Id of a built-in parser (see KNOWN_ERROR_PARSER_IDS) — never loaded code.
  errorParser?: string;
  healthProbe?: 'http' | 'tcp' | 'none';
  // Multi-project enumerator for workspace roots.
  workspace?: 'nx' | 'angular' | 'pnpm' | 'turbo';
  // What discovery stamps on DiscoveredApp.workspaceType.
  workspaceType: DiscoveredApp['workspaceType'];
  // App name becomes `${basename(root)}${nameSuffix}` (storybook).
  nameSuffix?: string;
  // Skip this profile for a root when any of these profile ids already
  // matched the same root (vite beats the polyglot rows; nx beats angular).
  suppressedBy?: string[];
  // Generic last-resort profile (package-json): only consulted when NO other
  // profile matched the directory, and never inside node_modules.
  fallback?: boolean;
  // First entry whose marker file exists picks the command; `win32` variant
  // used on Windows (./mvnw → mvnw.cmd). Falls back to `command`.
  commandCandidates?: { ifFile: string; command: string; win32?: string }[];
  // Windows replacement for `command` (bin/rails needs the ruby shim).
  win32Command?: string;
  // Short badge tag for the dashboard/TUI/VS Code ('next', 'dj', 'rs'…) and
  // a deterministic accent hue (0–360) for the framework tone (M70).
  badge?: string;
  tone?: number;
  // Test-runner hint (M74). One of KNOWN_TEST_RUNNER_IDS in testRunners.ts:
  // 'vitest-jest' rows resolve the concrete runner (and command) per app via
  // a lockfile-aware dependency check; the polyglot ids map 1:1 to a command.
  testRunner?: string;
  builtin: boolean;
}

// Deterministic FNV-1a hue for profiles without an explicit tone (customs).
export function profileTone(profile: Pick<FrameworkProfile, 'id' | 'tone'>): number {
  if (typeof profile.tone === 'number') return ((profile.tone % 360) + 360) % 360;
  let h = 2166136261;
  for (let i = 0; i < profile.id.length; i++) {
    h ^= profile.id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

export function profileBadge(profile: Pick<FrameworkProfile, 'id' | 'badge'>): string {
  return profile.badge ?? profile.id.slice(0, 5);
}

// Command placeholders, resolved per directory at discovery time:
//   {name}   — project name (workspace enumerators)
//   {script} — first present script from detect.packageJson.script order
//   {pmRun}  — npm run|pnpm run|yarn|bun run   (by lockfile)
//   {pmExec} — npx|pnpm exec|yarn|bunx          (by lockfile)
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// Parser ids a profile (built-in or custom) may reference. Matches the
// ParserTool union in types.ts; M67 extends it with the multi-line parsers.
export const KNOWN_ERROR_PARSER_IDS: ReadonlySet<string> = new Set([
  'esbuild', 'vite', 'storybook', 'jest', 'nx', 'webpack', 'node', 'typescript',
  'django', 'rails', 'fastapi', 'go-air', 'rust-trunk', 'python',
  // M67/M68 per-profile parsers (multi-line aware; see PROFILE_ERROR_RULES in parser.ts).
  'python-traceback', 'go-build', 'rust-cargo', 'dotnet', 'jvm-gradle', 'php',
]);

// Regex strings from config are compiled once here; cap length so a
// pathological pattern can't be smuggled in (they run against log lines later).
export const MAX_PATTERN_CHARS = 512;

// ---------------------------------------------------------------------------
// Built-in rows. Order matters: earlier rows win suppression contests, and
// `daimon frameworks` lists them in this order.
// ---------------------------------------------------------------------------

const BUILTINS: FrameworkProfile[] = [
  {
    id: 'nx',
    family: 'js',
    detect: { files: ['nx.json'] },
    command: 'npx nx serve {name}',
    workspace: 'nx',
    workspaceType: 'nx',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'angular',
    family: 'js',
    detect: { files: ['angular.json'] },
    command: 'npx ng serve {name}',
    workspace: 'angular',
    workspaceType: 'angular',
    healthProbe: 'http',
    // nx.json + angular.json describe the same workspace twice — nx wins.
    suppressedBy: ['nx'],
    builtin: true,
  },
  // Tauri (M69) sits before the JS meta-frameworks: a Tauri repo usually
  // carries the frontend's config too, but `tauri dev` is the right dev
  // command (it launches the frontend and the Rust shell together).
  {
    id: 'tauri',
    family: 'mobile',
    detect: { files: ['src-tauri/tauri.conf.json'] },
    command: '{pmRun} tauri dev',
    // Readiness/URL come from the underlying vite/next dev-server lines,
    // which the generic patterns already recognise.
    errorParser: 'rust-cargo',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  // --- JS meta-frameworks (M66). Ordered before vite: several of them keep a
  // vite.config in the repo, and the framework CLI is the right dev server.
  {
    id: 'nextjs',
    family: 'js',
    detect: { anyFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'] },
    command: '{pmExec} next dev',
    readiness: { pattern: 'Ready in\\s+[\\d.]+' },
    url: { pattern: 'Local:\\s+(https?:\\/\\/\\S+)' },
    workspaceType: 'vite',
    healthProbe: 'http',
    suppressedBy: ['tauri'],
    builtin: true,
  },
  {
    id: 'nuxt',
    family: 'js',
    detect: { anyFiles: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] },
    command: '{pmExec} nuxi dev',
    readiness: { pattern: 'Local:\\s+https?:\\/\\/' },
    url: { pattern: 'Local:\\s+(https?:\\/\\/\\S+)' },
    workspaceType: 'vite',
    healthProbe: 'http',
    suppressedBy: ['tauri'],
    builtin: true,
  },
  {
    id: 'sveltekit',
    family: 'js',
    detect: {
      anyFiles: ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs', 'svelte.config.cjs'],
      packageJson: { dependsOn: ['@sveltejs/kit'] },
    },
    command: '{pmExec} vite dev',
    readiness: { pattern: 'VITE v[\\d.]+\\s+ready|ready in \\d+' },
    url: { pattern: 'Local:\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'vite',
    workspaceType: 'vite',
    healthProbe: 'http',
    suppressedBy: ['tauri'],
    builtin: true,
  },
  {
    id: 'astro',
    family: 'js',
    detect: { anyFiles: ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.cjs'] },
    command: '{pmExec} astro dev',
    readiness: { pattern: 'astro\\s+v[\\d.]+\\s+ready|ready in \\d+' },
    // Astro's box-drawing banner has no colon after "Local".
    url: { pattern: 'Local\\s+:?\\s*(https?:\\/\\/\\S+)' },
    errorParser: 'vite',
    workspaceType: 'vite',
    healthProbe: 'http',
    suppressedBy: ['tauri'],
    builtin: true,
  },
  {
    id: 'remix',
    family: 'js',
    detect: {
      anyFiles: [
        'react-router.config.ts', 'react-router.config.js', 'react-router.config.mjs',
        'remix.config.js', 'remix.config.cjs', 'remix.config.ts',
      ],
    },
    command: '{pmExec} react-router dev',
    readiness: { pattern: 'VITE v[\\d.]+\\s+ready|ready in \\d+' },
    url: { pattern: 'Local:\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'vite',
    workspaceType: 'vite',
    healthProbe: 'http',
    suppressedBy: ['tauri'],
    builtin: true,
  },
  // --- Mobile/native wave (M69): dev-server aspects only. Web-preview URL
  // becomes the app URL; device/emulator flows stay in the framework's own
  // terminal UX (daimon logs still capture them).
  {
    id: 'expo',
    family: 'mobile',
    detect: { files: ['app.json'], packageJson: { dependsOn: ['expo'] } },
    command: '{pmExec} expo start',
    readiness: { pattern: 'Metro waiting on' },
    url: { pattern: 'Web is waiting on\\s+(https?:\\/\\/\\S+)' },
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'flutter',
    family: 'mobile',
    detect: { files: ['pubspec.yaml'], fileContains: [{ file: 'pubspec.yaml', pattern: 'sdk:\\s*flutter|\\bflutter\\b' }] },
    command: 'flutter run -d web-server',
    readiness: { pattern: 'is available at|is being served at' },
    url: { pattern: '(?:is available at|is being served at):?\\s*(https?:\\/\\/\\S+)' },
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  // --- Runtime profiles (M79): deno / bun apps that aren't otherwise a known
  // framework. Suppressed by every framework row so they only catch plain
  // runtime projects.
  {
    id: 'deno',
    family: 'js',
    detect: { anyFiles: ['deno.json', 'deno.jsonc'] },
    command: 'deno task dev',
    readiness: { pattern: 'Listening on|Local:\\s+https?:\\/\\/' },
    url: { pattern: '(?:Listening on|Local:)\\s+(https?:\\/\\/\\S+)' },
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['nx', 'angular', 'tauri', 'nextjs', 'nuxt', 'sveltekit', 'astro', 'remix'],
    builtin: true,
  },
  {
    id: 'bun',
    family: 'js',
    detect: { anyFiles: ['bunfig.toml', 'bun.lock', 'bun.lockb'], packageJson: { script: ['dev'] } },
    command: 'bun run {script}',
    url: { pattern: '(?:listening|running|Local:?)\\s+(?:on|at)?:?\\s+.*?(https?:\\/\\/\\S+)' },
    workspaceType: 'polyglot',
    // Plain bun servers rarely announce readiness — TCP flip like express-nest.
    healthProbe: 'tcp',
    suppressedBy: ['nx', 'angular', 'tauri', 'nextjs', 'nuxt', 'sveltekit', 'astro', 'remix', 'vite', 'storybook', 'expo'],
    builtin: true,
  },
  {
    id: 'vite',
    family: 'js',
    detect: { anyFiles: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'] },
    command: 'npx vite',
    errorParser: 'vite',
    workspaceType: 'vite',
    healthProbe: 'http',
    // A meta-framework's (or tauri shell's) vite.config belongs to that
    // framework's own dev server.
    suppressedBy: ['nextjs', 'nuxt', 'sveltekit', 'astro', 'remix', 'tauri'],
    builtin: true,
  },
  {
    id: 'storybook',
    family: 'js',
    detect: { files: ['.storybook'] },
    command: 'npx storybook dev --no-open',
    errorParser: 'storybook',
    workspaceType: 'storybook',
    nameSuffix: '-storybook',
    healthProbe: 'http',
    builtin: true,
  },
  // --- Polyglot rows, upgraded from spawn-only to full pipeline citizens
  // (M68): readiness drives compiling→serving, url feeds the probe, and the
  // errorParser ids select the M67 multi-line parsers.
  {
    id: 'django',
    family: 'python',
    detect: { files: ['manage.py'], fileContains: [{ file: 'manage.py', pattern: '\\bdjango\\b' }] },
    command: 'python manage.py runserver',
    readiness: { pattern: 'Quit the server with CONTROL-C' },
    url: { pattern: 'Starting development server at\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'python-traceback',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['vite', 'storybook'],
    builtin: true,
  },
  {
    id: 'rails',
    family: 'ruby',
    detect: { files: ['bin/rails', 'Gemfile'] },
    command: 'bin/rails server',
    // Windows has no shebang handling — run the binstub through ruby.
    win32Command: 'ruby bin/rails server',
    readiness: { pattern: 'Use Ctrl-C to stop|Listening on (?:tcp|http)' },
    errorParser: 'rails',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['vite', 'storybook'],
    builtin: true,
  },
  {
    id: 'fastapi',
    family: 'python',
    detect: {
      fileContains: [
        { file: 'pyproject.toml', pattern: '\\bfastapi\\b' },
        { file: 'requirements.txt', pattern: '\\bfastapi\\b' },
      ],
    },
    command: 'uvicorn main:app --reload',
    readiness: { pattern: 'Application startup complete|Uvicorn running on' },
    url: { pattern: 'Uvicorn running on\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'python-traceback',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['vite', 'storybook'],
    builtin: true,
  },
  {
    id: 'go-air',
    family: 'go',
    detect: { anyFiles: ['.air.toml', 'air.toml'] },
    command: 'air',
    readiness: { pattern: '^running\\.\\.\\.' },
    errorParser: 'go-build',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['vite', 'storybook'],
    builtin: true,
  },
  {
    id: 'rust-trunk',
    family: 'rust',
    detect: { files: ['Trunk.toml'] },
    command: 'trunk serve',
    readiness: { pattern: 'serving static assets at|server listening at' },
    url: { pattern: '(?:serving static assets at|server listening at)\\s*(?:->\\s*)?(https?:\\/\\/\\S+)' },
    errorParser: 'rust-cargo',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    suppressedBy: ['vite', 'storybook'],
    builtin: true,
  },
  // --- Backend wave (M68).
  {
    id: 'dotnet',
    family: 'dotnet',
    detect: { globContains: [{ glob: '*.csproj', pattern: 'Sdk="Microsoft\\.NET\\.Sdk\\.Web"' }] },
    command: 'dotnet watch',
    readiness: { pattern: 'Now listening on:' },
    url: { pattern: 'Now listening on:\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'dotnet',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'spring-boot',
    family: 'jvm',
    detect: {
      fileContains: [
        { file: 'pom.xml', pattern: 'spring-boot' },
        { file: 'build.gradle', pattern: 'org\\.springframework\\.boot' },
        { file: 'build.gradle.kts', pattern: 'org\\.springframework\\.boot' },
      ],
    },
    command: 'mvn spring-boot:run',
    commandCandidates: [
      { ifFile: 'mvnw', command: './mvnw spring-boot:run', win32: 'mvnw.cmd spring-boot:run' },
      { ifFile: 'gradlew', command: './gradlew bootRun', win32: 'gradlew.cmd bootRun' },
      { ifFile: 'pom.xml', command: 'mvn spring-boot:run' },
      { ifFile: 'build.gradle', command: 'gradle bootRun' },
      { ifFile: 'build.gradle.kts', command: 'gradle bootRun' },
    ],
    readiness: { pattern: 'Started \\S+ in [\\d.]+ seconds' },
    errorParser: 'jvm-gradle',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'laravel',
    family: 'php',
    detect: { files: ['artisan'], fileContains: [{ file: 'artisan', pattern: 'laravel|Illuminate' }] },
    command: 'php artisan serve',
    readiness: { pattern: 'Server running on' },
    url: { pattern: 'Server running on:?\\s+\\[?(https?:\\/\\/[^\\]\\s]+)' },
    errorParser: 'php',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'flask',
    family: 'python',
    detect: {
      anyFiles: ['app.py', 'wsgi.py'],
      fileContains: [
        { file: 'requirements.txt', pattern: '\\bflask\\b' },
        { file: 'pyproject.toml', pattern: '\\bflask\\b' },
      ],
    },
    command: 'flask run',
    readiness: { pattern: '\\* Running on' },
    url: { pattern: 'Running on\\s+(https?:\\/\\/\\S+)' },
    errorParser: 'python-traceback',
    workspaceType: 'polyglot',
    healthProbe: 'http',
    builtin: true,
  },
  {
    id: 'express-nest',
    family: 'js',
    detect: { packageJson: { dependsOn: ['express', '@nestjs/core'], script: ['dev', 'start'] } },
    command: '{pmRun} {script}',
    url: { pattern: '(?:listening|running)\\s+(?:on|at):?\\s+.*?(https?:\\/\\/\\S+)' },
    // Plain node servers rarely announce readiness on stdout — the TCP
    // fallback flips them to serving when the port accepts connections.
    healthProbe: 'tcp',
    workspaceType: 'polyglot',
    builtin: true,
  },
  // --- Monorepo enumerators (M66): like nx, these register member packages,
  // not a root app. nx/angular own their workspace when both are present.
  {
    id: 'pnpm-workspace',
    family: 'js',
    detect: { files: ['pnpm-workspace.yaml'] },
    command: '',
    workspace: 'pnpm',
    workspaceType: 'vite',
    suppressedBy: ['nx', 'angular'],
    builtin: true,
  },
  {
    id: 'turbo',
    family: 'js',
    detect: { files: ['turbo.json'] },
    command: '',
    workspace: 'turbo',
    workspaceType: 'vite',
    suppressedBy: ['nx', 'angular', 'pnpm-workspace'],
    builtin: true,
  },
  // --- Generic package.json fallback (M66). Lowest precedence: consulted
  // only when nothing else matched the directory. Script order is the
  // command-selection order (dev, then serve, then start).
  {
    id: 'package-json',
    family: 'js',
    detect: { packageJson: { script: ['dev', 'serve', 'start'] } },
    command: '{pmRun} {script}',
    workspaceType: 'vite',
    healthProbe: 'http',
    fallback: true,
    builtin: true,
  },
];

// Badge tag + accent hue per built-in (M70). Hues loosely track each
// framework's brand color; the dashboard renders them as monochrome glyphs
// tinted by tone, the TUI/VS Code as short [tags].
const BADGES: Record<string, { badge: string; tone: number }> = {
  nx: { badge: 'nx', tone: 217 },
  angular: { badge: 'ng', tone: 348 },
  tauri: { badge: 'tauri', tone: 45 },
  nextjs: { badge: 'next', tone: 240 },
  nuxt: { badge: 'nuxt', tone: 152 },
  sveltekit: { badge: 'kit', tone: 15 },
  astro: { badge: 'astro', tone: 275 },
  remix: { badge: 'rr', tone: 200 },
  vite: { badge: 'vite', tone: 265 },
  storybook: { badge: 'sb', tone: 330 },
  django: { badge: 'dj', tone: 150 },
  rails: { badge: 'rails', tone: 5 },
  fastapi: { badge: 'fast', tone: 175 },
  'go-air': { badge: 'go', tone: 190 },
  'rust-trunk': { badge: 'rs', tone: 25 },
  dotnet: { badge: '.net', tone: 262 },
  'spring-boot': { badge: 'spr', tone: 130 },
  laravel: { badge: 'lara', tone: 10 },
  flask: { badge: 'flask', tone: 210 },
  'express-nest': { badge: 'node', tone: 340 },
  expo: { badge: 'expo', tone: 250 },
  flutter: { badge: 'flut', tone: 205 },
  deno: { badge: 'deno', tone: 160 },
  bun: { badge: 'bun', tone: 30 },
  'pnpm-workspace': { badge: 'pnpm', tone: 35 },
  turbo: { badge: 'turbo', tone: 315 },
  'package-json': { badge: 'npm', tone: 355 },
};
for (const p of BUILTINS) {
  const b = BADGES[p.id];
  if (b) { p.badge = b.badge; p.tone = b.tone; }
}

// Test-runner hints (M74). JS rows share 'vitest-jest' — the concrete runner
// (vitest vs jest vs plain `test` script) is resolved per app by a
// lockfile-aware dependency check in testRunners.ts. Rows without a hint
// (rails/laravel/spring-boot/expo/flutter) resolve only via an explicit
// overrides.<app>.testCommand — their runners' output has no built-in parser.
const TEST_RUNNERS: Record<string, string> = {
  nx: 'vitest-jest',
  angular: 'vitest-jest',
  nextjs: 'vitest-jest',
  nuxt: 'vitest-jest',
  sveltekit: 'vitest-jest',
  astro: 'vitest-jest',
  remix: 'vitest-jest',
  vite: 'vitest-jest',
  'express-nest': 'vitest-jest',
  'package-json': 'vitest-jest',
  bun: 'vitest-jest',
  django: 'pytest',
  fastapi: 'pytest',
  flask: 'pytest',
  'go-air': 'go-test',
  'rust-trunk': 'cargo-test',
  tauri: 'cargo-test',
  dotnet: 'dotnet-test',
};
for (const p of BUILTINS) {
  const t = TEST_RUNNERS[p.id];
  if (t) p.testRunner = t;
}

export function builtinProfiles(): FrameworkProfile[] {
  return BUILTINS;
}

export function allProfiles(custom: FrameworkProfile[] | undefined): FrameworkProfile[] {
  if (!custom || custom.length === 0) return BUILTINS;
  // Custom profiles are checked after built-ins — but the generic fallback
  // row stays last overall, so a custom profile beats `npm run dev`.
  const named = BUILTINS.filter(p => !p.fallback);
  const fallbacks = BUILTINS.filter(p => p.fallback);
  return [...named, ...custom, ...fallbacks];
}

// ---------------------------------------------------------------------------
// Detection. A RootFs memoizes fs probes so N profiles share one stat/read
// per marker path (M54 perf budgets stay green).
// ---------------------------------------------------------------------------

export class RootFs {
  private existsCache = new Map<string, boolean>();
  private contentCache = new Map<string, string | null>();
  private globCache = new Map<string, string[]>();
  private pkgJson: any | null | undefined;

  constructor(readonly root: string) {}

  // Root-level (depth 1) glob, memoized. Returns matching file names.
  glob(pattern: string): string[] {
    let hit = this.globCache.get(pattern);
    if (hit === undefined) {
      try {
        hit = fs.readdirSync(this.root).filter(name => {
          if (!matchSimpleGlob(pattern, name)) return false;
          try { return fs.statSync(path.join(this.root, name)).isFile(); } catch { return false; }
        });
      } catch {
        hit = [];
      }
      this.globCache.set(pattern, hit);
    }
    return hit;
  }

  exists(rel: string): boolean {
    let hit = this.existsCache.get(rel);
    if (hit === undefined) {
      hit = fs.existsSync(path.join(this.root, rel));
      this.existsCache.set(rel, hit);
    }
    return hit;
  }

  content(rel: string): string | null {
    let hit = this.contentCache.get(rel);
    if (hit === undefined) {
      try {
        hit = fs.readFileSync(path.join(this.root, rel), 'utf8');
      } catch {
        hit = null;
      }
      this.contentCache.set(rel, hit);
    }
    return hit;
  }

  packageJson(): any | null {
    if (this.pkgJson === undefined) {
      const raw = this.content('package.json');
      try {
        this.pkgJson = raw ? JSON.parse(raw) : null;
      } catch {
        this.pkgJson = null;
      }
    }
    return this.pkgJson;
  }
}

// ---------------------------------------------------------------------------
// Package-manager awareness (M66). Detection only reads lockfile NAMES —
// daimon never runs install commands. Member packages inherit the workspace
// root's lockfile when they have none of their own.
// ---------------------------------------------------------------------------

export function detectPackageManager(dirs: RootFs[]): PackageManager {
  for (const d of dirs) {
    if (d.exists('pnpm-lock.yaml')) return 'pnpm';
    if (d.exists('yarn.lock')) return 'yarn';
    if (d.exists('bun.lock') || d.exists('bun.lockb')) return 'bun';
    if (d.exists('package-lock.json')) return 'npm';
  }
  return 'npm';
}

export function pmRun(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'pnpm': return `pnpm run ${script}`;
    case 'yarn': return `yarn ${script}`;
    case 'bun': return `bun run ${script}`;
    default: return `npm run ${script}`;
  }
}

export function pmExec(pm: PackageManager, cmd: string): string {
  switch (pm) {
    case 'pnpm': return `pnpm exec ${cmd}`;
    case 'yarn': return `yarn ${cmd}`;
    case 'bun': return `bunx ${cmd}`;
    default: return `npx ${cmd}`;
  }
}

// Resolve {script}/{pmRun}/{pmExec} placeholders for a concrete directory.
// Returns null when the command needs a script the package.json doesn't have.
// `platform` is injectable for tests; Windows picks commandCandidates' win32
// variants (mvnw.cmd) and win32Command (ruby bin/rails).
export function resolveCommand(
  profile: FrameworkProfile,
  dirFs: RootFs,
  workspaceFs?: RootFs,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let cmd = profile.command;
  let candidateHit = false;
  if (profile.commandCandidates) {
    for (const c of profile.commandCandidates) {
      if (!dirFs.exists(c.ifFile)) continue;
      cmd = platform === 'win32' && c.win32 ? c.win32 : c.command;
      candidateHit = true;
      break;
    }
  }
  if (!candidateHit && platform === 'win32' && profile.win32Command) cmd = profile.win32Command;
  if (cmd.includes('{script}')) {
    const scripts = dirFs.packageJson()?.scripts ?? {};
    const order = profile.detect.packageJson?.script ?? [];
    const script = order.find(s => typeof scripts[s] === 'string');
    if (!script) return null;
    cmd = cmd.split('{script}').join(script);
  }
  if (cmd.includes('{pmRun}') || cmd.includes('{pmExec}')) {
    const pm = detectPackageManager(workspaceFs && workspaceFs !== dirFs ? [dirFs, workspaceFs] : [dirFs]);
    cmd = cmd.replace(/\{pmRun\}\s+(.+)$/, (_m, rest) => pmRun(pm, rest));
    cmd = cmd.replace(/\{pmExec\}\s+(.+)$/, (_m, rest) => pmExec(pm, rest));
  }
  return cmd;
}

function compilePattern(pattern: string): RegExp | null {
  if (pattern.length > MAX_PATTERN_CHARS) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// Minimal `*`-only glob for root-level marker files ("*.csproj").
function matchSimpleGlob(pattern: string, name: string): boolean {
  const rx = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return rx.test(name);
}

export function matchDetect(detect: FrameworkDetect, rootFs: RootFs): boolean {
  const hasClause = !!(detect.files?.length || detect.anyFiles?.length || detect.fileContains?.length
    || detect.globContains?.length
    || detect.packageJson?.dependsOn?.length || detect.packageJson?.script?.length);
  if (!hasClause) return false;

  if (detect.files && !detect.files.every(f => rootFs.exists(f))) return false;
  if (detect.anyFiles && !detect.anyFiles.some(f => rootFs.exists(f))) return false;

  if (detect.fileContains) {
    const anyMatch = detect.fileContains.some(rule => {
      if (!rootFs.exists(rule.file)) return false;
      const content = rootFs.content(rule.file);
      if (content === null) return false;
      const rx = compilePattern(rule.pattern);
      return rx ? rx.test(content) : false;
    });
    if (!anyMatch) return false;
  }

  if (detect.globContains) {
    const anyMatch = detect.globContains.some(rule => {
      const rx = compilePattern(rule.pattern);
      if (!rx) return false;
      return rootFs.glob(rule.glob).some(name => {
        const content = rootFs.content(name);
        return content !== null && rx.test(content);
      });
    });
    if (!anyMatch) return false;
  }

  if (detect.packageJson) {
    const pkg = rootFs.packageJson();
    if (!pkg || typeof pkg !== 'object') return false;
    const { dependsOn, script } = detect.packageJson;
    if (dependsOn?.length) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (!dependsOn.some(d => Object.prototype.hasOwnProperty.call(deps, d))) return false;
    }
    if (script?.length) {
      const scripts = pkg.scripts ?? {};
      if (!script.some(s => typeof scripts[s] === 'string')) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Workspace member globs (M66). pnpm-workspace.yaml is parsed with a minimal
// YAML subset (a top-level `packages:` list) — good enough for the file's
// documented shape without adding a YAML dependency.
// ---------------------------------------------------------------------------

export function pnpmWorkspaceGlobs(content: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  let inPackages = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^packages\s*:\s*(#.*)?$/.test(line)) { inPackages = true; continue; }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^\s*-\s*['"]?([^'"#\r\n]+?)['"]?\s*(#.*)?$/);
    if (!m) continue;
    const glob = m[1].trim();
    if (!glob) continue;
    if (glob.startsWith('!')) exclude.push(glob.slice(1));
    else include.push(glob);
  }
  return { include, exclude };
}

// npm/yarn/bun style `workspaces` in package.json: string[] or { packages: string[] }.
export function packageJsonWorkspaceGlobs(pkg: any): { include: string[]; exclude: string[] } {
  const raw = Array.isArray(pkg?.workspaces) ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages
    : [];
  const include: string[] = [];
  const exclude: string[] = [];
  for (const g of raw) {
    if (typeof g !== 'string' || !g.trim()) continue;
    if (g.startsWith('!')) exclude.push(g.slice(1));
    else include.push(g.trim());
  }
  return { include, exclude };
}

// ---------------------------------------------------------------------------
// Custom-profile validation (config `frameworks: []`). Broken entries fall
// back to "skipped with a warning" — same softening contract as the rest of
// config validation (M55); doctor surfaces the warnings.
// ---------------------------------------------------------------------------

const CUSTOM_ID_RX = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function validPatternString(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATTERN_CHARS && compilePattern(p) !== null;
}

function validStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim().length > 0);
}

export function validateCustomProfiles(
  raw: unknown,
  warn: (msg: string) => void,
): FrameworkProfile[] {
  if (!Array.isArray(raw)) {
    warn('"frameworks" must be an array of profile objects');
    return [];
  }
  const out: FrameworkProfile[] = [];
  const builtinIds = new Set(BUILTINS.map(b => b.id));
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warn('"frameworks" entry is not an object — skipped');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!CUSTOM_ID_RX.test(id)) {
      warn(`"frameworks" entry has missing/invalid id ${JSON.stringify(e.id ?? null)} — skipped`);
      continue;
    }
    if (builtinIds.has(id)) {
      warn(`"frameworks.${id}" clashes with a built-in profile id — skipped`);
      continue;
    }
    if (seen.has(id)) {
      warn(`"frameworks.${id}" is defined twice — keeping first`);
      continue;
    }
    if (typeof e.command !== 'string' || !e.command.trim()) {
      warn(`"frameworks.${id}" has no command — skipped`);
      continue;
    }

    const d = (e.detect ?? {}) as Record<string, unknown>;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      warn(`"frameworks.${id}" detect must be an object — skipped`);
      continue;
    }
    const detect: FrameworkDetect = {};
    let bad: string | null = null;
    if (d.files !== undefined) {
      if (validStringArray(d.files)) detect.files = d.files;
      else bad = 'detect.files must be a non-empty array of strings';
    }
    if (!bad && d.anyFiles !== undefined) {
      if (validStringArray(d.anyFiles)) detect.anyFiles = d.anyFiles;
      else bad = 'detect.anyFiles must be a non-empty array of strings';
    }
    if (!bad && d.fileContains !== undefined) {
      if (Array.isArray(d.fileContains) && d.fileContains.length > 0
        && d.fileContains.every((r: any) => r && typeof r === 'object'
          && typeof r.file === 'string' && r.file.trim() && validPatternString(r.pattern))) {
        detect.fileContains = (d.fileContains as any[]).map(r => ({ file: r.file, pattern: r.pattern }));
      } else {
        bad = 'detect.fileContains entries must be { file, pattern } with a valid regex ≤ ' + MAX_PATTERN_CHARS + ' chars';
      }
    }
    if (!bad && d.packageJson !== undefined) {
      const pj = d.packageJson as any;
      if (pj && typeof pj === 'object' && !Array.isArray(pj)
        && (pj.dependsOn === undefined || validStringArray(pj.dependsOn))
        && (pj.script === undefined || validStringArray(pj.script))
        && (pj.dependsOn !== undefined || pj.script !== undefined)) {
        detect.packageJson = {};
        if (pj.dependsOn) detect.packageJson.dependsOn = pj.dependsOn;
        if (pj.script) detect.packageJson.script = pj.script;
      } else {
        bad = 'detect.packageJson must be { dependsOn?: string[], script?: string[] } with at least one clause';
      }
    }
    if (bad) {
      warn(`"frameworks.${id}" ${bad} — skipped`);
      continue;
    }
    if (!detect.files && !detect.anyFiles && !detect.fileContains && !detect.packageJson) {
      warn(`"frameworks.${id}" detect has no clauses (files/anyFiles/fileContains/packageJson) — skipped`);
      continue;
    }

    const profile: FrameworkProfile = {
      id,
      family: isFamily(e.family) ? e.family : 'js',
      detect,
      command: e.command.trim(),
      workspaceType: 'polyglot',
      builtin: false,
    };

    if (e.readiness !== undefined) {
      const r = e.readiness as any;
      if (r && typeof r === 'object' && validPatternString(r.pattern)) {
        profile.readiness = { pattern: r.pattern };
        if (typeof r.timeoutMs === 'number' && r.timeoutMs > 0) profile.readiness.timeoutMs = r.timeoutMs;
      } else {
        warn(`"frameworks.${id}" readiness.pattern is not a valid regex ≤ ${MAX_PATTERN_CHARS} chars — skipped`);
        continue;
      }
    }
    if (e.url !== undefined) {
      const u = e.url as any;
      if (u && typeof u === 'object' && validPatternString(u.pattern)) {
        profile.url = { pattern: u.pattern };
      } else {
        warn(`"frameworks.${id}" url.pattern is not a valid regex ≤ ${MAX_PATTERN_CHARS} chars — skipped`);
        continue;
      }
    }
    if (e.errorParser !== undefined) {
      if (typeof e.errorParser === 'string' && KNOWN_ERROR_PARSER_IDS.has(e.errorParser)) {
        profile.errorParser = e.errorParser;
      } else {
        warn(`"frameworks.${id}" references unknown errorParser ${JSON.stringify(e.errorParser)} (known: ${[...KNOWN_ERROR_PARSER_IDS].join(', ')}) — skipped`);
        continue;
      }
    }
    if (e.healthProbe !== undefined) {
      if (e.healthProbe === 'http' || e.healthProbe === 'tcp' || e.healthProbe === 'none') {
        profile.healthProbe = e.healthProbe;
      } else {
        warn(`"frameworks.${id}" healthProbe must be http|tcp|none — skipped`);
        continue;
      }
    }

    seen.add(id);
    out.push(profile);
  }
  return out;
}

function isFamily(v: unknown): v is FrameworkFamily {
  return typeof v === 'string'
    && ['js', 'python', 'ruby', 'go', 'rust', 'dotnet', 'jvm', 'php', 'mobile'].includes(v);
}
