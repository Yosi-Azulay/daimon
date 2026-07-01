// Guards for values that get interpolated into commands run with `shell: true`
// (appProcess, taskRunner). daimon spawns dev servers and tasks through a shell
// for cross-platform `npx`/`.cmd` resolution, so any untrusted token — a
// project name read from a cloned repo's project.json/angular.json, or a task
// name / arg arriving from the CLI or HTTP API — must be rejected before it can
// smuggle in shell metacharacters (`; & | $() \`\` < >` …) and run as a command.
//
// These are allow-lists, not escape functions: cross-shell quoting (cmd.exe vs
// /bin/sh) is unreliable, so we refuse anything outside the safe character set
// rather than try to neutralise it.

// Project / app names: letters, digits, and the separators real Nx/Angular/Vite
// project names actually use (`@scope/name`, `my-app`, `pkg.sub`). No spaces —
// a real serve target name never contains one, and a space would break the
// command's argument boundaries anyway.
const APP_NAME_RX = /^[A-Za-z0-9@._/-]+$/;

// Task / target names: `build`, `test`, `e2e`, and Nx's `project:target` form.
const TASK_NAME_RX = /^[A-Za-z0-9:._-]+$/;

// Shell metacharacters that must never appear in a task argument.
const SHELL_META_RX = /[;&|`$(){}<>\n\r\\"'*?~!#\t]/;

export function isSafeAppName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 214 && APP_NAME_RX.test(name);
}

export function isSafeTaskName(task: string): boolean {
  return typeof task === 'string' && task.length > 0 && task.length <= 214 && TASK_NAME_RX.test(task);
}

export function isSafeTaskArg(arg: string): boolean {
  return typeof arg === 'string' && arg.length <= 4096 && !SHELL_META_RX.test(arg);
}

// Throws a descriptive Error if any token is unsafe. Callers spawn only after
// this passes, so an injection attempt fails loudly instead of executing.
export function assertSafeCommandParts(name: string, task?: string, args: string[] = []): void {
  if (!isSafeAppName(name)) {
    throw new Error(`unsafe app name for shell command: ${JSON.stringify(name)}`);
  }
  if (task !== undefined && !isSafeTaskName(task)) {
    throw new Error(`unsafe task name for shell command: ${JSON.stringify(task)}`);
  }
  for (const a of args) {
    if (!isSafeTaskArg(a)) {
      throw new Error(`unsafe task argument for shell command: ${JSON.stringify(a)}`);
    }
  }
}
