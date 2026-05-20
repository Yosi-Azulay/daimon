import { CLI_GROUPS, CLI_SUBCOMMANDS, CLI_ALIASES, findSubcommand, type CliSubcommand } from './cliSurface.js';
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

const VERB_LIST = CLI_SUBCOMMANDS.map(c => c.name).concat(Object.keys(CLI_ALIASES)).sort().join(' ');

export function completionBash(): string {
  return `#!/usr/bin/env bash
# daimon bash completion
# install: source <(daimon completion bash)  (or copy to /etc/bash_completion.d/daimon)
_daimon_complete() {
  local cur prev verbs
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  verbs="${VERB_LIST}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$verbs" -- "$cur") )
    return 0
  fi
  case "$prev" in
    status|stop|restart|start|errors|events|wait|ensure|logs|history|why|tasks|run|snapshot|env|clean|focus|try-fix|pin-health)
      local apps
      apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "try{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s).forEach(a=>console.log(a.name||''))}catch(e){}})}catch(e){}" 2>/dev/null)
      COMPREPLY=( $(compgen -W "$apps" -- "$cur") )
      return 0
      ;;
    --profile|up|down|ensure-up|orchestrate)
      ;;
  esac
  COMPREPLY=( $(compgen -W "--full --compact --stream --explain --tag --workspace --since --until --timeout --tail --app --budget --dry-run --yes --no-color --no-spawn --help" -- "$cur") )
}
complete -F _daimon_complete daimon
`;
}

export function completionZsh(): string {
  return `#compdef daimon
# daimon zsh completion
# install: daimon completion zsh > "\${fpath[1]}/_daimon"  (or source it from .zshrc)
_daimon() {
  local -a verbs
  verbs=(${CLI_SUBCOMMANDS.map(c => `'${c.name}:${c.summary.replace(/'/g, "''").replace(/:/g, '\\:').slice(0, 80)}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' verbs
    return
  fi
  _arguments \\
    '--full[full v0.4 shape]' \\
    '--compact[compact JSON]' \\
    '--stream[NDJSON stream]' \\
    '--explain[wrap with _meta]' \\
    '--tag[tag filter]:tag' \\
    '--workspace[workspace label]:label' \\
    '--since[duration]:duration' \\
    '--until[state]:state' \\
    '--timeout[duration]:duration' \\
    '--tail[lines]:N' \\
    '--app[app]:name' \\
    '--budget[tokens]:N' \\
    '--dry-run[plan only]' \\
    '--yes[skip prompts]' \\
    '--no-color[disable color]' \\
    '--no-spawn[no auto-spawn]' \\
    '--help[help]'
}
compdef _daimon daimon
`;
}

export function completionFish(): string {
  const lines: string[] = ['# daimon fish completion'];
  lines.push('# install: daimon completion fish > ~/.config/fish/completions/daimon.fish');
  lines.push('complete -c daimon -f');
  for (const c of CLI_SUBCOMMANDS) {
    const desc = c.summary.replace(/'/g, "\\'").slice(0, 100);
    lines.push(`complete -c daimon -n "__fish_use_subcommand" -a "${c.name}" -d '${desc}'`);
  }
  for (const a of Object.keys(CLI_ALIASES)) {
    lines.push(`complete -c daimon -n "__fish_use_subcommand" -a "${a}" -d 'alias → ${CLI_ALIASES[a]}'`);
  }
  for (const f of ['--full', '--compact', '--stream', '--explain', '--dry-run', '--yes', '--no-color', '--no-spawn', '--help']) {
    lines.push(`complete -c daimon -l ${f.replace(/^--/, '')}`);
  }
  for (const f of ['tag', 'workspace', 'since', 'until', 'timeout', 'tail', 'app', 'budget']) {
    lines.push(`complete -c daimon -l ${f} -x`);
  }
  return lines.join('\n') + '\n';
}

export function completionPowershell(): string {
  const verbs = VERB_LIST.split(' ').map(v => `'${v}'`).join(',');
  return `# daimon PowerShell completion
# install: daimon completion powershell | Out-String | Invoke-Expression
# permanent: add the same line to $PROFILE
Register-ArgumentCompleter -Native -CommandName daimon -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements
  $verbs = @(${verbs})
  if ($tokens.Count -le 1) {
    $verbs | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $verb = $tokens[1].Value
  $appVerbs = @('status','stop','restart','start','errors','events','wait','ensure','logs','history','why','tasks','run','snapshot','env','clean','focus','try-fix','pin-health')
  if ($appVerbs -contains $verb) {
    try {
      $env:DAIMON_NO_SPAWN = '1'
      $raw = & daimon --no-spawn list --compact 2>$null
      $apps = ($raw | ConvertFrom-Json) | ForEach-Object { $_.name }
      $apps | Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
      return
    } catch {}
  }
  $flags = @('--full','--compact','--stream','--explain','--tag','--workspace','--since','--until','--timeout','--tail','--app','--budget','--dry-run','--yes','--no-color','--no-spawn','--help')
  $flags | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_) }
}
`;
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
