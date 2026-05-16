import net from 'node:net';

export class PortAllocator {
  private assigned = new Map<string, number>();
  private readonly min: number;
  private readonly max: number;

  constructor(range: [number, number]) {
    this.min = range[0];
    this.max = range[1];
  }

  getAssigned(name: string): number | undefined {
    return this.assigned.get(name);
  }

  pin(name: string, port: number): void {
    this.assigned.set(name, port);
  }

  async allocate(name: string, pinned?: number): Promise<number> {
    const existing = this.assigned.get(name);
    if (existing !== undefined) return existing;

    if (pinned !== undefined) {
      this.assigned.set(name, pinned);
      return pinned;
    }

    const used = new Set(this.assigned.values());
    for (let p = this.min; p <= this.max; p++) {
      if (used.has(p)) continue;
      const free = await isPortFree(p);
      if (free) {
        this.assigned.set(name, p);
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
