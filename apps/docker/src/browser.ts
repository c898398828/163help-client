/**
 * Playwright 浏览器适配（docker 端）
 * - 无头 Chromium（静音、no-sandbox）
 * - 页面 = 网易云首页（注入 MUSIC_U cookie）
 * - 页内播放器 helper：__mhPlayer（fetch player/url → audio 播放 → 进度读取）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

/** 页内播放器 helper（以字符串注入页面；导出工厂以便单测其进度与身份解析逻辑） */
export function createPageHelper(w: Record<string, any>): void {
  let lastDurMs = 0; // 流式音频 duration 常读到 NaN/0：记住上次已知值兜底
  let identityCache: { id: string; name: string; vipType: number } | null = null;
  let playGeneration = 0;
  let playController: AbortController | null = null;
  // 必须留在工厂内：注入源码不能依赖 Node 侧闭包。
  async function bounded<T>(request: Promise<T>, ms: number, onTimeout: () => void, describe?: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 先抓诊断：onTimeout 会停止媒体并清掉它的状态。
          const error = new Error('页内操作超时' + (describe ? `（${describe()}）` : ''));
          onTimeout();
          reject(error);
        }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  function resetAudio(audio: HTMLAudioElement): void {
    audio.pause();
    // 仅 src='' 不保证立即终止旧请求；load() 会取消旧的媒体加载和 play Promise。
    if (audio.removeAttribute) audio.removeAttribute('src');
    else audio.src = '';
    audio.load?.();
  }
  const player: {
    audio: HTMLAudioElement | null;
    play(musicId: string | number): Promise<{ ok: boolean; err?: string; durationMs?: number; attempts?: number }>;
    progress(): { playedMs: number; durationMs: number };
    identity(): Promise<{ id: string; name: string; vipType: number }>;
    setRate(r: number): void;
    stop(): void;
  } = {
    audio: null,
    async play(musicId) {
      const generation = ++playGeneration;
      playController?.abort();
      const controller = new AbortController();
      playController = controller;
      const startedAt = Date.now();
      const current = () => generation === playGeneration && !controller.signal.aborted;
      let attempt = 1;
      let stage: 'fetch' | 'decode' | 'audio.play' = 'fetch';
      let stageAt = startedAt;
      let times = { fetch: 0, decode: 0, 'audio.play': 0 };
      let sourceHost = '-';
      let media: HTMLAudioElement | null = null;
      let timeoutDiagnostic = '';
      const previousAttempts: string[] = [];
      const enterStage = (next: typeof stage) => {
        const now = Date.now();
        times[stage] += Math.max(0, now - stageAt);
        stage = next;
        stageAt = now;
      };
      const describeAttempt = () => {
        const elapsed = { ...times, [stage]: times[stage] + Math.max(0, Date.now() - stageAt) };
        const audio = current() ? media : null;
        return `attempt=${attempt} fetch=${elapsed.fetch}ms decode=${elapsed.decode}ms audio.play=${elapsed['audio.play']}ms`
          + ` readyState=${audio?.readyState ?? '-'} networkState=${audio?.networkState ?? '-'} mediaError=${audio?.error?.code ?? 0} sourceHost=${sourceHost}`;
      };
      const diagnostic = () => [...previousAttempts, describeAttempt()].join('；');
      try {
        return await bounded((async () => {
          const id = String(musicId).replace(/^song:/, '');
          for (;;) {
            // 播放地址可能短时失效；恢复时必须真正取新地址，不能复用 HTTP 缓存里的旧 JSON。
            const r = await w.fetch('/api/song/enhance/player/url?ids=' + encodeURIComponent(JSON.stringify([Number(id)])) + '&br=128000', { signal: controller.signal, cache: 'no-store' });
            if (!current()) return { ok: false, err: '已被停止或新的播放取代' };
            enterStage('decode');
            if (r.ok === false) throw new Error(`歌曲地址请求失败（HTTP ${r.status}）`);
            const d = (await r.json()).data?.[0];
            // stop / 下一首可在 fetch 或 json 期间发生，迟到响应不得再修改音频。
            if (!current()) return { ok: false, err: '已被停止或新的播放取代' };
            if (!d || !d.url) throw new Error('歌曲地址不可用');
            try { sourceHost = new URL(d.url).hostname; } catch { sourceHost = '-'; }
            if (!this.audio) { this.audio = document.createElement('audio'); document.body.appendChild(this.audio); }
            media = this.audio;
            lastDurMs = 0; // 仅缓存当前歌曲的时长，不能跨曲兜底
            media.src = d.url;
            media.playbackRate = 1;
            enterStage('audio.play');
            const startTimeout = new Error('音频起播等待超时');
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const playing = media.play();
              // 只给首次起播一个恢复机会；第二次及慢取流后的起播仍受原 20s 总预算约束。
              if (attempt === 1 && Date.now() - startedAt < 12_000) {
                await Promise.race([playing, new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(startTimeout), 8_000);
                })]);
              } else await playing;
            } catch (e) {
              if (!current()) throw e;
              const position = Number(media.currentTime);
              const progressed = Number.isFinite(position) && position > 0;
              const code = media.error?.code ?? 0;
              const name = e instanceof Error ? e.name : '';
              // Promise 未完成但音频确实已开始，不能清零已经上报的进度。
              if (!(e === startTimeout && progressed && (!media.paused || media.ended) && !code)) {
                const terminal = ['NotAllowedError', 'NotSupportedError', 'SecurityError'].includes(name) || [1, 3, 4].includes(code);
                const temporary = e === startTimeout || name === 'NetworkError' || code === 2;
                if (attempt !== 1 || progressed || terminal || !temporary || Date.now() - startedAt >= 20_000) throw e;
                previousAttempts.push(describeAttempt());
                resetAudio(media);
                attempt = 2;
                stage = 'fetch';
                stageAt = Date.now();
                times = { fetch: 0, decode: 0, 'audio.play': 0 };
                sourceHost = '-';
                media = null;
                continue;
              }
            } finally { clearTimeout(timer); }
            if (!current()) return { ok: false, err: '已被停止或新的播放取代' };
            const durationMs = Math.round(Number(d.duration) * 1000);
            return { ok: true, durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0, ...(attempt === 2 ? { attempts: 2 } : {}) };
          }
        })(), 20_000, () => {
          controller.abort();
          if (generation === playGeneration) this.stop();
        }, () => { timeoutDiagnostic = diagnostic(); return stage; });
      } catch (e) {
        const detail = timeoutDiagnostic || diagnostic();
        // 浏览器错误偶尔也带媒体 URL；日志只保留上面的 hostname，不泄露签名参数。
        const error = String(e).replace(/https?:\/\/[^\s"'<>]+/gi, '[媒体地址已隐藏]') + '；' + detail;
        if (generation === playGeneration) this.stop();
        return { ok: false, err: error };
      } finally {
        if (playController === controller) playController = null;
      }
    },
    progress() {
      const a = this.audio;
      if (!a) return { playedMs: 0, durationMs: 0 };
      const currentMs = Math.round(a.currentTime * 1000);
      const playedMs = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
      const d = Math.round(Number(a.duration) * 1000);
      if (Number.isFinite(d) && d > 0) lastDurMs = d;
      // 已播完时把 duration 记为当前进度，让上层能按「歌曲播完」结算（时长未知的流式音频也能收敛）
      return { playedMs, durationMs: a.ended ? playedMs : lastDurMs };
    },
    /** 网易云账号身份（服务端心跳据此校验播放账号）；成功才缓存，失败下次重试 */
    async identity() {
      if (identityCache) return identityCache;
      const controller = new AbortController();
      try {
        const d = await bounded((async () => {
          const r = await w.fetch('/api/nuser/account/get', { credentials: 'include', signal: controller.signal });
          return r.json();
        })(), 8_000, () => controller.abort());
        const raw = d && d.account && d.account.id != null ? String(d.account.id) : '';
        const id = /^\d{1,32}$/.test(raw) ? raw : ''; // 服务端只接受纯数字 id
        const name = d && d.profile && typeof d.profile.nickname === 'string' ? d.profile.nickname : '';
        const vipType = d && d.account && typeof d.account.vipType === 'number' ? d.account.vipType : 0;
        if (id) identityCache = { id, name, vipType };
        return { id, name, vipType };
      } catch {
        return { id: '', name: '', vipType: 0 };
      }
    },
    setRate(r) { if (this.audio) this.audio.playbackRate = r; },
    stop() {
      playGeneration++;
      playController?.abort();
      playController = null;
      lastDurMs = 0;
      if (this.audio) resetAudio(this.audio);
    },
  };
  w.__mhPlayer = player;
}

