import net from 'node:net';

export interface PortAllocatorOptions {
  initial?: Record<string, number>;
  onChange?: (snapshot: Record<string, number>) => void;
}

export class PortAllocator {
  private assigned = new Map<string, number>();
  private readonly min: number;
  private readonly max: number;
  private readonly onChange?: (snapshot: Record<string, number>) => void;

  constructor(range: [number, number], opts: PortAllocatorOptions = {}) {
    this.min = range[0];
    this.max = range[1];
    this.onChange = opts.onChange;
    if (opts.initial) {
      const used = new Set<number>();
      for (const [name, port] of Object.entries(opts.initial)) {
        if (typeof port !== 'number') continue;
        if (port < this.min || port > this.max) continue;
        if (used.has(port)) continue;
        used.add(port);
        this.assigned.set(name, port);
      }
    }
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.assigned);
  }

  getAssigned(name: string): number | undefined {
    return this.assigned.get(name);
  }

  pin(name: string, port: number): void {
    this.assigned.set(name, port);
    this.onChange?.(this.snapshot());
  }

  async allocate(name: string, pinned?: number): Promise<number> {
    const existing = this.assigned.get(name);
    if (pinned !== undefined) {
      this.assigned.set(name, pinned);
      this.onChange?.(this.snapshot());
      return pinned;
    }
    if (existing !== undefined) return existing;

    const used = new Set(this.assigned.values());
    for (let p = this.min; p <= this.max; p++) {
      if (used.has(p)) continue;
      const free = await isPortFree(p);
      if (free) {
        this.assigned.set(name, p);
        this.onChange?.(this.snapshot());
        return p;
      }
    }
    throw new Error(`No free ports in range ${this.min}-${this.max}`);
  }

  async isPortAvailableForUse(port: number): Promise<boolean> {
    return isPortFree(port);
  }
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}
