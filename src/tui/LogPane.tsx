import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { Registry } from '../registry.js';

interface Props {
  registry: Registry;
  appName: string;
  onExit: () => void;
}

export default function LogPane({ registry, appName, onExit }: Props) {
  const { stdout } = useStdout();
  const [tick, setTick] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [scroll, setScroll] = useState(0);
  const [matchIdx, setMatchIdx] = useState(0);

  useEffect(() => {
    const onChange = () => setTick(t => t + 1);
    registry.on('change', onChange);
    const i = setInterval(() => setTick(t => t + 1), 500);
    return () => { registry.off('change', onChange); clearInterval(i); };
  }, [registry]);

  const state = registry.getState(appName);
  const lines = state?.logBuffer.map(e => e.line) ?? [];
  const rows = (stdout.rows || 30) - 4;

  const matches = useMemo(() => {
    if (!activeQuery) return [] as number[];
    const q = activeQuery.toLowerCase();
    return lines.reduce<number[]>((acc, l, i) => { if (l.toLowerCase().includes(q)) acc.push(i); return acc; }, []);
  }, [lines, activeQuery, tick]);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) { setSearching(false); setQuery(''); return; }
      return;
    }
    if (input === 'q' || key.escape) { onExit(); return; }
    if (input === '/') { setSearching(true); return; }
    if (input === 'g') { setScroll(Math.max(0, lines.length - rows)); return; }
    if (input === 'G') { setScroll(0); return; }
    if (key.pageUp) { setScroll(s => Math.min(Math.max(0, lines.length - rows), s + rows)); return; }
    if (key.pageDown) { setScroll(s => Math.max(0, s - rows)); return; }
    if (key.upArrow) { setScroll(s => Math.min(Math.max(0, lines.length - rows), s + 1)); return; }
    if (key.downArrow) { setScroll(s => Math.max(0, s - 1)); return; }
    if ((input === 'n' || input === 'N') && matches.length) {
      const next = input === 'n' ? (matchIdx + 1) % matches.length : (matchIdx - 1 + matches.length) % matches.length;
      setMatchIdx(next);
      const lineIdx = matches[next];
      const viewportEnd = lines.length - scroll;
      const viewportStart = viewportEnd - rows;
      if (lineIdx < viewportStart || lineIdx >= viewportEnd) {
        setScroll(Math.max(0, lines.length - lineIdx - Math.floor(rows / 2)));
      }
      return;
    }
  });

  const submit = (v: string) => {
    setActiveQuery(v);
    setSearching(false);
    setQuery('');
    setMatchIdx(0);
  };

  const sliceEnd = lines.length - scroll;
  const sliceStart = Math.max(0, sliceEnd - rows);
  const view = lines.slice(sliceStart, sliceEnd);

  const renderLine = (text: string, absoluteIdx: number) => {
    if (!activeQuery) {
      return <Text key={absoluteIdx}><Text dimColor>{String(absoluteIdx + 1).padStart(5)} </Text>{text}</Text>;
    }
    const q = activeQuery;
    const lower = text.toLowerCase();
    const qLower = q.toLowerCase();
    const segs: React.ReactNode[] = [];
    let i = 0, k = 0;
    while (i < text.length) {
      const at = lower.indexOf(qLower, i);
      if (at < 0) { segs.push(<Text key={k++}>{text.slice(i)}</Text>); break; }
      if (at > i) segs.push(<Text key={k++}>{text.slice(i, at)}</Text>);
      segs.push(<Text key={k++} backgroundColor="yellow" color="black">{text.slice(at, at + q.length)}</Text>);
      i = at + q.length;
    }
    const isCurrent = matches[matchIdx] === absoluteIdx;
    return (
      <Text key={absoluteIdx}>
        <Text color={isCurrent ? 'cyan' : undefined} dimColor={!isCurrent}>{String(absoluteIdx + 1).padStart(5)} </Text>
        {segs}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>full log: <Text color="cyan">{appName}</Text></Text>
        <Text dimColor>  ({lines.length} lines{activeQuery ? `, ${matches.length} matches for "${activeQuery}"` : ''}, scroll={scroll})</Text>
      </Box>
      <Box flexDirection="column">
        {view.length === 0 ? <Text dimColor>(no log yet)</Text> : view.map((line, i) => renderLine(line, sliceStart + i))}
      </Box>
      <Box>
        {searching ? (
          <Box><Text>/</Text><TextInput value={query} onChange={setQuery} onSubmit={submit} /></Box>
        ) : (
          <Text dimColor>[/] search  [n/N] next/prev  [g/G] bottom/top  [PgUp/PgDn] [↑↓]  [q/Esc] back</Text>
        )}
      </Box>
    </Box>
  );
}
