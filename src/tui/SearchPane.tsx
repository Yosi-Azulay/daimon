import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { Registry } from '../registry.js';
import type { SearchHit } from '../history.js';
import type { SavedSearch } from '../stateFile.js';
import { parseSearchQuery, describeQuery, SEARCH_FIELDS } from '../searchQuery.js';
import { groupErrors, searchErrorGroups } from '../errorGroups.js';
import { makeTheme } from './theme.js';
import { footerChords, resolveChord } from './chords.js';
import {
  clampSel, formatHitRow, savedRows, resultSummary, jumpTargetFor,
  type JumpTarget, type SearchMode,
} from './searchChord.js';

const theme = makeTheme();

interface Props {
  registry: Registry;
  /** Saved searches (M181) — read once on open; the TUI never writes them. */
  saved: SavedSearch[];
  onJump: (target: JumpTarget) => void;
  onExit: () => void;
}

const LIMIT = 100;

// The TUI search pane (M182, v1.16 "Recall").
//
// It runs the SAME query language the CLI and the dashboard run, through the
// SAME parser, and renders the SAME error text — parity is the milestone. It
// searches IN-PROCESS (the TUI shares the daemon's Registry and History), so
// there is no HTTP hop and no second code path; the unified scope is on, which
// is why a hit can be a test run or a folded error group.
//
// Two modes, and no third: you are typing a query, or you are walking results.
// That is why `q` can close the pane from the results list without stealing the
// letter q from anyone typing a query.
export default function SearchPane({ registry, saved, onJump, onExit }: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns || 100;
  const rows = stdout.rows || 30;

  const [mode, setMode] = useState<SearchMode>('input');
  const [query, setQuery] = useState('');
  const [ran, setRan] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [facets, setFacets] = useState<Record<string, number> | undefined>(undefined);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<{ error: string; hint: string } | null>(null);
  const [sel, setSel] = useState(0);

  const savedList = useMemo(() => savedRows(saved, cols - 4), [saved, cols]);
  const showingSaved = mode === 'input' && !query.trim() && saved.length > 0;

  const run = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    const parsed = parseSearchQuery(q);
    if (!parsed.ok) {
      // The daemon's exact message — one grammar, one vocabulary.
      setError({ error: parsed.error, hint: parsed.hint });
      setHits([]);
      setFacets(undefined);
      setRan(q);
      return;
    }
    setError(null);
    const h = registry.getHistory();
    if (!h) {
      setError({ error: 'history is disabled', hint: 'set history.enabled in daimon.config.json to search' });
      setHits([]);
      setRan(q);
      return;
    }
    const r = h.search({ q, query: parsed.query, scope: 'all', limit: LIMIT });
    let all = r.hits;
    // Error groups are folded from the LIVE registry, exactly as the HTTP route
    // composes them — the TUI is in-process, so it does the same composition
    // rather than inventing a second one.
    const kind = parsed.query.kind;
    if (!kind || kind === 'error-groups') {
      try {
        const perApp = registry.list().map(s => ({ app: s.name, errors: registry.errors(s.name) ?? [] }));
        all = all.concat(searchErrorGroups(groupErrors(perApp), parsed.query, LIMIT));
        all.sort((a, b) => b.ts - a.ts);
        all = all.slice(0, LIMIT);
      } catch { /* a fold failure never empties the other kinds */ }
    }
    const counts: Record<string, number> = {};
    for (const x of all) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
    setHits(all);
    setFacets(counts);
    setFallback(r.fallback);
    setRan(q);
    setSel(0);
    setMode('results');
  };

  useInput((input, key) => {
    if (mode === 'input') {
      // The input owns printable keys; only Esc and the two navigation keys
      // are chords here, so typing `q` or `/` can never trip an action.
      if (key.escape) { onExit(); return; }
      if (showingSaved && (key.upArrow || key.downArrow)) {
        setSel(s => clampSel(s + (key.upArrow ? -1 : 1), saved.length));
        return;
      }
      if (key.return) {
        if (query.trim()) { run(query); return; }
        if (showingSaved) {
          const picked = saved[clampSel(sel, saved.length)];
          // Running a saved search is a KEYSTROKE, never a schedule (M181).
          if (picked) { setQuery(picked.query); run(picked.query); }
        }
        return;
      }
      if (key.tab && hits.length) { setMode('results'); return; }
      return;
    }
    // results mode — dispatched through the ONE chord map, scoped to 'search'.
    const chord = resolveChord('search', input, key);
    if (!chord) return;
    if (chord.id === 'seClose') { onExit(); return; }
    if (chord.id === 'seEdit') { setMode('input'); return; }
    if (chord.id === 'seMove') { setSel(s => clampSel(s + (key.upArrow ? -1 : 1), hits.length)); return; }
    if (chord.id === 'seRun') {
      const hit = hits[clampSel(sel, hits.length)];
      if (hit) onJump(jumpTargetFor(hit));
      return;
    }
  });

  // Result window: keep the selection visible without ever painting more rows
  // than the terminal has (the v1.13 windowing rule).
  const listRows = Math.max(3, rows - 10);
  const selIdx = clampSel(sel, showingSaved ? saved.length : hits.length);
  const start = Math.max(0, Math.min(selIdx - Math.floor(listRows / 2), Math.max(0, hits.length - listRows)));
  const windowed = hits.slice(start, start + listRows);

  const parsedEcho = useMemo(() => {
    const p = parseSearchQuery(query);
    return p.ok && (query.trim() ? describeQuery(p.query) : '') || '';
  }, [query]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>search</Text>
        <Text {...theme.style('muted')}>  everything daimon has recorded — events, logs, errors, test runs</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.color('accent')}>{mode === 'input' ? '> ' : '  '}</Text>
        {mode === 'input'
          ? <TextInput value={query} onChange={setQuery} onSubmit={() => run(query)} />
          : <Text>{query}</Text>}
      </Box>
      {mode === 'input' && parsedEcho ? (
        <Text {...theme.style('muted')}>  {parsedEcho}</Text>
      ) : null}

      {error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...theme.style('error')}>{error.error}</Text>
          <Text {...theme.style('muted')}>{error.hint}</Text>
        </Box>
      ) : null}

      {showingSaved ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...theme.style('muted')}>saved searches — ↑/↓ then Enter to run one</Text>
          {savedList.map((row, i) => (
            <Text key={saved[i].name} {...(i === selIdx ? { ...theme.style('selection'), inverse: true } : theme.style('muted'))}>
              {row}
            </Text>
          ))}
        </Box>
      ) : null}

      {!showingSaved && !error && ran ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...theme.style('muted')}>{resultSummary(hits, fallback, facets)}</Text>
          {windowed.map((hit, i) => (
            <Text key={hit.ref + ':' + i} {...(start + i === selIdx ? { ...theme.style('selection'), inverse: true } : {})}>
              {formatHitRow(hit, cols - 2)}
            </Text>
          ))}
          {hits.length > windowed.length ? (
            <Text {...theme.style('muted')}>  ({selIdx + 1}/{hits.length})</Text>
          ) : null}
        </Box>
      ) : null}

      {!ran && !showingSaved ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...theme.style('muted')}>fields: {SEARCH_FIELDS.map(f => f.name + ':').join(' ')}   "quoted phrases"   bare terms</Text>
          <Text {...theme.style('muted')}>example: app:web level:error after:24h "chunk failed"</Text>
        </Box>
      ) : null}

      {/* Footer rendered from the chord map (M163), never hand-listed. The
          input mode shows the subset that is actually live while you type —
          the code and the label agree, which is the v1.13 rule. */}
      <Box marginTop={1}>
        <Text {...theme.style('muted')}>
          {footerChords('search')
            .filter(c => (mode === 'results' ? true : c.id === 'seRun' || c.id === 'seClose' || (c.id === 'seMove' && showingSaved)))
            .map(c => `[${c.key}] ${c.label}`)
            .join('  ')}
        </Text>
      </Box>
    </Box>
  );
}
