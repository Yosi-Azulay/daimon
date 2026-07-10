// daimon VS Code extension — MVP. Status bar reflects current cwd's daimon
// health; errors panel lists cwd-filtered errors; command palette exposes
// Start/Stop/Dashboard/Logs verbs against the local daemon at 127.0.0.1.
// Never edits user source — every action is a loopback HTTP call.

import * as vscode from 'vscode';
import * as http from 'http';

interface AppSummary {
  name: string;
  status: string;
  port: number | null;
  errCount?: number;
  errorCount?: number;
  health?: string;
  serverProfile?: string | null;
}

interface ErrorRow {
  file: string | null;
  line: number | null;
  col: number | null;
  code: string | null;
  message: string;
  app?: string;
  badge?: string;
}

// Framework badge tags (M72), fetched once from GET /api/frameworks and used
// on tree items ("[next] app/page.tsx:3") and code-lens titles.
let FRAMEWORK_BADGES: Record<string, string> = {};
async function loadFrameworkBadges(): Promise<void> {
  try {
    const r = await httpJson('/api/frameworks');
    const map: Record<string, string> = {};
    for (const p of r.body?.profiles ?? []) {
      if (p?.id && p?.badge) map[p.id] = p.badge;
    }
    FRAMEWORK_BADGES = map;
  } catch { /* badge-less rendering is fine */ }
}
function badgeFor(profile: string | null | undefined): string {
  if (!profile) return '';
  return FRAMEWORK_BADGES[profile] ?? profile.slice(0, 5);
}

function cfg() {
  const c = vscode.workspace.getConfiguration('daimon');
  return {
    port: c.get<number>('apiPort', 4999),
    token: c.get<string>('apiToken', ''),
  };
}

