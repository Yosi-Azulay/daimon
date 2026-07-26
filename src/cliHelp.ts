import { CLI_GROUPS, CLI_SUBCOMMANDS, CLI_ALIASES, findSubcommand, type CliSubcommand, type CliOption } from './cliSurface.js';
import { DAIMON_VERSION } from './version.js';

export interface ColorOpts {
  enabled: boolean;
}

let colorOverride: 'on' | 'off' | null = null;

export function setColorOverride(v: 'on' | 'off' | null): void {
  colorOverride = v;
}

export function isColorEnabled(): boolean {
  if (colorOverride === 'off') return false;
  if (colorOverride === 'on') return true;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === '2' || process.env.FORCE_COLOR === '3') return true;
  return !!process.stdout.isTTY;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function paint(s: string, code: string): string {
  if (!isColorEnabled()) return s;
  return code + s + ANSI.reset;
}

export const color = {
  bold: (s: string) => paint(s, ANSI.bold),
  dim: (s: string) => paint(s, ANSI.dim),
  red: (s: string) => paint(s, ANSI.red),
  green: (s: string) => paint(s, ANSI.green),
  yellow: (s: string) => paint(s, ANSI.yellow),
  cyan: (s: string) => paint(s, ANSI.cyan),
};

export function renderMainHelp(): string {
  const lines: string[] = [];
  lines.push(`${color.bold('daimon')} v${DAIMON_VERSION}`);
  lines.push('usage: daimon <command> [args]');
  lines.push('');
  for (const grp of CLI_GROUPS) {
    const cmds = CLI_SUBCOMMANDS.filter(c => c.group === grp.id);
    if (!cmds.length) continue;
    lines.push(color.bold(grp.title));
    const w = Math.max(...cmds.map(c => c.name.length));
    for (const c of cmds) {
      lines.push('  ' + color.cyan(c.name.padEnd(w)) + '  ' + color.dim(c.summary));
    }
    lines.push('');
  }
  const aliasEntries = Object.entries(CLI_ALIASES);
  if (aliasEntries.length) {
    lines.push(color.bold('aliases'));
    for (const [alias, canonical] of aliasEntries) {
      lines.push('  ' + color.cyan(alias.padEnd(6)) + '  ' + color.dim(`→ ${canonical}`));
    }
    lines.push('');
  }
  lines.push(color.bold('global flags'));
  lines.push('  --help, -h        Show this help (or per-command help when used after a verb).');
  lines.push('  --version, -v     Print the daimon version and exit.');
  lines.push('  --about           Print {version,nodeVersion,platform,configPath,lockPath,claudeArtifacts}.');
  lines.push('  --no-color        Disable ANSI color (also: NO_COLOR=1).');
  lines.push('  --no-spawn        Do not auto-spawn the daemon (also: DAIMON_NO_SPAWN=1).');
  lines.push('  DAIMON_PORT=N     Target a non-default daemon port.');
  lines.push('');
  lines.push(color.bold('flag conventions'));
  lines.push(color.dim('  --timeout <duration>   60s, 5m, 2h'));
  lines.push(color.dim('  --since <duration>     duration window for queries'));
  lines.push(color.dim('  --budget <tokens>      cap response size for agents'));
  lines.push(color.dim('  --until <state>        target state for blocking calls'));
  lines.push(color.dim('  --app <name>           filter to one app'));
  lines.push(color.dim('  --profile <name>       target/filter profile'));
  lines.push(color.dim('  --full / --compact     output shape (compact = default)'));
  lines.push(color.dim('  --stream               NDJSON stream'));
  lines.push(color.dim('  --explain              wrap with _meta diagnostics'));
  lines.push(color.dim('  --dry-run              report planned actions, do not execute'));
  lines.push(color.dim('  --yes                  skip interactive confirmations'));
  return lines.join('\n');
}