/** 注入页面的源码（由工厂函数序列化，保证与单测逻辑同源） */
export const PAGE_HELPER = `(${createPageHelper.toString()})(window);`;

export class DockBrowser {
  private browser: any = null;
  private page: any = null;
  private playGeneration = 0;
  private dataDir: string;
  private cookieHeader: string; // 用户网易云 Cookie（MUSIC_U 等）

  constructor(dataDir: string, cookieHeader: string) {
    this.dataDir = dataDir;
    this.cookieHeader = cookieHeader;
  }

  async launch() {
    const executable = process.env.PW_EXECUTABLE || undefined;
    this.browser = await chromium.launch({
      executablePath: executable || undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
    this.page = await this.browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' });
    await this.page.setExtraHTTPHeaders({});
    await this.page.goto('https://music.163.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.applyCookie();
    await this.page.evaluate(PAGE_HELPER);
  }

  /** 浏览器断开（崩溃/被杀）回调；未启动时安全返回 */
  onDisconnect(cb: () => void): void {
    try { this.browser?.on('disconnected', cb); } catch { /* 未启动或无该事件 */ }
  }

  /** 更新网易云 Cookie 并重载页面（管理端保存配置后即时生效）；重载会清掉页内播放器，需重新注入 */
  async setCookie(cookieHeader: string): Promise<void> {
    this.cookieHeader = cookieHeader;
    if (!this.page) return;
    await this.applyCookie();
    await this.page.evaluate(PAGE_HELPER);
  }

  /** 应用当前 Cookie（先清空，避免旧登录态残留）并重载首页 */
  private async applyCookie(): Promise<void> {
    await this.page.context().clearCookies();
    if (this.cookieHeader) {
      for (const pair of this.cookieHeader.split(';')) {
        const [k, ...v] = pair.trim().split('=');
        if (k && v.length) {
          await this.page.context().addCookies([{ name: k.trim(), value: v.join('=').trim(), domain: '.music.163.com', path: '/' }]);
        }
      }
    }
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  /** page.evaluate 本身没有超时；renderer 卡死也不能锁住生命周期。 */
  private async evaluate<T>(fn: (arg: any) => T | Promise<T>, arg: any, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.page.evaluate(fn, arg), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('浏览器操作超时')), ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  async play(musicId: string, _durationMs: number): Promise<{ ok: boolean; err?: string; attempts?: number }> {
    const generation = ++this.playGeneration;
    try {
      // 外层时限必须大于页内 20s：让页内超时先返回「卡在哪一步」，否则只剩一句无信息的失败
      const r = await this.evaluate((id: string) => (window as any).__mhPlayer.play(id), musicId, 25_000);
      if (generation !== this.playGeneration) return { ok: false, err: '播放已被停止或取代' };
      if (!r || typeof r !== 'object') return { ok: false, err: '页内播放器无响应' };
      return { ok: r.ok === true, err: r.err ? String(r.err) : undefined, ...(r.ok === true && r.attempts === 2 ? { attempts: 2 } : {}) };
    } catch (e) {
      // renderer 恢复时也要失效超时播放，但不能清理另一首较新的歌曲。
      if (generation === this.playGeneration) void this.stop();
      return { ok: false, err: e instanceof Error ? e.message : String(e) };
    }
  }

  async progress(): Promise<{ playedMs: number; durationMs: number }> {
    return await this.evaluate(() => (window as any).__mhPlayer.progress(), undefined, 5_000);
  }

  /** 网易云账号身份（供心跳/请求头）；页面未就绪或未登录时返回空身份 */
  async identity(): Promise<{ id: string; name: string; vipType: number }> {
    try {
      const r = await this.evaluate(() => (window as any).__mhPlayer.identity(), undefined, 12_000);
      return r ?? { id: '', name: '', vipType: 0 };
    } catch {
      return { id: '', name: '', vipType: 0 };
    }
  }

  async stop(): Promise<void> {
    this.playGeneration++;
    await this.evaluate(() => (window as any).__mhPlayer.stop(), undefined, 5_000).catch(() => {});
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}
