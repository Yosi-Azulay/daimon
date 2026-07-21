# daimon PowerShell completion — generated from src/cliSurface.ts. Do not
# hand-edit; regenerate with: npm run build && npm run build:completions
# install: daimon completion powershell | Out-String | Invoke-Expression
# permanent: add the same line to $PROFILE
$daimonVerbs = @('agents','audit','ci','claude','clean','completion','config','context','daemon','dashboard','discover','doctor','down','ensure','ensure-up','env','errors','events','export','export-config','focus','frameworks','free-port','handoff','history','init','list','log','logs','ls','mute','orchestrate','overview','pin-health','plugin','plugins','ports','profiles','ps','record','replay','report','restart','run','search','self','sessions','snapshot','start','status','stop','tasks','test','test-history','timeline','top','try-fix','unmute','up','wait','why','why-empty','workspaces')
$daimonAliases = @{ 'ls' = 'list'; 'ps' = 'status'; 'log' = 'logs'; 'profiles' = 'profiles'; 'config' = 'config' }
$daimonSubwords = @{ 'ci' = @('start'); 'claude' = @('install','update','uninstall','status'); 'completion' = @('bash','zsh','fish','powershell'); 'config' = @('validate'); 'daemon' = @('start','stop','status','restart','attach','install-service'); 'env' = @('diff'); 'plugin' = @('list','show','validate'); 'profiles' = @('suggest'); 'workspaces' = @('list','add','rm','show') }
$daimonAppVerbs = @('clean','context','ensure','env','errors','focus','handoff','history','logs','mute','pin-health','restart','run','snapshot','start','status','stop','tasks','test','test-history','try-fix','unmute','wait','why')
$daimonFlags = @{ 'agents' = @('--json','--help','--no-color','--no-spawn'); 'audit' = @('--agent','--app','--since','--limit','--json','--help','--no-color','--no-spawn'); 'ci' = @('--until','--timeout','--json','--help','--no-color','--no-spawn'); 'claude' = @('--help','--no-color','--no-spawn'); 'clean' = @('--deep','--yes','--help','--no-color','--no-spawn'); 'completion' = @('--help','--no-color','--no-spawn'); 'config' = @('--help','--no-color','--no-spawn'); 'context' = @('--budget','--help','--no-color','--no-spawn'); 'daemon' = @('--detach','--headless','--help','--no-color','--no-spawn'); 'dashboard' = @('--help','--no-color','--no-spawn'); 'discover' = @('--help','--no-color','--no-spawn'); 'doctor' = @('--auto-fix','--dry-run','--self','--help','--no-color','--no-spawn'); 'down' = @('--steal','--help','--no-color','--no-spawn'); 'ensure' = @('--until','--timeout','--help','--no-color','--no-spawn'); 'ensure-up' = @('--until','--timeout','--help','--no-color','--no-spawn'); 'env' = @('--from','--to','--use','--help','--no-color','--no-spawn'); 'errors' = @('--group','--since','--since-last','--client','--structured','--full','--compact','--help','--no-color','--no-spawn'); 'events' = @('--since','--app','--stream','--help','--no-color','--no-spawn'); 'export' = @('--since','--app','--format','--out','--help','--no-color','--no-spawn'); 'export-config' = @('--redacted','--help','--no-color','--no-spawn'); 'focus' = @('--until','--timeout','--help','--no-color','--no-spawn'); 'frameworks' = @('--help','--no-color','--no-spawn'); 'free-port' = @('--force','--help','--no-color','--no-spawn'); 'handoff' = @('--help','--no-color','--no-spawn'); 'history' = @('--help','--no-color','--no-spawn'); 'init' = @('--yes','--force','--auto','--help','--no-color','--no-spawn'); 'list' = @('--tag','--workspace','--group','--full','--compact','--stream','--explain','--help','--no-color','--no-spawn'); 'logs' = @('--tail','--since','--level','--grep','--stream','--group','--help','--no-color','--no-spawn'); 'mute' = @('--for','--help','--no-color','--no-spawn'); 'orchestrate' = @('--goal','--timeout','--dry-run','--budget','--help','--no-color','--no-spawn'); 'overview' = @('--workspace','--profile','--budget','--help','--no-color','--no-spawn'); 'pin-health' = @('--accept','--path','--help','--no-color','--no-spawn'); 'plugin' = @('--help','--no-color','--no-spawn'); 'plugins' = @('--json','--help','--no-color','--no-spawn'); 'ports' = @('--help','--no-color','--no-spawn'); 'profiles' = @('--help','--no-color','--no-spawn'); 'record' = @('--help','--no-color','--no-spawn'); 'replay' = @('--speed','--help','--no-color','--no-spawn'); 'report' = @('--since','--app','--workspace','--group','--md','--help','--no-color','--no-spawn'); 'restart' = @('--steal','--help','--no-color','--no-spawn'); 'run' = @('--watch','--help','--no-color','--no-spawn'); 'search' = @('--app','--since','--kind','--limit','--help','--no-color','--no-spawn'); 'self' = @('--help','--no-color','--no-spawn'); 'sessions' = @('--since','--json','--help','--no-color','--no-spawn'); 'snapshot' = @('--help','--no-color','--no-spawn'); 'start' = @('--with-deps','--steal','--help','--no-color','--no-spawn'); 'status' = @('--full','--compact','--group','--help','--no-color','--no-spawn'); 'stop' = @('--steal','--help','--no-color','--no-spawn'); 'tasks' = @('--help','--no-color','--no-spawn'); 'test' = @('--failed','--timeout','--steal','--json','--help','--no-color','--no-spawn'); 'test-history' = @('--flaky','--limit','--help','--no-color','--no-spawn'); 'timeline' = @('--help','--no-color','--no-spawn'); 'top' = @('--json','--help','--no-color','--no-spawn'); 'try-fix' = @('--until','--timeout','--help','--no-color','--no-spawn'); 'unmute' = @('--help','--no-color','--no-spawn'); 'up' = @('--until','--timeout','--steal','--help','--no-color','--no-spawn'); 'wait' = @('--until','--timeout','--help','--no-color','--no-spawn'); 'why' = @('--help','--no-color','--no-spawn'); 'why-empty' = @('--help','--no-color','--no-spawn'); 'workspaces' = @('--help','--no-color','--no-spawn'); '_default' = @('--help','--no-color','--no-spawn') }