function baseUrl(): string {
  return `http://127.0.0.1:${cfg().port}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'x-daimon-cwd': cwd() ?? '' };
  if (cfg().token) h.authorization = `Bearer ${cfg().token}`;
  return h;
}

function cwd(): string | null {
  const f = vscode.workspace.workspaceFolders;
  if (!f || !f.length) return null;
  return f[0].uri.fsPath;
}

function httpJson(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + pathname);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: authHeaders(),
      timeout: 4000,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: any = text;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

class DaimonErrorsProvider implements vscode.TreeDataProvider<ErrorRow> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private rows: ErrorRow[] = [];

  refresh(rows: ErrorRow[]) { this.rows = rows; this._onDidChangeTreeData.fire(); }
  getTreeItem(r: ErrorRow): vscode.TreeItem {
    const prefix = r.badge ? `[${r.badge}] ` : '';
    const label = prefix + (r.file ? `${r.file}:${r.line ?? '?'}` : (r.message || '(no message)'));
    const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    it.description = r.code ? `[${r.code}] ${r.message}` : r.message;
    if (r.file && r.line != null) {
      it.command = {
        title: 'Open',
        command: 'vscode.open',
        arguments: [vscode.Uri.file(r.file), { selection: new vscode.Range(r.line - 1, (r.col ?? 1) - 1, r.line - 1, (r.col ?? 1) - 1) }],
      };
    }
    return it;
  }
  getChildren(): ErrorRow[] { return this.rows; }
}

class DaimonLogCodeActionProvider implements vscode.CodeActionProvider {
  // 5s cache: provideCodeActions fires on every cursor move over a diagnostic.
  private cache = new Map<string, { at: number; apps: AppSummary[] }>();

  async provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): Promise<vscode.CodeAction[]> {
    if (!context.diagnostics.length) return [];
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return [];
    const apps = await this.appsFor(folder.uri.fsPath);
    return apps.map(a => {
      const title = apps.length > 1 ? `Open daimon log for ${a.name}` : 'Open daimon log for this app';
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.command = { title, command: 'daimon.showLogs', arguments: [a.name] };
      action.diagnostics = [...context.diagnostics];
      return action;
    });
  }

  private async appsFor(fsPath: string): Promise<AppSummary[]> {
    const hit = this.cache.get(fsPath);
    if (hit && Date.now() - hit.at < 5000) return hit.apps;
    try {
      const r = await httpJson(`/api/apps?cwd=${encodeURIComponent(fsPath)}`);
      const apps: AppSummary[] = Array.isArray(r.body) ? r.body : [];
      this.cache.set(fsPath, { at: Date.now(), apps });
      return apps;
    } catch {
      return [];
    }
  }
}

// Code-lens over package.json scripts (M72): when the file's folder maps to a
// daimon-discovered app, offer Start/Stop/Dashboard right above "scripts".
class DaimonScriptsCodeLensProvider implements vscode.CodeLensProvider {
  private cache = new Map<string, { at: number; apps: AppSummary[] }>();

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!/package\.json$/.test(doc.uri.fsPath)) return [];
    const scriptsLine = this.findScriptsLine(doc);
    if (scriptsLine < 0) return [];
    const folder = doc.uri.fsPath.replace(/[\\/]package\.json$/, '');
    const apps = await this.appsFor(folder);
    if (!apps.length) return [];
    const range = new vscode.Range(scriptsLine, 0, scriptsLine, 0);
    const lenses: vscode.CodeLens[] = [];
    for (const a of apps) {
      const tag = a.serverProfile ? ` [${badgeFor(a.serverProfile)}]` : '';
      const running = a.status === 'serving' || a.status === 'compiling' || a.status === 'starting';
      if (running) {
        lenses.push(new vscode.CodeLens(range, { title: `■ Stop ${a.name} via daimon${tag}`, command: 'daimon.stopNamed', arguments: [a.name] }));
      } else {
        lenses.push(new vscode.CodeLens(range, { title: `▶ Start ${a.name} via daimon${tag}`, command: 'daimon.startNamed', arguments: [a.name] }));
      }
    }
    lenses.push(new vscode.CodeLens(range, { title: 'Open daimon dashboard', command: 'daimon.openDashboard' }));
    return lenses;
  }

  private findScriptsLine(doc: vscode.TextDocument): number {
    for (let i = 0; i < Math.min(doc.lineCount, 500); i++) {
      if (/^\s*"scripts"\s*:/.test(doc.lineAt(i).text)) return i;
    }
    return -1;
  }

  private async appsFor(folder: string): Promise<AppSummary[]> {
    const hit = this.cache.get(folder);
    if (hit && Date.now() - hit.at < 5000) return hit.apps;
    try {
      const r = await httpJson(`/api/apps?cwd=${encodeURIComponent(folder)}`);
      const apps: AppSummary[] = Array.isArray(r.body) ? r.body : [];
      this.cache.set(folder, { at: Date.now(), apps });
      return apps;
    } catch {
      return [];
    }
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'daimon.openDashboard';
  status.text = '$(sync~spin) daimon…';
  status.tooltip = 'daimon — click to open the dashboard';
  status.show();
  ctx.subscriptions.push(status);

  const errorsProvider = new DaimonErrorsProvider();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider('daimonErrors', errorsProvider));

  ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    [{ language: 'typescript' }, { language: 'typescriptreact' }],
    new DaimonLogCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
  ));

  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(
    { language: 'json', pattern: '**/package.json' },
    new DaimonScriptsCodeLensProvider(),
  ));

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.startNamed', async (name: string) => {
    const c = cwd();
    const r = await httpJson(`/api/apps/${encodeURIComponent(name)}/start${c ? `?cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
    if (r.status === 409 && r.body?.error === 'locked-by-other-agent') {
      const choice = await vscode.window.showWarningMessage(`'${name}' is locked by ${r.body.agent}. Steal?`, 'Steal', 'Cancel');
      if (choice === 'Steal') {
        await httpJson(`/api/apps/${encodeURIComponent(name)}/start?steal=1${c ? `&cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
      }
    }
    void refresh();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.stopNamed', async (name: string) => {
    const c = cwd();
    await httpJson(`/api/apps/${encodeURIComponent(name)}/stop${c ? `?cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
    void refresh();
  }));

  async function refresh(): Promise<void> {
    const c = cwd();
    if (!c) { status.text = '$(circle-slash) daimon: no workspace'; return; }
    try {
      const r = await httpJson(`/api/apps?cwd=${encodeURIComponent(c)}`);
      if (r.status === 0) {
        status.text = '$(error) daimon: daemon down';
        await vscode.commands.executeCommand('setContext', 'daimonAttached', false);
        return;
      }
      const apps: AppSummary[] = Array.isArray(r.body) ? r.body : [];
      const total = apps.length;
      const errCount = apps.reduce((acc, a) => acc + (a.errCount ?? a.errorCount ?? 0), 0);
      const unhealthy = apps.filter(a => a.status === 'error' || a.health === 'unhealthy').length;
      if (total === 0) status.text = '$(circle-slash) daimon: no apps under cwd';
      else if (unhealthy > 0) status.text = `$(warning) daimon: ${unhealthy} unhealthy (${total})`;
      else if (errCount > 0) status.text = `$(warning) daimon: ${errCount} errors (${total} apps)`;
      else status.text = `$(check) daimon: ${total} apps healthy`;
      await vscode.commands.executeCommand('setContext', 'daimonAttached', true);
      // Errors panel: aggregate across all cwd apps.
      const rows: ErrorRow[] = [];
      for (const a of apps) {
        if ((a.errCount ?? a.errorCount ?? 0) === 0) continue;
        const er = await httpJson(`/api/apps/${encodeURIComponent(a.name)}/errors?cwd=${encodeURIComponent(c)}`);
        if (Array.isArray(er.body)) {
          for (const x of er.body) rows.push({
            file: x.file ?? null,
            line: x.line ?? null,
            col: x.col ?? null,
            code: x.code ?? null,
            message: x.message ?? '',
            app: a.name,
            badge: badgeFor(a.serverProfile),
          });
        }
      }
      errorsProvider.refresh(rows);
    } catch (err: any) {
      status.text = '$(error) daimon: ' + (err?.message || 'unreachable');
      await vscode.commands.executeCommand('setContext', 'daimonAttached', false);
    }
  }

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.openDashboard', async () => {
    const c = cwd();
    const url = baseUrl() + (c ? `/?cwd=${encodeURIComponent(c)}` : '/');
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }));

  async function pickApp(): Promise<string | undefined> {
    const c = cwd();
    const r = await httpJson(`/api/apps${c ? `?cwd=${encodeURIComponent(c)}` : ''}`);
    const apps: AppSummary[] = Array.isArray(r.body) ? r.body : [];
    if (!apps.length) { void vscode.window.showInformationMessage('daimon: no apps under cwd'); return undefined; }
    return await vscode.window.showQuickPick(apps.map(a => a.name), { placeHolder: 'Pick a daimon app' });
  }

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.start', async () => {
    const name = await pickApp();
    if (!name) return;
    const c = cwd();
    const r = await httpJson(`/api/apps/${encodeURIComponent(name)}/start${c ? `?cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
    if (r.status === 409 && r.body?.error === 'locked-by-other-agent') {
      const choice = await vscode.window.showWarningMessage(`'${name}' is locked by ${r.body.agent}. Steal?`, 'Steal', 'Cancel');
      if (choice === 'Steal') {
        await httpJson(`/api/apps/${encodeURIComponent(name)}/start?steal=1${c ? `&cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
      }
    }
    void refresh();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.stop', async () => {
    const name = await pickApp();
    if (!name) return;
    const c = cwd();
    await httpJson(`/api/apps/${encodeURIComponent(name)}/stop${c ? `?cwd=${encodeURIComponent(c)}` : ''}`, 'POST');
    void refresh();
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('daimon.showLogs', async (preset?: string) => {
    const name = preset ?? await pickApp();
    if (!name) return;
    const c = cwd();
    const r = await httpJson(`/api/apps/${encodeURIComponent(name)}/logs?tail=200${c ? `&cwd=${encodeURIComponent(c)}` : ''}`);
    const lines: string[] = Array.isArray(r.body?.lines) ? r.body.lines : [];
    const doc = await vscode.workspace.openTextDocument({ language: 'log', content: lines.join('\n') });
    void vscode.window.showTextDocument(doc);
  }));

  // Background refresh every 5s while VS Code is active.
  void loadFrameworkBadges();
  void refresh();
  const timer = setInterval(refresh, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void { /* nothing to clean up — http requests are short-lived */ }
