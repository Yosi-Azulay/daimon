import React from 'react';
import { Box, Text } from 'ink';
import { CHORDS, overlayGroups, type Pane } from './chords.js';
import type { Theme } from './theme.js';

interface Props {
  pane: Pane;
  theme: Theme;
  cols: number;
  rows: number;
  scroll: number;
}

// The `?` help overlay (v1.13, M163). Every row is rendered from the chord map
// — nothing here hand-lists a key or a description, which is what lets
// test/tui-chords.test.mjs prove the overlay can never drift from dispatch.
//
// The focused pane's own groups sort first (overlayGroups does that), so the
// answer to "what can I press right now" is the first thing on screen. Input
// (scrolling, dismissal) is handled by App's single useInput — this component
// is presentational so it stays cheap to re-render and easy to reason about.
export default function HelpOverlay({ pane, theme, cols, rows, scroll }: Props) {
  const groups = overlayGroups(pane);

  // Flatten to lines first so scrolling is uniform across group boundaries and
  // the overlay behaves the same at 80 columns as at 200.
  type Line = { kind: 'title'; text: string } | { kind: 'chord'; key: string; desc: string; panes: string };
  const lines: Line[] = [];
  for (const g of groups) {
    lines.push({ kind: 'title', text: g.title });
    for (const c of g.chords) {
      lines.push({
        kind: 'chord',
        key: c.key,
        desc: c.desc,
        // Naming the panes is the whole point of a pane-scoped chord map: it is
        // how `l` reads as two different chords without looking like a bug.
        panes: c.panes.join(', '),
      });
    }
  }

  const viewport = Math.max(3, rows - 4);
  const maxScroll = Math.max(0, lines.length - viewport);
  const start = Math.max(0, Math.min(scroll, maxScroll));
  const view = lines.slice(start, start + viewport);

  // Column widths adapt so an 80-column terminal still lines up. The pane
  // column is the first to go.
  const keyW = 14;
  const showPanes = cols >= 88;
  const descW = Math.max(10, cols - keyW - (showPanes ? 22 : 0) - 6);

  return (
    <Box flexDirection="column" width={cols} borderStyle="round" borderColor={theme.color('focusBorder')} paddingX={1}>
      <Box>
        <Text bold color={theme.color('primary')}>daimon — keyboard reference</Text>
        <Text {...theme.style('muted')}>
          {'  '}focused pane: {pane}
          {maxScroll > 0 ? `  ·  ${start + 1}-${Math.min(start + viewport, lines.length)}/${lines.length}  [↑/↓] scroll` : ''}
        </Text>
      </Box>

      {view.map((l, i) =>
        l.kind === 'title' ? (
          <Text key={i} bold color={theme.color('accent')}>{l.text}</Text>
        ) : (
          <Box key={i}>
            <Text color={theme.color('primary')}>{'  ' + l.key.padEnd(keyW).slice(0, keyW)}</Text>
            <Text>{l.desc.padEnd(descW).slice(0, descW)}</Text>
            {showPanes ? <Text {...theme.style('muted')}>{l.panes}</Text> : null}
          </Box>
        ),
      )}

      {/* The overlay's own dismissal keys — written as prose, not as a
          bracketed ribbon, because Esc and q here are overlay-local
          affordances rather than map chords, and the drift gate in
          test/tui-chords.test.mjs rightly rejects hand-listed ribbons. The
          help key itself still comes from the map. */}
      <Text {...theme.style('muted')}>
        close: {CHORDS.find(c => c.id === 'help')?.key ?? '?'} · Esc · q
      </Text>
    </Box>
  );
}
