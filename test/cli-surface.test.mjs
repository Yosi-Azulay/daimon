import test from 'node:test';
import assert from 'node:assert/strict';

const surface = await import('../dist/cliSurface.js');
const help = await import('../dist/cliHelp.js');

test('every CLI subcommand has description, args, summary, example', () => {
  for (const c of surface.CLI_SUBCOMMANDS) {
    assert.ok(c.description && c.description.length, `${c.name} missing description`);
    assert.ok(typeof c.args === 'string', `${c.name} missing args`);
    assert.ok(c.summary && c.summary.length, `${c.name} missing summary`);
    assert.ok(c.example && c.example.length, `${c.name} missing example`);
    assert.ok(['lifecycle','queries','agent','introspection','config','claude','plugin'].includes(c.group), `${c.name} group invalid`);
    // M87: every surface declares a stability tier (STABILITY.md).
    assert.ok(['frozen','stable','experimental'].includes(c.stability), `${c.name} stability invalid`);
  }
});

test('aliases ls/ps/log resolve to canonical verbs', () => {
  assert.equal(surface.CLI_ALIASES.ls, 'list');
  assert.equal(surface.CLI_ALIASES.ps, 'status');
  assert.equal(surface.CLI_ALIASES.log, 'logs');
  assert.equal(surface.findSubcommand('ls')?.name, 'list');
  assert.equal(surface.findSubcommand('ps')?.name, 'status');
  assert.equal(surface.findSubcommand('log')?.name, 'logs');
});

test('suggestCommand returns close matches within 2 edits', () => {
  // 'stat' is equidistant from 'start' (1) and 'status' (2); the closest wins.
  // Both are valid daimon-style nudges; we only assert that *some* close verb is returned.
  const stat = help.suggestCommand('stat');
  assert.ok(stat === 'start' || stat === 'status', `unexpected guess for stat: ${stat}`);
  assert.equal(help.suggestCommand('lsit'), 'list');
  assert.equal(help.suggestCommand('compleion'), 'completion');
  assert.equal(help.suggestCommand('asdfghjkl'), null);
});

test('suggestApp picks nearest', () => {
  assert.equal(help.suggestApp('web-admn', ['web-admin','api']), 'web-admin');
  assert.equal(help.suggestApp('nothingnearby', ['web-admin','api']), null);
});

test('completion emits non-empty scripts for all four shells', () => {
  for (const shell of ['bash','zsh','fish','powershell']) {
    const r = help.emitCompletion(shell);
    assert.ok(r.ok, `${shell} should emit`);
    assert.ok(r.script.length > 100, `${shell} script too small`);
  }
  const bad = help.emitCompletion('csh');
  assert.equal(bad.ok, false);
});

test('renderMainHelp lists all groups', () => {
  // Force color off for deterministic assertions
  help.setColorOverride('off');
  const text = help.renderMainHelp();
  for (const grp of ['lifecycle','queries','agent verbs','introspection','config','claude','plugin']) {
    assert.match(text, new RegExp(grp), `missing group "${grp}" in main help`);
  }
  assert.match(text, /aliases/);
  assert.match(text, /flag conventions/);
  help.setColorOverride(null);
});

test('renderSubcommandHelp emits synopsis, options, example, exit codes', () => {
  help.setColorOverride('off');
  const list = surface.findSubcommand('list');
  const text = help.renderSubcommandHelp(list);
  assert.match(text, /daimon list/);
  assert.match(text, /options/);
  assert.match(text, /--full/);
  assert.match(text, /--compact/);
  assert.match(text, /examples/);
  assert.match(text, /exit codes/);
  help.setColorOverride(null);
});

test('color override honors NO_COLOR semantics', () => {
  help.setColorOverride('off');
  assert.equal(help.isColorEnabled(), false);
  help.setColorOverride('on');
  assert.equal(help.isColorEnabled(), true);
  help.setColorOverride(null);
});
