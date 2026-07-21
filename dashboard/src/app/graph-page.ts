import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DaimonApi, type GraphNode, type GraphView } from './daimon-api';
import {
  NODE_H, NODE_W,
  arrowTarget, cycleLabel, formatUpPreview, graphSummary, layoutGraph,
  nodeAriaLabel, statusDash, statusGlyph,
  type ArrowKey, type GraphLayout,
} from './graph-page-helpers';

const WS_KEY = 'daimon.workspace';

// Depends-graph page (M174/M176, v1.15 "Atlas"). READ-ONLY visualization of
// the graph the daemon already computes — hand-rolled SVG, no library, no
// mutation: no start/stop/drag, only navigation. Honors the M173 workspace
// switcher; keyboard + aria are first-class (Tab walks nodes in topo order,
// arrows walk edges, Enter opens the app; an offscreen summary describes the
// whole graph for screen readers).
@Component({
  selector: 'dm-graph-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="dm-page-header">
      <div>
        <h1>Graph</h1>
        <div class="dm-page-sub">
          @if (view(); as v) {
            <span>
              {{ v.nodes.length }} app{{ v.nodes.length === 1 ? '' : 's' }} ·
              {{ v.edges.length }} dependenc{{ v.edges.length === 1 ? 'y' : 'ies' }}
              @if (ws()) { · workspace <strong>{{ ws() }}</strong> }
              · read-only
            </span>
          } @else {
            <span>Dependency map of what daimon already knows</span>
          }
        </div>
      </div>
    </div>

    @if (view(); as v) {
      @if (!v.nodes.length) {
        <div class="gp-empty" data-testid="graph-empty">
          <h2>Nothing to map{{ ws() ? ' in workspace "' + ws() + '"' : '' }}</h2>
          @if (ws()) {
            <p>Pick another workspace in the header switcher, or clear the scope to see every app.</p>
          } @else {
            <p>No apps registered yet. Run <code>daimon init --yes</code> from a workspace folder, then <code>daimon daemon start --detach</code>.</p>
          }
        </div>
      } @else {
        <!-- Screen-reader narrative for the whole graph (M174): the SVG is a
             picture; this paragraph is the same information as prose. -->
        <p class="dm-sr-only" id="gp-summary" data-testid="graph-summary">{{ summary() }}</p>

        @for (cyc of v.cycles; track $index) {
          <div class="gp-cycle-banner" role="note" data-testid="graph-cycle-banner">
            <span aria-hidden="true">⟳</span>
            Dependency cycle: <code>{{ cycleText(cyc) }}</code> — these apps cannot be ordered by <code>up</code>.
          </div>
        }

        <div class="gp-scroll">
          <svg
            [attr.width]="layout().width" [attr.height]="layout().height"
            [attr.viewBox]="'0 0 ' + layout().width + ' ' + layout().height"
            role="group" aria-label="Dependency graph" aria-describedby="gp-summary"
            (keydown)="onKeydown($event)" data-testid="graph-svg">
            <defs>
              <marker id="gp-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" class="gp-arrow-head" />
              </marker>
            </defs>

            <!-- Group cluster hulls (M176): background regions, labels attached
                 to members via each node's aria label ("in group day"). -->
            @for (h of layout().hulls; track h.name) {
              <g class="gp-hull" [attr.data-testid]="'graph-hull-' + h.name" aria-hidden="true">
                <rect [attr.x]="h.x" [attr.y]="h.y" [attr.width]="h.w" [attr.height]="h.h" rx="14" />
                <text [attr.x]="h.x + 10" [attr.y]="h.y + 15">{{ h.name }} · {{ h.members.length }}</text>
              </g>
            }

            @for (e of layout().edges; track e.from + '→' + e.to) {
              <path class="gp-edge" [class.gp-edge-cycle]="e.inCycle" [attr.d]="e.d"
                    marker-end="url(#gp-arrow)" aria-hidden="true" />
            }

            @for (ln of layout().nodes; track ln.node.name) {
              <g class="gp-node"
                 [attr.data-status]="ln.node.status"
                 [class.gp-node-cycle]="ln.node.inCycle"
                 [class.gp-node-focused]="focused() === ln.node.name"
                 [attr.transform]="'translate(' + ln.x + ',' + ln.y + ')'"
                 tabindex="0" role="button"
                 [attr.id]="nodeId(ln.node.name)"
                 [attr.aria-label]="aria(ln.node)"
                 [attr.data-testid]="'graph-node-' + ln.node.name"
                 (focus)="focused.set(ln.node.name)"
                 (click)="open(ln.node.name)">
                <rect class="gp-node-box" [attr.width]="W" [attr.height]="H" rx="8"
                      [attr.stroke-dasharray]="dash(ln.node.status) || null" />
                <text class="gp-node-glyph" x="12" y="20" aria-hidden="true">{{ glyph(ln.node.status) }}</text>
                <text class="gp-node-name" x="28" y="20">{{ shortName(ln.node.name) }}</text>
                <text class="gp-node-status" x="12" y="38">
                  {{ ln.node.status }}{{ ln.node.health === 'healthy' ? ' ✓' : '' }}{{ ln.node.inCycle ? ' · cycle ⟳' : '' }}
                </text>
              </g>
            }
          </svg>
        </div>

        <div class="gp-panels">
          @if (selectedNode(); as n) {
            <section class="gp-panel" aria-label="Selected app" data-testid="graph-detail">
              <h2>{{ n.name }}</h2>
              <dl>
                <dt>Status</dt><dd>{{ n.status }} · {{ n.health }}</dd>
                <dt>Workspace</dt><dd>{{ n.workspaceLabel || '—' }}</dd>
                <dt>Depends on</dt><dd>{{ n.dependsOn.length ? n.dependsOn.join(', ') : '—' }}</dd>
                <dt>Depended on by</dt><dd>{{ n.dependedOnBy.length ? n.dependedOnBy.join(', ') : '—' }}</dd>
                <dt>Groups</dt><dd>{{ n.groups.length ? n.groups.join(', ') : '—' }}</dd>
                @if (n.inCycle) {
                  <dt>Cycle</dt>
                  <dd>{{ cycleFor(n.name) }}</dd>
                }
              </dl>
              <a class="gp-open" [routerLink]="['/apps', n.name]" data-testid="graph-open-app">Open app detail</a>
            </section>
          }

          @if (v.groups.length) {
            <section class="gp-panel" aria-label="Groups and start order" data-testid="graph-groups">
              <h2>Groups</h2>
              @for (g of v.groups; track g.name) {
                <div class="gp-group">
                  <div class="gp-group-name"><code>up {{ g.name }}</code></div>
                  <div class="gp-group-preview" [attr.data-testid]="'graph-group-preview-' + g.name">{{ preview(g) }}</div>
                </div>
              }
              <p class="gp-note">Start order is a preview of what <code>daimon up &lt;group&gt;</code> already does — the graph never starts anything.</p>
            </section>
          }
        </div>
      }
    } @else {
      <div class="gp-empty" data-testid="graph-unavailable">
        <h2>Graph unavailable</h2>
        <p>The daemon didn't answer <code>/api/graph</code> — it may predate v1.15. Run <code>daimon daemon restart</code> to hand off to the current version.</p>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .dm-sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    .gp-scroll {
      overflow: auto; max-width: 100%;
      border: 1px solid var(--dm-color-border);
      border-radius: var(--dm-radius-lg);
      background: var(--dm-color-surface);
    }
    svg { display: block; }
    svg:focus { outline: none; }

    .gp-hull rect {
      fill: color-mix(in oklch, var(--dm-color-primary) 7%, transparent);
      stroke: color-mix(in oklch, var(--dm-color-primary) 35%, transparent);
      stroke-width: 1;
    }
    .gp-hull text {
      font: 600 .6875rem/1 Roboto; fill: var(--dm-color-fg-muted);
    }

    .gp-edge {
      fill: none; stroke: var(--dm-color-border-strong); stroke-width: 1.5;
    }
    .gp-edge-cycle { stroke: var(--dm-color-error); stroke-dasharray: 5 4; }
    .gp-arrow-head { fill: var(--dm-color-border-strong); }

    .gp-node { cursor: pointer; }
    .gp-node-box {
      fill: var(--dm-color-surface-2);
      stroke: var(--dm-color-border-strong);
      stroke-width: 1.5;
      transition: stroke var(--dm-motion-short) var(--dm-motion-easing);
    }
    .gp-node[data-status='serving'] .gp-node-box { stroke: var(--dm-color-serving); }
    .gp-node[data-status='compiling'] .gp-node-box,
    .gp-node[data-status='starting'] .gp-node-box { stroke: var(--dm-color-compiling); }
    .gp-node[data-status='error'] .gp-node-box { stroke: var(--dm-color-error); stroke-width: 2; }
    .gp-node[data-status='serving'] .gp-node-glyph { fill: var(--dm-color-serving); }
    .gp-node[data-status='compiling'] .gp-node-glyph,
    .gp-node[data-status='starting'] .gp-node-glyph { fill: var(--dm-color-compiling); }
    .gp-node[data-status='error'] .gp-node-glyph { fill: var(--dm-color-error); }
    .gp-node[data-status='stopped'] .gp-node-glyph { fill: var(--dm-color-fg-muted); }
    .gp-node-cycle .gp-node-box { stroke: var(--dm-color-error); }
    .gp-node:focus .gp-node-box, .gp-node-focused .gp-node-box {
      stroke: var(--dm-color-primary); stroke-width: 3;
    }
    .gp-node-glyph { font: 700 .8125rem/1 Roboto; }
    .gp-node-name {
      font: 600 .8125rem/1 'Roboto Mono', ui-monospace, monospace;
      fill: var(--dm-color-fg);
    }
    .gp-node-status { font: 500 .6875rem/1 Roboto; fill: var(--dm-color-fg-muted); }

    .gp-cycle-banner {
      display: flex; align-items: center; gap: .5rem;
      margin: 0 0 12px; padding: 10px 14px;
      border: 1px solid color-mix(in oklch, var(--dm-color-error) 45%, transparent);
      border-radius: var(--dm-radius-md);
      background: color-mix(in oklch, var(--dm-color-error) 10%, var(--dm-color-surface));
      color: var(--dm-color-fg);
      font: 500 .8125rem/1.25rem Roboto;
    }

    .gp-panels {
      display: grid; gap: 16px; margin-top: 16px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .gp-panel {
      border: 1px solid var(--dm-color-border);
      border-radius: var(--dm-radius-lg);
      background: var(--dm-color-surface);
      padding: 14px 16px;
    }
    .gp-panel h2 { margin: 0 0 8px; font: 600 .9375rem/1.5rem Roboto; color: var(--dm-color-fg); }
    .gp-panel dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
    .gp-panel dt { color: var(--dm-color-fg-muted); font: 500 .75rem/1.25rem Roboto; }
    .gp-panel dd { margin: 0; font: 500 .8125rem/1.25rem 'Roboto Mono', ui-monospace, monospace; color: var(--dm-color-fg); overflow-wrap: anywhere; }
    .gp-open { display: inline-block; margin-top: 10px; color: var(--dm-color-primary); font: 600 .8125rem/1.25rem Roboto; }
    .gp-group { margin-bottom: 10px; }
    .gp-group-name { font: 600 .8125rem/1.25rem Roboto; color: var(--dm-color-fg); }
    .gp-group-preview { font: 500 .75rem/1.25rem 'Roboto Mono', ui-monospace, monospace; color: var(--dm-color-fg-muted); overflow-wrap: anywhere; }
    .gp-note { color: var(--dm-color-fg-muted); font: 400 .75rem/1.25rem Roboto; margin: 8px 0 0; }

    .gp-empty {
      border: 1px dashed var(--dm-color-border-strong);
      border-radius: var(--dm-radius-lg);
      padding: 32px; text-align: center; color: var(--dm-color-fg-muted);
    }
    .gp-empty h2 { color: var(--dm-color-fg); font: 600 1rem/1.5rem Roboto; margin: 0 0 6px; }
    .gp-empty code { color: var(--dm-color-primary); }

    @media (prefers-reduced-motion: reduce) {
      .gp-node-box { transition: none; }
    }
  `],
})
export class GraphPageComponent implements OnInit, OnDestroy {
  readonly api = inject(DaimonApi);
  private readonly router = inject(Router);

  readonly W = NODE_W;
  readonly H = NODE_H;

  readonly view = signal<GraphView | null>(null);
  readonly ws = signal<string | null>(null);
  readonly focused = signal<string | null>(null);
  readonly layout = computed<GraphLayout>(() => {
    const v = this.view();
    return v ? layoutGraph(v) : { nodes: [], edges: [], hulls: [], width: 0, height: 0 };
  });
  readonly summary = computed(() => {
    const v = this.view();
    return v ? graphSummary(v) : '';
  });
  readonly selectedNode = computed<GraphNode | null>(() => {
    const v = this.view();
    const f = this.focused();
    if (!v) return null;
    return v.nodes.find(n => n.name === f) ?? v.nodes[0] ?? null;
  });

  // Recolor without reload (M174 acceptance): api.apps() changes on the
  // existing SSE/poll refresh path; each change re-fetches the graph so a
  // killed app's node updates in place. The fetch is loopback + tiny.
  private readonly recolor = effect(() => {
    this.api.apps();
    untracked(() => void this.reload());
  });

  ngOnInit(): void {
    try { this.ws.set(localStorage.getItem(WS_KEY)); } catch {}
    window.addEventListener('daimon:workspace', this.onWorkspace);
    void this.reload();
  }

  ngOnDestroy(): void {
    window.removeEventListener('daimon:workspace', this.onWorkspace);
  }

  private readonly onWorkspace = (e: Event) => {
    this.ws.set(((e as CustomEvent).detail as string | null) ?? null);
    void this.reload();
  };

  private async reload(): Promise<void> {
    const v = await this.api.getGraph(this.ws());
    this.view.set(v);
  }

  // ── template helpers (pure passthroughs) ──────────────────────────────────
  glyph(s: string): string { return statusGlyph(s); }
  dash(s: string): string { return statusDash(s); }
  aria(n: GraphNode): string { return nodeAriaLabel(n); }
  preview(g: { name: string; apps: string[]; levels: string[][]; cyclic: string[]; unknown: string[] }): string { return formatUpPreview(g); }
  cycleText(cyc: string[]): string { return cycleLabel(cyc); }
  shortName(n: string): string { return n.length > 16 ? n.slice(0, 15) + '…' : n; }
  nodeId(name: string): string {
    const v = this.view();
    const idx = v ? v.nodes.findIndex(n => n.name === name) : -1;
    return 'gp-node-' + idx;
  }
  cycleFor(name: string): string {
    const v = this.view();
    const cyc = v?.cycles.find(c => c.includes(name));
    return cyc ? cycleLabel(cyc) : '';
  }

  open(name: string): void {
    void this.router.navigate(['/apps', name]);
  }

  onKeydown(ev: KeyboardEvent): void {
    const current = this.focused();
    if (!current) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      this.open(current);
      return;
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const target = arrowTarget(this.layout(), current, ev.key as ArrowKey);
      if (target) {
        ev.preventDefault();
        this.focusNode(target);
      }
    }
  }

  private focusNode(name: string): void {
    this.focused.set(name);
    const el = document.getElementById(this.nodeId(name));
    (el as unknown as SVGElement | null)?.focus?.();
  }
}
