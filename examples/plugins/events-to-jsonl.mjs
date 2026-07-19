// events-to-jsonl — example daimon plugin (Plugin API v1). See PLUGINS.md.
//
// Appends one JSON line per daimon event to events.jsonl NEXT TO THIS FILE
// (so a copy in ~/.daimon/plugins logs to ~/.daimon/plugins/events.jsonl).
// Demonstrates the observe hook and honest file I/O: plugins are NOT
// sandboxed — this code runs in-process with full Node privileges, so it can
// write wherever you can. That is the trust model, not a bug.
//
// Install: copy into ~/.daimon/plugins/, then `daimon daemon restart`.
// Verify:  `daimon plugins` shows it active; tail events.jsonl while an app
//          starts or errors.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'events.jsonl');

export default {
  name: 'events-to-jsonl',
  apiVersion: 1,
  description: 'Appends every daimon event to events.jsonl beside this file.',

  // Called after each event is recorded, off the write path. `evt` is a
  // frozen copy: { ts, app, type, from?, to?, message? }. Throwing here would
  // disable this plugin for the session — appendFileSync on a local path is
  // safe enough for an example; wrap riskier I/O in your own try/catch.
  onEvent(evt) {
    fs.appendFileSync(OUT_FILE, JSON.stringify(evt) + '\n');
  },
};