export function renderSubcommandHelp(c: CliSubcommand): string {
  const lines: string[] = [];
  lines.push(color.bold(`daimon ${c.name}`) + ' ' + color.dim(c.args));
  lines.push('');
  lines.push(c.description);
  if (c.options?.length) {
    lines.push('');
    lines.push(color.bold('options'));
    const w = Math.max(...c.options.map(o => (o.flag + (o.arg ? ' ' + o.arg : '')).length));
    for (const o of c.options) {
      const left = (o.flag + (o.arg ? ' ' + o.arg : '')).padEnd(w);
      lines.push('  ' + color.cyan(left) + '  ' + color.dim(o.description));
    }
  }
  const examples = c.examples ?? (c.example ? [c.example] : []);
  if (examples.length) {
    lines.push('');
    lines.push(color.bold('examples'));
    for (const ex of examples) lines.push('  ' + ex);
  }
  if (c.exitCodes?.length) {
    lines.push('');
    lines.push(color.bold('exit codes'));
    for (const ec of c.exitCodes) lines.push('  ' + String(ec.code).padStart(2) + '  ' + color.dim(ec.meaning));
  }
  if (c.aliases?.length) {
    lines.push('');
    lines.push(color.bold('aliases') + ' ' + c.aliases.join(', '));
  }
  return lines.join('\n');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function suggestCommand(input: string): string | null {
  const candidates: string[] = CLI_SUBCOMMANDS.map(c => c.name).concat(Object.keys(CLI_ALIASES));
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name ?? null;
}

export function suggestApp(input: string, known: string[]): string | null {
  let best: { name: string; d: number } | null = null;
  for (const c of known) {
    const d = levenshtein(input, c);
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name ?? null;
}

export interface CliErr {
  error: string;
  hint?: string;
  exit?: number;
}

export function formatError(e: CliErr): string {
  return JSON.stringify({ error: e.error, ...(e.hint ? { hint: e.hint } : {}), exit: e.exit ?? 1 });
}

export function formatHumanError(e: CliErr): string {
  const parts: string[] = [color.red('error: ') + e.error];
  if (e.hint) parts.push(color.dim('  hint: ') + e.hint);
  return parts.join('\n');
}

// ---- Data-driven completion model (M113) ---------------------------------
// CLI_SUBCOMMANDS (cliSurface.ts) is the single source of truth; every
// generator below is built from it so bash/zsh/powershell/fish can never
// drift from each other or from the verb surface. Two shapes need care:
//
// 1. Multi-word canonical names ("config validate", "profiles suggest") —
//    the CLI dispatches on the first token, so the completable word is
//    `name.split(' ')[0]`, and the literal second word comes straight out
//    of the same split. No table needed; grouped automatically below.
// 2. Verbs that dispatch on a literal first *argument* rather than a flag,
//    where cliSurface.ts records that as free-text `args` (e.g. daimon's
//    args is "start|stop|status|..."), not structured data. This is the
//    one place that spells out those literal subwords.
const VERB_SUBWORDS: Record<string, string[]> = {
  daemon: ['start', 'stop', 'status', 'restart', 'attach', 'install-service'],
  workspaces: ['list', 'add', 'rm', 'show'],
  plugin: ['list', 'show', 'validate'],
  env: ['diff'],
  searches: ['list', 'save', 'rename', 'delete', 'rm'],
  ci: ['start'],
  claude: ['install', 'update', 'uninstall', 'status'],
  completion: ['bash', 'zsh', 'fish', 'powershell'],
};

const GLOBAL_FLAGS = ['--help', '--no-color', '--no-spawn'];

interface VerbCompletion {
  first: string;
  subwords: string[];
  appPositional: boolean;
  flags: string[];
}

// Most CliOption rows use { flag: '--since', arg: '<duration>' }; a few
// (report/env's --since/--from/--to) inline the placeholder into `flag`
// itself ('--since <window>'). Normalize both shapes to a bare flag token
// plus whether it takes a value.
function normalizeFlag(o: CliOption): { flag: string; hasArg: boolean } {
  const trimmed = o.flag.trim();
  const m = trimmed.match(/^(--[A-Za-z0-9-]+)/);
  const flag = m ? m[1] : trimmed.split(/\s/)[0];
  const hasArg = !!o.arg || flag.length < trimmed.length;
  return { flag, hasArg };
}

function buildVerbCompletions(): VerbCompletion[] {
  const byFirst = new Map<string, VerbCompletion>();
  for (const c of CLI_SUBCOMMANDS) {
    const [first, ...rest] = c.name.split(' ');
    const v = byFirst.get(first) ?? { first, subwords: [], appPositional: false, flags: [] };
    if (rest.length && !v.subwords.includes(rest.join(' '))) v.subwords.push(rest.join(' '));
    for (const sw of VERB_SUBWORDS[first] ?? []) if (!v.subwords.includes(sw)) v.subwords.push(sw);
    // Two placeholder conventions are used for "takes an app name first":
    // <name> everywhere, <app> on `handoff`.
    if (c.args.startsWith('<name>') || c.args.startsWith('<app>')) v.appPositional = true;
    for (const o of c.options ?? []) {
      const { flag } = normalizeFlag(o);
      if (!v.flags.includes(flag)) v.flags.push(flag);
    }
    byFirst.set(first, v);
  }
  return [...byFirst.values()].sort((a, b) => a.first.localeCompare(b.first));
}

const VERB_COMPLETIONS = buildVerbCompletions();
const TOP_LEVEL_WORDS = Array.from(new Set([
  ...VERB_COMPLETIONS.map(v => v.first),
  ...Object.keys(CLI_ALIASES),
])).sort();

function verbFlags(v: VerbCompletion): string[] {
  return Array.from(new Set([...v.flags, ...GLOBAL_FLAGS]));
}

// One-line snippet that fetches known app names via `daimon list --compact`,
// degrading silently to nothing on any failure — shared verbatim by every
// shell so app-name completion behaves identically everywhere.
const FETCH_APPS_NODE = 'try{let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{try{JSON.parse(s).forEach(a=>console.log(a.name||\'\'))}catch(e){}})}catch(e){}';

export function completionBash(): string {
  const lines: string[] = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('# daimon bash completion — generated from src/cliSurface.ts. Do not hand-edit;');
  lines.push('# regenerate with: npm run build && npm run build:completions');
  lines.push('# install: source <(daimon completion bash)  (or copy to /etc/bash_completion.d/daimon)');
  lines.push('_daimon_complete() {');
  lines.push('  local cur cword canon prev apps flags sub');
  lines.push('  COMPREPLY=()');
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push('  cword=$COMP_CWORD');
  lines.push('  prev="${COMP_WORDS[COMP_CWORD-1]}"');
  lines.push('  if [ "$prev" = "--app" ]; then');
  lines.push('    apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)');
  lines.push('    COMPREPLY=( $(compgen -W "$apps" -- "$cur") )');
  lines.push('    return 0');
  lines.push('  fi');
  lines.push('  if [ "$cword" -eq 1 ]; then');
  lines.push('    COMPREPLY=( $(compgen -W "' + TOP_LEVEL_WORDS.join(' ') + '" -- "$cur") )');
  lines.push('    return 0');
  lines.push('  fi');
  lines.push('  canon="${COMP_WORDS[1]}"');
  lines.push('  case "$canon" in');
  for (const [alias, target] of Object.entries(CLI_ALIASES)) {
    lines.push(`    ${alias}) canon="${target.split(' ')[0]}" ;;`);
  }
  lines.push('  esac');
  lines.push('  if [ "$cword" -eq 2 ]; then');
  lines.push('    sub=""');
  lines.push('    case "$canon" in');
  for (const v of VERB_COMPLETIONS) {
    if (v.subwords.length) lines.push(`      ${v.first}) sub="${v.subwords.join(' ')}" ;;`);
  }
  lines.push('    esac');
  const appFirsts = VERB_COMPLETIONS.filter(v => v.appPositional).map(v => v.first);
  if (appFirsts.length) {
    lines.push('    case "$canon" in');
    lines.push(`      ${appFirsts.join('|')})`);
    lines.push('        apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)');
    lines.push('        COMPREPLY=( $(compgen -W "$apps $sub" -- "$cur") )');
    lines.push('        return 0');
    lines.push('        ;;');
    lines.push('    esac');
  }
  lines.push('    if [ -n "$sub" ]; then');
  lines.push('      COMPREPLY=( $(compgen -W "$sub" -- "$cur") )');
  lines.push('      return 0');
  lines.push('    fi');
  lines.push('  fi');
  // `env diff <name>` — the one three-deep case worth resolving explicitly.
  lines.push('  if [ "$cword" -eq 3 ] && [ "$canon" = "env" ] && [ "${COMP_WORDS[2]}" = "diff" ]; then');
  lines.push('    apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)');
  lines.push('    COMPREPLY=( $(compgen -W "$apps" -- "$cur") )');
  lines.push('    return 0');
  lines.push('  fi');
  lines.push('  flags="' + GLOBAL_FLAGS.join(' ') + '"');
  lines.push('  case "$canon" in');
  for (const v of VERB_COMPLETIONS) {
    lines.push(`    ${v.first}) flags="${verbFlags(v).join(' ')}" ;;`);
  }
  lines.push('  esac');
  lines.push('  COMPREPLY=( $(compgen -W "$flags" -- "$cur") )');
  lines.push('}');
  lines.push('complete -F _daimon_complete daimon');
  return lines.join('\n') + '\n';
}

function zshEsc(s: string): string {
  return s.replace(/'/g, "''").replace(/:/g, '\\:').replace(/\[/g, '\\[').replace(/\]/g, '\\]').slice(0, 80);
}

function summaryFor(word: string): string {
  const exact = CLI_SUBCOMMANDS.find(c => c.name === word);
  if (exact) return exact.summary;
  const grouped = CLI_SUBCOMMANDS.find(c => c.name.split(' ')[0] === word);
  if (grouped) return grouped.summary;
  if (CLI_ALIASES[word]) return `alias → ${CLI_ALIASES[word]}`;
  return '';
}

export function completionZsh(): string {
  const lines: string[] = [];
  lines.push('#compdef daimon');
  lines.push('# daimon zsh completion — generated from src/cliSurface.ts. Do not hand-edit;');
  lines.push('# regenerate with: npm run build && npm run build:completions');
  lines.push('# install: daimon completion zsh > "${fpath[1]}/_daimon"  (or source it from .zshrc)');
  lines.push('_daimon() {');
  lines.push('  local -a verbs');
  lines.push('  verbs=(' + TOP_LEVEL_WORDS.map(w => `'${w}:${zshEsc(summaryFor(w))}'`).join(' ') + ')');
  lines.push('  if (( CURRENT == 2 )); then');
  lines.push('    _describe \'command\' verbs');
  lines.push('    return');
  lines.push('  fi');
  lines.push('  if [[ ${words[CURRENT-1]} == --app ]]; then');
  lines.push('    local -a apps');
  lines.push('    apps=(${(f)"$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)"})');
  lines.push('    compadd -a apps');
  lines.push('    return');
  lines.push('  fi');
  lines.push('  local canon=${words[2]}');
  lines.push('  case $canon in');
  for (const [alias, target] of Object.entries(CLI_ALIASES)) {
    lines.push(`    ${alias}) canon=${target.split(' ')[0]} ;;`);
  }
  lines.push('  esac');
  lines.push('  if (( CURRENT == 3 )); then');
  lines.push('    local -a cands');
  lines.push('    case $canon in');
  for (const v of VERB_COMPLETIONS) {
    if (v.subwords.length) lines.push(`      ${v.first}) cands=(${v.subwords.join(' ')}) ;;`);
  }
  lines.push('    esac');
  const appFirstsZsh = VERB_COMPLETIONS.filter(v => v.appPositional).map(v => v.first);
  if (appFirstsZsh.length) {
    lines.push('    case $canon in');
    lines.push(`      ${appFirstsZsh.join('|')})`);
    lines.push('        cands+=(${(f)"$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)"})');
    lines.push('        ;;');
    lines.push('    esac');
  }
  lines.push('    if (( ${#cands} )); then');
  lines.push('      compadd -a cands');
  lines.push('      return');
  lines.push('    fi');
  lines.push('  fi');
  // `env diff <name>` — the one three-deep case worth resolving explicitly.
  lines.push('  if [[ $canon == env && ${words[3]} == diff && CURRENT == 4 ]]; then');
  lines.push('    local -a apps');
  lines.push('    apps=(${(f)"$(daimon --no-spawn list --compact 2>/dev/null | node -e "' + FETCH_APPS_NODE + '" 2>/dev/null)"})');
  lines.push('    compadd -a apps');
  lines.push('    return');
  lines.push('  fi');
  lines.push('  local -a flags');
  lines.push('  case $canon in');
  for (const v of VERB_COMPLETIONS) {
    lines.push(`    ${v.first}) flags=(${verbFlags(v).join(' ')}) ;;`);
  }
  lines.push('  esac');
  lines.push('  flags+=(' + GLOBAL_FLAGS.join(' ') + ')');
  lines.push('  compadd -a flags');
  lines.push('}');
  lines.push('compdef _daimon daimon');
  return lines.join('\n') + '\n';
}

export function completionFish(): string {
  const lines: string[] = ['# daimon fish completion — generated from src/cliSurface.ts. Do not hand-edit;'];
  lines.push('# regenerate with: npm run build && npm run build:completions');
  lines.push('# install: daimon completion fish > ~/.config/fish/completions/daimon.fish');
  lines.push('complete -c daimon -f');
  for (const c of CLI_SUBCOMMANDS) {
    const desc = c.summary.replace(/'/g, "\\'").slice(0, 100);
    lines.push(`complete -c daimon -n "__fish_use_subcommand" -a "${c.name.split(' ')[0]}" -d '${desc}'`);
  }
  for (const a of Object.keys(CLI_ALIASES)) {
    lines.push(`complete -c daimon -n "__fish_use_subcommand" -a "${a}" -d 'alias → ${CLI_ALIASES[a]}'`);
  }
  for (const [first, subwords] of Object.entries(VERB_SUBWORDS)) {
    for (const sw of subwords) {
      lines.push(`complete -c daimon -n "__fish_seen_subcommand_from ${first}" -a "${sw}"`);
    }
  }
  const flagHasArg = new Map<string, boolean>();
  for (const c of CLI_SUBCOMMANDS) {
    for (const o of c.options ?? []) {
      const { flag, hasArg } = normalizeFlag(o);
      flagHasArg.set(flag, flagHasArg.get(flag) || hasArg);
    }
  }
  for (const f of GLOBAL_FLAGS) if (!flagHasArg.has(f)) flagHasArg.set(f, false);
  for (const [flag, hasArg] of flagHasArg) {
    lines.push(`complete -c daimon -l ${flag.replace(/^--/, '')}` + (hasArg ? ' -x' : ''));
  }
  return lines.join('\n') + '\n';
}

function psStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
function psArray(items: string[]): string {
  return '@(' + items.map(psStr).join(',') + ')';
}
function psHashOfArrays(entries: [string, string[]][]): string {
  return '@{ ' + entries.map(([k, v]) => `${psStr(k)} = ${psArray(v)}`).join('; ') + ' }';
}
function psHashOfStrings(entries: [string, string][]): string {
  return '@{ ' + entries.map(([k, v]) => `${psStr(k)} = ${psStr(v)}`).join('; ') + ' }';
}

export function completionPowershell(): string {
  const lines: string[] = [];
  lines.push('# daimon PowerShell completion — generated from src/cliSurface.ts. Do not');
  lines.push('# hand-edit; regenerate with: npm run build && npm run build:completions');
  lines.push('# install: daimon completion powershell | Out-String | Invoke-Expression');
  lines.push('# permanent: add the same line to $PROFILE');
  lines.push('$daimonVerbs = ' + psArray(TOP_LEVEL_WORDS));
  lines.push('$daimonAliases = ' + psHashOfStrings(Object.entries(CLI_ALIASES).map(([a, t]) => [a, t.split(' ')[0]] as [string, string])));
  const subwordEntries = VERB_COMPLETIONS.filter(v => v.subwords.length).map(v => [v.first, v.subwords] as [string, string[]]);
  lines.push('$daimonSubwords = ' + psHashOfArrays(subwordEntries));
  lines.push('$daimonAppVerbs = ' + psArray(VERB_COMPLETIONS.filter(v => v.appPositional).map(v => v.first)));
  const flagEntries = VERB_COMPLETIONS.map(v => [v.first, verbFlags(v)] as [string, string[]]);
  flagEntries.push(['_default', GLOBAL_FLAGS]);
  lines.push('$daimonFlags = ' + psHashOfArrays(flagEntries));
  lines.push('');
  lines.push('Register-ArgumentCompleter -Native -CommandName daimon -ScriptBlock {');
  lines.push('  param($wordToComplete, $commandAst, $cursorPosition)');
  lines.push('  $tokens = $commandAst.CommandElements');
  lines.push('  # Effective position: the partially typed word is itself a CommandElements');
  lines.push('  # token, so with a non-empty $wordToComplete the count overshoots by one');
  lines.push('  # (bash/zsh COMP_CWORD/CURRENT already count this way).');
  lines.push('  $pos = $tokens.Count');
  lines.push('  if ($wordToComplete) { $pos-- }');
  lines.push('  if ($pos -gt 1 -and $tokens[$pos - 1].Value -eq \'--app\') {');
  lines.push('    try {');
  lines.push('      $raw = & daimon --no-spawn list --compact 2>$null');
  lines.push('      $apps = ($raw | ConvertFrom-Json) | ForEach-Object { $_.name }');
  lines.push('      $apps | Where-Object { $_ -like "$wordToComplete*" } |');
  lines.push('        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, \'ParameterValue\', $_) }');
  lines.push('      return');
  lines.push('    } catch {}');
  lines.push('  }');
  lines.push('  if ($pos -le 1) {');
  lines.push('    $daimonVerbs | Where-Object { $_ -like "$wordToComplete*" } |');
  lines.push('      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, \'ParameterValue\', $_) }');
  lines.push('    return');
  lines.push('  }');
  lines.push('  $verb1 = $tokens[1].Value');
  lines.push('  $canon = if ($daimonAliases.ContainsKey($verb1)) { $daimonAliases[$verb1] } else { $verb1 }');
  lines.push('  if ($pos -eq 2) {');
  lines.push('    $cands = @()');
  lines.push('    if ($daimonSubwords.ContainsKey($canon)) { $cands += $daimonSubwords[$canon] }');
  lines.push('    if ($daimonAppVerbs -contains $canon) {');
  lines.push('      try {');
  lines.push('        $raw = & daimon --no-spawn list --compact 2>$null');
  lines.push('        $apps = ($raw | ConvertFrom-Json) | ForEach-Object { $_.name }');
  lines.push('        $cands += $apps');
  lines.push('      } catch {}');
  lines.push('    }');
  lines.push('    if ($cands.Count -gt 0) {');
  lines.push('      $cands | Where-Object { $_ -like "$wordToComplete*" } |');
  lines.push('        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, \'ParameterValue\', $_) }');
  lines.push('      return');
  lines.push('    }');
  lines.push('  }');
  lines.push('  $flags = if ($daimonFlags.ContainsKey($canon)) { $daimonFlags[$canon] } else { $daimonFlags[\'_default\'] }');
  lines.push('  $flags | Where-Object { $_ -like "$wordToComplete*" } |');
  lines.push('    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, \'ParameterName\', $_) }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function emitCompletion(shell: string): { ok: true; script: string } | { ok: false; error: string } {
  switch (shell) {
    case 'bash': return { ok: true, script: completionBash() };
    case 'zsh': return { ok: true, script: completionZsh() };
    case 'fish': return { ok: true, script: completionFish() };
    case 'powershell':
    case 'pwsh':
    case 'ps':
      return { ok: true, script: completionPowershell() };
    default:
      return { ok: false, error: `unknown shell: ${shell}` };
  }
}

export { findSubcommand };
