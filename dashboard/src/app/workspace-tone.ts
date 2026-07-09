// F67 workspace tones — derive a deterministic accent color from a workspace
// label so apps from different workspaces can be visually grouped without a
// config option. Lightness/chroma come from the design tokens (M70), so the
// same call is correct in light and dark themes.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function workspaceTone(label: string | null | undefined): string {
  if (!label) return 'var(--dm-color-surface-2)';
  const hue = hash(label) % 360;
  return `oklch(var(--dm-tone-l) var(--dm-tone-c) ${hue})`;
}

// Framework accent from the registry's per-profile tone hue (M70).
export function frameworkTone(hue: number | null | undefined): string {
  if (hue == null) return 'var(--dm-color-surface-2)';
  return `oklch(var(--dm-tone-badge-l) var(--dm-tone-badge-c) ${hue})`;
}
