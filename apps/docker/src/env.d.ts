declare module 'playwright-core' {
  export const chromium: any;
}
declare module 'node:fs' {
  export function mkdirSync(p: string, o?: any): void;
  export function readFileSync(p: string, e?: any): string;
  export function writeFileSync(p: string, d: any): void;
  export function readdirSync(p: string): string[];
  export function statSync(p: string): { size: number; isFile(): boolean };
  export function createReadStream(p: string): { on(e: string, c: (...a: any[]) => void): void; pipe(dest: any): void };
}
declare module 'node:path' {
  export function join(...p: string[]): string;
  export function extname(p: string): string;
}
declare module 'node:url' {
  export function fileURLToPath(u: string | URL): string;
}
declare const process: { env: Record<string, string | undefined>; exit(code: number): void };

declare module 'node:http' {
  export interface IncomingMessage { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; on(e: string, c: (d: any) => void): void }
  export interface ServerResponse { writeHead(c: number, h?: any): void; end(d?: any): void; destroy(): void }
  export function createServer(cb: (req: IncomingMessage, res: ServerResponse) => void): { listen(p: number, h: string): void };
}
declare module 'node:crypto' {
  export function randomBytes(n: number): BufferLike;
  export type BufferLike = { toString(enc: string): string };
}
