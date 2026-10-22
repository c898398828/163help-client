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
    this.servers = this.servers.filter((s) => s.id !== id);
    if (this.servers.length === 0) {
      this.cursor = 0;
    } else {
      this.cursor = this.cursor % this.servers.length;
    }
    if (this.activeHolder === id) {
      this.activeHolder = null;
      this.pumpQueue();
    }
  }

  setCooldown(serverId: string, ms?: number): void {
    const s = this.servers.find((x) => x.id === serverId);
    if (s) {
      s.cooldownUntil = Date.now() + (typeof ms === 'number' ? ms : this.defaultCooldownMs);
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
      if (this.paused) return null;
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
    if (this.paused) {
      this.pumpQueue();
      return null;
    }
    this.activeHolder = serverId;
    return () => {
      if (this.activeHolder === serverId) {
        this.activeHolder = null;
        this.pumpQueue();
      }
    };
  }

  async requestNextTurn(): Promise<SchedulerTurnGrant | null> {
    while (this.activeHolder !== null) {
      if (this.paused) return null;
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
    return {
      serverId: picked.id,
      release: (_outcome) => {
        if (this.activeHolder === picked.id) {
          this.activeHolder = null;
          this.pumpQueue();
        }
      },
    };
  }

  private pumpQueue(): void {
    const next = this.waitQueue.shift();
    if (next) next();
  }
}
