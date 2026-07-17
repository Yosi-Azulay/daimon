// Pure logic for the app-detail Why panel, exercised without the Angular
// runtime (see dashboard/vite.config.ts).

// `resourceNote` (M109, v1.3 — experimental) is a human-readable sentence
// composed server-side from the resource-leak/cpu-storm detectors; it's
// null (nothing notable) far more often than not. The dashboard renders the
// note only, never the raw `resources` snapshot — this predicate is the one
// place that decision lives, so the template and its tests share it.
export function hasResourceNote(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.trim().length > 0;
}
