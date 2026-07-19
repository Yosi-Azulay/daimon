import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Registry } from '../registry.js';
import {
  bucketize, findStateChange, bucketIndexForTs, clampIndex, densityGlyph,
  type Granularity, type TimelineEvent,
} from './timelineChord.js';

interface Props {
  registry: Registry;
  appName: string | null;
  onExit: () => void;
}

// One windowed query on open (never a full-table scan per keystroke); every
// navigation re-buckets these rows in memory. 30d is plenty for "when did this
// last happen" without unbounded reads.
const WINDOW_MS = 30 * 86_400_000;

function relLabel(start: number, g: Granularity): string {
  const d = new Date(start);
  const iso = d.toISOString();
  return g === 'day' ? iso.slice(0, 10) : iso.slice(0, 13).replace('T', ' ') + ':00';
}

export default function TimelinePane({ registry, appName, onExit }: Props) {
  const { stdout } = useStdout();

  const events = useMemo<TimelineEvent[]>(() => {
    const h = registry.getHistory();
    if (!h) return [];
    return h.queryEvents({ since: Date.now() - WINDOW_MS, limit: 20000 })
      .map(r => ({ ts: r.ts, app: r.app, type: r.type, to_state: r.to_state }))
      .filter(e => e.app !== '__daemon__');
  }, [registry]);

  const [granularity, setGranularity] = useState<Granularity>('day');
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [sel, setSel] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const buckets = useMemo(() => bucketize(events, granularity, range ?? undefined), [events, granularity, range]);
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const selIdx = clampIndex(sel, buckets.length);
  const selBucket = selIdx >= 0 ? buckets[selIdx] : null;

  const bucketEvents = useMemo(() => {
    if (!selBucket) return [];
    return events.filter(e => e.ts >= selBucket.start && e.ts < selBucket.end).sort((a, b) => a.ts - b.ts);
  }, [events, selBucket]);

  const jump = (dir: 1 | -1) => {
    if (!appName) { setHint('select an app first (↑/↓ in the list) to jump its state changes'); return; }
    const cursor = selBucket ? (dir === 1 ? selBucket.end : selBucket.start) : Date.now();
    const ts = findStateChange(events, appName, cursor, dir);
    if (ts == null) { setHint(`no ${dir === 1 ? 'later' : 'earlier'} start/stop/crash for ${appName}`); return; }
    const idx = bucketIndexForTs(buckets, ts);
    if (idx >= 0) { setSel(idx); setHint(`${appName}: ${dir === 1 ? 'next' : 'prev'} state change`); }
  };

  useInput((input, key) => {
    setHint(null);
    if (input === 'q' || key.escape) {
      if (granularity === 'hour') { setGranularity('day'); setRange(null); setSel(0); return; }
      onExit();
      return;
    }
    if (!buckets.length) return;
    if (key.leftArrow || input === 'h' || key.upArrow || input === 'k') { setSel(i => clampIndex(i - 1, buckets.length)); return; }
    if (key.rightArrow || input === 'l' || key.downArrow || input === 'j') { setSel(i => clampIndex(i + 1, buckets.length)); return; }
    if (input === 'g') { setSel(0); return; }                      // Home: oldest
    if (input === 'G') { setSel(buckets.length - 1); return; }      // End: newest
    if (key.return) {
      if (granularity === 'day' && selBucket) {
        setRange({ from: selBucket.start, to: selBucket.end });
        setGranularity('hour');
        setSel(0);
      }
      return;
    }
    if (input === 'n') { jump(1); return; }
    if (input === 'p') { jump(-1); return; }
  });

  const cols = stdout.columns || 100;
  const strip = buckets.map((b, i) => (
    <Text key={b.start} color={i === selIdx ? 'cyan' : undefined} inverse={i === selIdx}>
      {densityGlyph(b.count, maxCount)}
    </Text>
  ));

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>timeline</Text>
        <Text dimColor>  {granularity === 'day' ? 'by day' : 'by hour'}{range ? ` · ${relLabel(range.from, 'day')}` : ''}{appName ? ` · app ${appName}` : ''}  ({events.length} events / 30d)</Text>
      </Box>

      {buckets.length === 0 ? (
        <Text dimColor>(no history in the last 30 days — nothing to walk yet)</Text>
      ) : (
        <>
          <Box flexWrap="wrap"><Text dimColor>oldest </Text>{strip}<Text dimColor> newest</Text></Box>
          {selBucket ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                <Text color="cyan">{relLabel(selBucket.start, granularity)}</Text>
                <Text dimColor>  {selBucket.count} event{selBucket.count === 1 ? '' : 's'}  ({selIdx + 1}/{buckets.length})</Text>
              </Text>
              {bucketEvents.slice(0, 12).map((e, i) => (
                <Text key={i} dimColor>
                  {new Date(e.ts).toISOString().slice(11, 19)}  {e.app.padEnd(16).slice(0, 16)}  {e.type}{e.to_state ? ` → ${e.to_state}` : ''}
                </Text>
              ))}
              {bucketEvents.length > 12 ? <Text dimColor>  … +{bucketEvents.length - 12} more</Text> : null}
            </Box>
          ) : null}
        </>
      )}

      <Box marginTop={1}>
        {hint ? <Text color="yellow">{hint}</Text> : (
          <Text dimColor>[←/→] bucket  [g/G] oldest/newest  {granularity === 'day' ? '[Enter] drill to hours  ' : '[Esc] back to days  '}[n/p] app state change  [q] exit</Text>
        )}
      </Box>
    </Box>
  );
}
