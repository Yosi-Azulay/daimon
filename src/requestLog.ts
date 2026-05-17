import http from 'node:http';
import net from 'node:net';
import type { Registry } from './registry.js';
import type { RequestLogConfig } from './types.js';

const RING_MAX = 200;

interface ReqEntry { ts: number; method: string; path: string; status: number; durationMs: number; }

interface Proxy { app: string; proxyPort: number; server: http.Server; buffer: ReqEntry[]; }

export class RequestLog {
  private proxies = new Map<string, Proxy>();
  private stopped = false;

  constructor(private readonly registry: Registry, private readonly cfg: RequestLogConfig) {
    if (!cfg.enabled) return;
    registry.on('change', this.onChange);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.registry.off('change', this.onChange);
    for (const p of this.proxies.values()) {
      try { p.server.close(); } catch {}
    }
    this.proxies.clear();
  }

  private onChange = () => { if (!this.stopped) this.tick(); };

  private tick(): void {
    for (const name of this.registry.names()) {
      const s = this.registry.getState(name);
      if (!s) continue;
      const has = this.proxies.has(name);
      if (s.status === 'serving' && s.port && !has) this.startProxy(name, s.port);
      else if (s.status !== 'serving' && has) this.stopProxy(name);
    }
  }

  private stopProxy(name: string): void {
    const p = this.proxies.get(name);
    if (!p) return;
    try { p.server.close(); } catch {}
    this.proxies.delete(name);
  }

  private startProxy(name: string, upstreamPort: number): void {
    const proxyPort = upstreamPort + this.cfg.portOffset;
    const buffer: ReqEntry[] = [];
    const server = http.createServer((req, res) => {
      const start = Date.now();
      const opts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
      };
      const upstream = http.request(opts, ur => {
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
        const log = () => {
          buffer.push({ ts: Date.now(), method: req.method || 'GET', path: req.url || '/', status: ur.statusCode || 0, durationMs: Date.now() - start });
          if (buffer.length > RING_MAX) buffer.splice(0, buffer.length - RING_MAX);
        };
        ur.on('end', log);
        ur.on('error', log);
      });
      upstream.on('error', () => {
        res.writeHead(502).end('upstream error');
        buffer.push({ ts: Date.now(), method: req.method || 'GET', path: req.url || '/', status: 502, durationMs: Date.now() - start });
        if (buffer.length > RING_MAX) buffer.splice(0, buffer.length - RING_MAX);
      });
      req.pipe(upstream);
    });
    server.on('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        process.stderr.write(`[appman] requestLog: port ${proxyPort} in use for ${name}; disabling proxy\n`);
      }
      this.proxies.delete(name);
    });
    server.listen(proxyPort, '127.0.0.1', () => {
      this.proxies.set(name, { app: name, proxyPort, server, buffer });
    });
  }

  requests(name: string, sinceMs?: number): ReqEntry[] {
    const p = this.proxies.get(name);
    if (!p) return [];
    if (sinceMs) {
      const cutoff = Date.now() - sinceMs;
      return p.buffer.filter(r => r.ts >= cutoff);
    }
    return [...p.buffer];
  }

  proxyPortFor(name: string): number | null {
    return this.proxies.get(name)?.proxyPort ?? null;
  }
}

void net;
