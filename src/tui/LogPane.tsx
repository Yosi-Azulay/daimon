import React, { useMemo, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { Registry } from '../registry.js';
import {
  LEVEL_CHORD_KEY,
  LEVEL_CHORD_HELP,
  GREP_CHORD_KEY,
  GREP_CHORD_HELP,
  type LevelFilter,
  nextLevelFilter,
  formatLevelIndicator,
  filterLogLines,
} from './logFilterChord.js';

interface Props {
  registry: Registry;
  appName: string;
  onExit: () => void;
}

export default function LogPane({ registry, appName, onExit }: Props) {
  const { stdout } = useStdout();
  const [tick, setTick] = useState(0);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [grepOpen, setGrepOpen] = useState(false);
  const [grepQuery, setGrepQuery] = useState('');
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    const onChange = () => setTick(t => t + 1);
    registry.on('change', onChange);
    const i = setInterval(() => setTick(t => t + 1), 500);
    return () => { registry.off('change', onChange); clearInterval(i); };
  }, [registry]);

  const state = registry.getState(appName);
  const allEntries = state?.logBuffer ?? [];
  const rows = (stdout.rows || 30) - 4;

  // Level AND grep, both must pass — recomputed every keystroke/tick so
  // typing narrows the visible lines live (M102).
  const entries = useMemo(
    () => filterLogLines(allEntries, levelFilter, grepQuery),
    [allEntries, levelFilter, grepQuery, tick],
  );
  const lines = entries.map(e => e.line);

  useInput((input, key) => {
    if (grepOpen) {
      // Escape clears the filter and closes the input; any other key (incl.
      // Enter, handled by TextInput's onSubmit below) falls through to it.
      if (key.escape) { setGrepOpen(false); setGrepQuery(''); }
      return;
    }
    if (input === 'q' || key.escape) { onExit(); return; }
    if (input === GREP_CHORD_KEY) { setGrepOpen(true); return; }
    if (input === LEVEL_CHORD_KEY) { setLevelFilter(f => nextLevelFilter(f)); return; }
    if (input === 'g') { setScroll(Math.max(0, lines.length - rows)); return; }
    if (input === 'G') { setScroll(0); return; }
    if (key.pageUp) { setScroll(s => Math.min(Math.max(0, lines.length - rows), s + rows)); return; }
    if (key.pageDown) { setScroll(s => Math.max(0, s - rows)); return; }
    if (key.upArrow) { setScroll(s => Math.min(Math.max(0, lines.length - rows), s + 1)); return; }
    if (key.downArrow) { setScroll(s => Math.max(0, s - 1)); return; }
  });

  // Enter keeps the filter applied and closes the input.
  const submit = () => { setGrepOpen(false); };

  // Clamp against the render's up-to-date filtered length — the level/grep
  // filter can shrink the list out from under a `scroll` set against a
  // longer, unfiltered view.
  const maxScroll = Math.max(0, lines.length - rows);
  const effScroll = Math.min(scroll, maxScroll);
  const sliceEnd = lines.length - effScroll;
  const sliceStart = Math.max(0, sliceEnd - rows);
  const view = lines.slice(sliceStart, sliceEnd);

  const renderLine = (text: string, idx: number) => {
    if (!grepQuery) {
      return <Text key={idx}><Text dimColor>{String(idx + 1).padStart(5)} </Text>{text}</Text>;
    }
    // Best-effort literal highlight — grep may be a regex under the hood, so
    // a match with no literal substring hit just renders unhighlighted.
    const lower = text.toLowerCase();
    const qLower = grepQuery.toLowerCase();
    const segs: React.ReactNode[] = [];
    let i = 0, k = 0;
    while (i < text.length) {
      const at = lower.indexOf(qLower, i);
      if (at < 0) { segs.push(<Text key={k++}>{text.slice(i)}</Text>); break; }
      if (at > i) segs.push(<Text key={k++}>{text.slice(i, at)}</Text>);
      segs.push(<Text key={k++} backgroundColor="yellow" color="black">{text.slice(at, at + grepQuery.length)}</Text>);
      i = at + grepQuery.length;
    }
    return (
      <Text key={idx}>
        <Text dimColor>{String(idx + 1).padStart(5)} </Text>
        {segs}
      </Text>
    );
  };

  const levelIndicator = formatLevelIndicator(levelFilter);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>full log: <Text color="cyan">{appName}</Text></Text>
        {levelIndicator ? <Text color="yellow"> {levelIndicator}</Text> : null}
        <Text dimColor>
          {'  '}({lines.length}{lines.length !== allEntries.length ? `/${allEntries.length}` : ''} lines
          {grepQuery ? `, grep "${grepQuery}"` : ''}, scroll={effScroll})
        </Text>
      </Box>
      <Box flexDirection="column">
        {view.length === 0 ? (
          <Text dimColor>{allEntries.length === 0 ? '(no log yet)' : '(no matching lines)'}</Text>
        ) : view.map((line, i) => renderLine(line, sliceStart + i))}
      </Box>
      <Box>
        {grepOpen ? (
          <Box><Text>/</Text><TextInput value={grepQuery} onChange={setGrepQuery} onSubmit={submit} /></Box>
        ) : (
          <Text dimColor>{GREP_CHORD_HELP}  {LEVEL_CHORD_HELP}  [g/G] bottom/top  [PgUp/PgDn] [↑↓]  [q/Esc] back</Text>
        )}
      </Box>
    </Box>
  );
}
