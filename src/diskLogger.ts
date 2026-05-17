import fs from 'node:fs';
import path from 'node:path';
import type { LogsConfig } from './types.js';

export class DiskLogger {
  private fd: number | null = null;
  private bytes = 0;
  private warned = false;
  private readonly filePath: string;

  constructor(private readonly appName: string, private readonly cfg: LogsConfig) {
    this.filePath = path.join(cfg.dir, `${appName}.log`);
    this.open();
  }

  private open(): void {
    try {
      fs.mkdirSync(this.cfg.dir, { recursive: true });
      try { this.bytes = fs.statSync(this.filePath).size; } catch { this.bytes = 0; }
      this.fd = fs.openSync(this.filePath, 'a');
    } catch (err: any) {
      this.warn(`open failed: ${err.message}`);
      this.fd = null;
    }
  }

  write(line: string): void {
    if (this.fd == null) return;
    try {
      const payload = `${new Date().toISOString()}\t${line}\n`;
      const buf = Buffer.from(payload, 'utf8');
      fs.writeSync(this.fd, buf);
      this.bytes += buf.length;
      if (this.bytes >= this.cfg.maxBytesPerFile) this.rotate();
    } catch (err: any) {
      this.warn(`write failed: ${err.message}`);
    }
  }

  close(): void {
    if (this.fd != null) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
  }

  private rotate(): void {
    try {
      this.close();
      for (let i = this.cfg.maxFiles - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        const to = `${this.filePath}.${i + 1}`;
        if (i + 1 > this.cfg.maxFiles - 1) {
          try { fs.rmSync(from, { force: true }); } catch {}
          continue;
        }
        try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
      }
      try {
        const first = `${this.filePath}.1`;
        if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, first);
      } catch {}
      this.open();
    } catch (err: any) {
      this.warn(`rotate failed: ${err.message}`);
    }
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[daimon] warning: diskLogger(${this.appName}) ${msg}\n`);
  }
}
