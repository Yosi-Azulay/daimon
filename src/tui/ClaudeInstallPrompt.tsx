import React, { useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';

interface Selection {
  skill: boolean;
  commands: boolean;
  agent: boolean;
}

interface PromptProps {
  onDone: (sel: Selection | null) => void;
}

function Prompt({ onDone }: PromptProps) {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState<Selection>({ skill: true, commands: true, agent: true });
  const items: Array<{ key: keyof Selection; label: string }> = [
    { key: 'skill', label: 'Skill (~/.claude/skills/appman/SKILL.md)' },
    { key: 'commands', label: 'Slash commands (~/.claude/commands/appman-*.md)' },
    { key: 'agent', label: 'Subagent (~/.claude/agents/appman-runner.md)' },
  ];

  useInput((input, key) => {
    if (key.escape || (input === 'q' && !key.shift)) { onDone(null); exit(); return; }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow) setCursor(c => Math.min(items.length - 1, c + 1));
    else if (input === ' ') {
      const k = items[cursor].key;
      setSel(s => ({ ...s, [k]: !s[k] }));
    } else if (key.return) {
      onDone(sel);
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">Install Claude Code integration artifacts</Text>
      <Text dimColor>Space toggles · Enter confirms · Esc cancels</Text>
      {items.map((it, i) => (
        <Box key={it.key}>
          <Text color={i === cursor ? 'cyan' : undefined}>{i === cursor ? '▸ ' : '  '}</Text>
          <Text>[{sel[it.key] ? 'x' : ' '}] {it.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

export async function promptClaudeInstall(): Promise<Selection | null> {
  return new Promise(resolve => {
    let resolved = false;
    const inst = render(React.createElement(Prompt, {
      onDone: (sel: Selection | null) => {
        if (resolved) return;
        resolved = true;
        resolve(sel);
      },
    }));
    void inst.waitUntilExit().then(() => { if (!resolved) { resolved = true; resolve(null); } });
  });
}
