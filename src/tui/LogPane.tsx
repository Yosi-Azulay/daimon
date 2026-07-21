import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { LogLevel } from '../frameworks.js';
import {
  type LevelFilter,
  type GrepMode,
  formatLevelIndicator,
  formatFollowIndicator,
  formatStormIndicator,
  formatGrepIndicator,
  compileGrep,
} from './logFilterChord.js';
import { levelRole, type Theme } from './theme.js';
import { footerChords } from './chords.js';

export interface LogEntryLike { line: string; level?: LogLevel | null }

interface Props {
  appName: string | null;
  /** Already level/grep filtered by the caller — this component only paints. */
  entries: LogEntryLike[];
  totalCount: number;
  matchCount: number;
  level: LevelFilter;
  grepQuery: string;
  grepMode: GrepMode;
  grepOpen: boolean;
  onGrepChange: (v: string) => void;
  onGrepSubmit: () => void;
  following: boolean;
  storming: boolean;
  /** Lines scrolled back from the newest line. 0 = at the bottom. */
  scroll: number;
  focused: boolean;
  maximized: boolean;
  rows: number;
  cols: number;
  theme: Theme;
  /** Index (into `entries`) of the current n/N match, highlighted in the gutter. */
  cursorIdx: number | null;
}

// The log pane (v1.13, M164). Presentational: App owns every piece of log state
// and the single useInput that mutates it, so the inline pane and the
// maximized (Shift+L) pane are the same component with the same state — your
// grep, level, and scroll position survive maximizing.
//
// Three things this pane finally says out loud:
//   * LEVEL — v1.2 classified every line; until now the TUI painted them all
//     the same. A line whose level is null stays PLAIN. daimon never guesses a
//     level client-side (the v1.2 fail-soft rule), and neither does this.
//   * FOLLOW — the old pane tailed the log whenever scroll happened to be 0.
//     Now it is named: [following] / [paused].
//   * STORM — v1.2's log-storm detector already knew; the pane never showed it.
export default function LogPane(props: Props) {
  const {
    appName, entries, totalCount, matchCount, level, grepQuery, grepMode, grepOpen,
    onGrepChange, onGrepSubmit, following, storming, scroll, focused, maximized,
    rows, cols, theme, cursorIdx,
  } = props;

  const lineRows = Math.max(1, rows - (grepOpen ? 2 : 1));
  const maxScroll = Math.max(0, entries.length - lineRows);
  const effScroll = Math.min(Math.max(0, scroll), maxScroll);
  const sliceEnd = entries.length - effScroll;
  const sliceStart = Math.max(0, sliceEnd - lineRows);
  const view = entries.slice(sliceStart, sliceEnd);

  const grepMatch = grepQuery ? compileGrep(grepQuery) : null;

  // Highlight grep hits inside a line. Best-effort literal segmentation: grep
  // may be a regex, so a line that matches with no literal substring hit simply
  // renders untinted rather than lying about where the match was.
  const renderText = (text: string, style: React.ComponentProps<typeof Text>) => {
    if (!grepQuery) return <Text {...style}>{text}</Text>;
    const lower = text.toLowerCase();
    const needle = grepQuery.toLowerCase();
    if (!lower.includes(needle)) return <Text {...style}>{text}</Text>;
    const segs: React.ReactNode[] = [];
    let i = 0, k = 0;
    while (i < text.length) {
      const at = lower.indexOf(needle, i);
      if (at < 0) { segs.push(<Text key={k++} {...style}>{text.slice(i)}</Text>); break; }
      if (at > i) segs.push(<Text key={k++} {...style}>{text.slice(i, at)}</Text>);
      segs.push(
        <Text key={k++} backgroundColor={theme.color('warning')} color={theme.level === 'none' ? undefined : 'black'} inverse={theme.level === 'none'}>
          {text.slice(at, at + grepQuery.length)}
        </Text>,
      );
      i = at + grepQuery.length;
    }
    return <>{segs}</>;
  };

  const title = maximized ? 'log (full)' : 'log';
  const borderColor = focused || maximized ? theme.color('focusBorder') : theme.color('blurBorder');
  const levelInd = formatLevelIndicator(level);
  const grepInd = formatGrepIndicator(grepQuery, grepMode, matchCount);
  const stormInd = formatStormIndicator(storming);

  return (
    <Box flexDirection="column" width={cols} borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Box>
        <Text bold color={focused || maximized ? theme.color('primary') : undefined}>
          {focused || maximized ? '▸ ' : '  '}{title}
        </Text>
        {appName ? <Text color={theme.color('accent')}>{' '}{appName}</Text> : null}
        {stormInd ? <Text {...theme.style('storm')}>{'  '}{stormInd}</Text> : null}
        {levelInd ? <Text {...theme.style('warning')}>{'  '}{levelInd}</Text> : null}
        {grepInd ? <Text {...theme.style('accent')}>{'  '}{grepInd}</Text> : null}
        <Text {...theme.style(following ? 'follow' : 'muted')}>{'  '}{formatFollowIndicator(following)}</Text>
        <Text {...theme.style('muted')}>
          {'  '}{entries.length}{entries.length !== totalCount ? `/${totalCount}` : ''} lines
        </Text>
      </Box>

      {view.length === 0 ? (
        <Text {...theme.style('muted')}>
          {totalCount === 0 ? '(no output yet)' : '(no matching lines)'}
        </Text>
      ) : (
        view.map((e, i) => {
          const absIdx = sliceStart + i;
          const role = levelRole(e.level);
          // An unclassified line gets NO role — plain text, never a guess.
          const style = role ? theme.style(role) : {};
          const isCursor = cursorIdx != null && cursorIdx === absIdx;
          const isMatch = grepMatch ? grepMatch(e.line) : false;
          return (
            <Box key={absIdx}>
              <Text {...theme.style(isCursor ? 'accent' : 'muted')}>
                {isCursor ? '▸' : ' '}{String(absIdx + 1).padStart(5)}{isMatch && grepMode === 'highlight' ? '*' : ' '}
              </Text>
              {renderText(e.line, style)}
            </Box>
          );
        })
      )}

      {grepOpen ? (
        <Box>
          <Text color={theme.color('accent')}>/</Text>
          <TextInput value={grepQuery} onChange={onGrepChange} onSubmit={onGrepSubmit} />
          {/* Rendered from the chord map like every other hint — this was a
              hand-written ribbon until the v1.13 review caught that tsc splits
              a JSX literal at its interpolation, hiding it from the drift gate. */}
          <Text {...theme.style('muted')}>
            {'  '}{footerChords('grep').map(c => `[${c.key}] ${c.label}`).join('  ')}
            {'  '}(now: {grepMode})
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
