#!/usr/bin/env bash
# daimon bash completion — generated from src/cliSurface.ts. Do not hand-edit;
# regenerate with: npm run build && npm run build:completions
# install: source <(daimon completion bash)  (or copy to /etc/bash_completion.d/daimon)
_daimon_complete() {
  local cur cword canon prev apps flags sub
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  cword=$COMP_CWORD
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$prev" = "--app" ]; then
    apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "try{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s).forEach(a=>console.log(a.name||''))}catch(e){}})}catch(e){}" 2>/dev/null)
    COMPREPLY=( $(compgen -W "$apps" -- "$cur") )
    return 0
  fi
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "agents audit ci claude clean completion config context daemon dashboard discover doctor down ensure ensure-up env errors events export export-config focus frameworks free-port graph handoff history init list log logs ls mute orchestrate overview pin-health plugin plugins ports profiles ps record replay report restart run search searches self sessions snapshot start status stop tasks test test-history timeline top try-fix unmute up wait why why-empty workspaces" -- "$cur") )
    return 0
  fi
  canon="${COMP_WORDS[1]}"
  case "$canon" in
    ls) canon="list" ;;
    ps) canon="status" ;;
    log) canon="logs" ;;
    profiles) canon="profiles" ;;
    config) canon="config" ;;
  esac
  if [ "$cword" -eq 2 ]; then
    sub=""
    case "$canon" in
      ci) sub="start" ;;
      claude) sub="install update uninstall status" ;;
      completion) sub="bash zsh fish powershell" ;;
      config) sub="validate" ;;
      daemon) sub="start stop status restart attach install-service" ;;
      env) sub="diff" ;;
      plugin) sub="list show validate" ;;
      profiles) sub="suggest" ;;
      searches) sub="list save rename delete" ;;
      workspaces) sub="list add rm show" ;;
    esac
    case "$canon" in
      clean|context|ensure|env|errors|focus|handoff|history|logs|mute|pin-health|restart|run|snapshot|start|status|stop|tasks|test|test-history|try-fix|unmute|wait|why)
        apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "try{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s).forEach(a=>console.log(a.name||''))}catch(e){}})}catch(e){}" 2>/dev/null)
        COMPREPLY=( $(compgen -W "$apps $sub" -- "$cur") )
        return 0
        ;;
    esac
    if [ -n "$sub" ]; then
      COMPREPLY=( $(compgen -W "$sub" -- "$cur") )
      return 0
    fi
  fi
  if [ "$cword" -eq 3 ] && [ "$canon" = "env" ] && [ "${COMP_WORDS[2]}" = "diff" ]; then
    apps=$(daimon --no-spawn list --compact 2>/dev/null | node -e "try{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{JSON.parse(s).forEach(a=>console.log(a.name||''))}catch(e){}})}catch(e){}" 2>/dev/null)
    COMPREPLY=( $(compgen -W "$apps" -- "$cur") )
    return 0
  fi
  flags="--help --no-color --no-spawn"
  case "$canon" in
    agents) flags="--json --help --no-color --no-spawn" ;;
    audit) flags="--agent --app --since --limit --json --help --no-color --no-spawn" ;;
    ci) flags="--until --timeout --json --help --no-color --no-spawn" ;;
    claude) flags="--help --no-color --no-spawn" ;;
    clean) flags="--deep --yes --help --no-color --no-spawn" ;;
    completion) flags="--help --no-color --no-spawn" ;;
    config) flags="--help --no-color --no-spawn" ;;
    context) flags="--budget --help --no-color --no-spawn" ;;
    daemon) flags="--detach --headless --help --no-color --no-spawn" ;;
    dashboard) flags="--help --no-color --no-spawn" ;;
    discover) flags="--help --no-color --no-spawn" ;;
    doctor) flags="--auto-fix --dry-run --self --help --no-color --no-spawn" ;;
    down) flags="--steal --help --no-color --no-spawn" ;;
    ensure) flags="--until --timeout --help --no-color --no-spawn" ;;
    ensure-up) flags="--until --timeout --help --no-color --no-spawn" ;;
    env) flags="--from --to --use --help --no-color --no-spawn" ;;
    errors) flags="--group --workspace --since --since-last --client --structured --full --compact --help --no-color --no-spawn" ;;
    events) flags="--since --app --stream --help --no-color --no-spawn" ;;
    export) flags="--since --app --format --out --help --no-color --no-spawn" ;;
    export-config) flags="--redacted --help --no-color --no-spawn" ;;
    focus) flags="--until --timeout --help --no-color --no-spawn" ;;
    frameworks) flags="--help --no-color --no-spawn" ;;
    free-port) flags="--force --help --no-color --no-spawn" ;;
    graph) flags="--json --workspace --all --help --no-color --no-spawn" ;;
    handoff) flags="--help --no-color --no-spawn" ;;
    history) flags="--help --no-color --no-spawn" ;;
    init) flags="--yes --force --auto --help --no-color --no-spawn" ;;
    list) flags="--tag --workspace --group --full --compact --stream --explain --help --no-color --no-spawn" ;;
    logs) flags="--tail --since --level --grep --stream --group --help --no-color --no-spawn" ;;
    mute) flags="--for --help --no-color --no-spawn" ;;
    orchestrate) flags="--goal --timeout --dry-run --budget --help --no-color --no-spawn" ;;
    overview) flags="--workspace --profile --budget --help --no-color --no-spawn" ;;
    pin-health) flags="--accept --path --help --no-color --no-spawn" ;;
    plugin) flags="--help --no-color --no-spawn" ;;
    plugins) flags="--json --help --no-color --no-spawn" ;;
    ports) flags="--help --no-color --no-spawn" ;;
    profiles) flags="--help --no-color --no-spawn" ;;
    record) flags="--help --no-color --no-spawn" ;;
    replay) flags="--speed --help --no-color --no-spawn" ;;
    report) flags="--since --app --workspace --group --md --help --no-color --no-spawn" ;;
    restart) flags="--steal --help --no-color --no-spawn" ;;
    run) flags="--watch --help --no-color --no-spawn" ;;
    search) flags="--all --app --workspace --since --kind --limit --help --no-color --no-spawn" ;;
    searches) flags="--force --json --help --no-color --no-spawn" ;;
    self) flags="--help --no-color --no-spawn" ;;
    sessions) flags="--since --json --help --no-color --no-spawn" ;;
    snapshot) flags="--help --no-color --no-spawn" ;;
    start) flags="--with-deps --steal --help --no-color --no-spawn" ;;
    status) flags="--full --compact --group --help --no-color --no-spawn" ;;
    stop) flags="--steal --help --no-color --no-spawn" ;;
    tasks) flags="--help --no-color --no-spawn" ;;
    test) flags="--failed --timeout --steal --json --help --no-color --no-spawn" ;;
    test-history) flags="--flaky --limit --help --no-color --no-spawn" ;;
    timeline) flags="--help --no-color --no-spawn" ;;
    top) flags="--json --help --no-color --no-spawn" ;;
    try-fix) flags="--until --timeout --help --no-color --no-spawn" ;;
    unmute) flags="--help --no-color --no-spawn" ;;
    up) flags="--until --timeout --steal --dry-run --help --no-color --no-spawn" ;;
    wait) flags="--until --timeout --help --no-color --no-spawn" ;;
    why) flags="--help --no-color --no-spawn" ;;
    why-empty) flags="--help --no-color --no-spawn" ;;
    workspaces) flags="--help --no-color --no-spawn" ;;
  esac
  COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
}
complete -F _daimon_complete daimon