Register-ArgumentCompleter -Native -CommandName daimon -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements
  # Effective position: the partially typed word is itself a CommandElements
  # token, so with a non-empty $wordToComplete the count overshoots by one
  # (bash/zsh COMP_CWORD/CURRENT already count this way).
  $pos = $tokens.Count
  if ($wordToComplete) { $pos-- }
  if ($pos -gt 1 -and $tokens[$pos - 1].Value -eq '--app') {
    try {
      $raw = & daimon --no-spawn list --compact 2>$null
      $apps = ($raw | ConvertFrom-Json) | ForEach-Object { $_.name }
      $apps | Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
      return
    } catch {}
  }
  if ($pos -le 1) {
    $daimonVerbs | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    return
  }
  $verb1 = $tokens[1].Value
  $canon = if ($daimonAliases.ContainsKey($verb1)) { $daimonAliases[$verb1] } else { $verb1 }
  if ($pos -eq 2) {
    $cands = @()
    if ($daimonSubwords.ContainsKey($canon)) { $cands += $daimonSubwords[$canon] }
    if ($daimonAppVerbs -contains $canon) {
      try {
        $raw = & daimon --no-spawn list --compact 2>$null
        $apps = ($raw | ConvertFrom-Json) | ForEach-Object { $_.name }
        $cands += $apps
      } catch {}
    }
    if ($cands.Count -gt 0) {
      $cands | Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
      return
    }
  }
  $flags = if ($daimonFlags.ContainsKey($canon)) { $daimonFlags[$canon] } else { $daimonFlags['_default'] }
  $flags | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_) }
}
