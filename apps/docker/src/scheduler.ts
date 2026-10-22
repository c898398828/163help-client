export interface SchedulerTurnGrant {
  serverId: string;
  release: (outcome: 'settled' | 'abandoned' | 'no_job' | 'error') => void;
}

interface RegisteredServer {
  id: string;
  getEligibility: () => { enabled: boolean; eligible: boolean };
  cooldownUntil: number;
}

export class MultiServerScheduler {
  private servers: RegisteredServer[] = [];
  private cursor = 0;
  private activeHolder: string | null = null;
  private holderCount = 0;
  private waitQueue: Array<() => void> = [];
  private paused = false;
  private readonly defaultCooldownMs: number;

  constructor(opts?: { noTargetCooldownMs?: number }) {
    this.defaultCooldownMs = opts?.noTargetCooldownMs ?? 30_000;
  }

  registerServer(id: string, getEligibility: () => { enabled: boolean; eligible: boolean }): void {
    const existing = this.servers.find((s) => s.id === id);
    if (existing) {
      existing.getEligibility = getEligibility;
    } else {
      this.servers.push({ id, getEligibility, cooldownUntil: 0 });
    }
  }

  unregisterServer(id: string): void {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      this.servers.splice(idx, 1);
      if (this.servers.length === 0) {
        this.cursor = 0;
      } else if (idx < this.cursor) {
        this.cursor--;
      } else if (this.cursor >= this.servers.length) {
        this.cursor = 0;
      }
    }
    if (this.activeHolder === id) {
      this.activeHolder = null;
      this.holderCount = 0;
      this.pumpQueue();
    }
  }

  setCooldown(serverId: string, ms?: number): void {
    const s = this.servers.find((x) => x.id === serverId);
    if (s) {
      const cooldownMs = typeof ms === 'number' && Number.isFinite(ms) ? ms : this.defaultCooldownMs;
      s.cooldownUntil = Date.now() + cooldownMs;
    }
  }

  getCooldownUntil(serverId: string): number {
    const s = this.servers.find((x) => x.id === serverId);
    return s ? s.cooldownUntil : 0;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.pumpQueue();
  }

  reset(): void {
    this.activeHolder = null;
    this.holderCount = 0;
    this.cursor = 0;
    this.paused = false;
    const q = this.waitQueue;
    this.waitQueue = [];
    this.servers = [];
    for (const resolve of q) {
      resolve();
    }
  }

  async acquireTurn(serverId: string): Promise<(() => void) | null> {
    while (this.activeHolder !== null && this.activeHolder !== serverId) {
      if (this.paused || !this.servers.some((s) => s.id === serverId)) {
        this.pumpQueue();
        return null;
      }
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    if (this.paused || !this.servers.some((s) => s.id === serverId)) {
      this.pumpQueue();
      return null;
    }
    this.activeHolder = serverId;
    this.holderCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.activeHolder === serverId) {
        this.holderCount--;
        if (this.holderCount <= 0) {
          this.activeHolder = null;
          this.holderCount = 0;
          this.pumpQueue();
        }
      }
    };
  }

  async requestNextTurn(): Promise<SchedulerTurnGrant | null> {
    while (this.activeHolder !== null) {
      if (this.paused) {
        this.pumpQueue();
        return null;
      }
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    if (this.paused || this.servers.length === 0) {
      this.pumpQueue();
      return null;
    }

    const n = this.servers.length;
    const now = Date.now();
    let picked: RegisteredServer | null = null;

    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const s = this.servers[idx];
      const elig = s.getEligibility?.() ?? { enabled: false, eligible: false };
      if (elig.enabled && elig.eligible && s.cooldownUntil <= now) {
        picked = s;
        this.cursor = (idx + 1) % n;
        break;
      }
    }

    if (!picked) {
      this.pumpQueue();
      return null;
    }

    this.activeHolder = picked.id;
    this.holderCount = 1;
    let released = false;
    return {
      serverId: picked.id,
      release: (_outcome) => {
        if (released) return;
        released = true;
        if (this.activeHolder === picked.id) {
          this.holderCount--;
          if (this.holderCount <= 0) {
            this.activeHolder = null;
            this.holderCount = 0;
            this.pumpQueue();
          }
        }
      },
    };
  }

  private pumpQueue(): void {
    const next = this.waitQueue.shift();
    if (next) next();
  }
}
