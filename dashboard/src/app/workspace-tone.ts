// F67 workspace tones — derive a deterministic Material-3 surface tonal
// color from a workspace label string so apps from different workspaces
// can be visually grouped on the dashboard without a config option.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function workspaceTone(label: string | null | undefined): string {
  if (!label) return 'var(--mat-sys-surface-container)';
  const hue = hash(label) % 360;
  return `oklch(0.94 0.05 ${hue})`;
}

export function workspaceToneDark(label: string | null | undefined): string {
  if (!label) return 'var(--mat-sys-surface-container)';
  const hue = hash(label) % 360;
  return `oklch(0.30 0.06 ${hue})`;
}
