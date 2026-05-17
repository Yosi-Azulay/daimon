import type { Registry } from './registry.js';

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

const STATUSES = ['stopped', 'starting', 'compiling', 'serving', 'error'] as const;

export function exportMetrics(registry: Registry): string {
  const lines: string[] = [];
  lines.push('# HELP bosun_up bosun daemon up');
  lines.push('# TYPE bosun_up gauge');
  lines.push('bosun_up 1');

  lines.push('# HELP bosun_app_status app status one-hot');
  lines.push('# TYPE bosun_app_status gauge');
  const summaries = registry.list();
  for (const s of summaries) {
    for (const st of STATUSES) {
      lines.push(`bosun_app_status{name="${escapeLabel(s.name)}",status="${st}"} ${s.status === st ? 1 : 0}`);
    }
  }

  lines.push('# HELP bosun_compile_seconds last successful compile duration in seconds');
  lines.push('# TYPE bosun_compile_seconds gauge');
  for (const s of summaries) {
    if (s.lastCompileMs != null) {
      lines.push(`bosun_compile_seconds{name="${escapeLabel(s.name)}"} ${(s.lastCompileMs / 1000).toFixed(3)}`);
    }
  }

  lines.push('# HELP bosun_error_total cumulative deduped error count');
  lines.push('# TYPE bosun_error_total counter');
  for (const s of summaries) {
    lines.push(`bosun_error_total{name="${escapeLabel(s.name)}"} ${s.errorCount}`);
  }

  lines.push('# HELP bosun_cpu_percent app CPU percent');
  lines.push('# TYPE bosun_cpu_percent gauge');
  for (const s of summaries) {
    if (s.cpu != null) lines.push(`bosun_cpu_percent{name="${escapeLabel(s.name)}"} ${s.cpu}`);
  }

  lines.push('# HELP bosun_mem_mb app resident memory MB');
  lines.push('# TYPE bosun_mem_mb gauge');
  for (const s of summaries) {
    if (s.memMB != null) lines.push(`bosun_mem_mb{name="${escapeLabel(s.name)}"} ${s.memMB}`);
  }

  return lines.join('\n') + '\n';
}
