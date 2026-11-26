/**
 * 백업 저장소: 이 맥 폴더(NAS 를 Finder 로 연결한 폴더 포함) · WebDAV(시놀로지 NAS) · S3(호환 포함).
 * 패키지를 더 들이지 않으려고 WebDAV 는 fetch, S3 는 서명(SigV4)을 직접 만든다.
 */
import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackupItem, BackupTarget } from '../../shared/types.ts';
import { st } from '../i18n.ts';

export interface TargetIO {
  put(name: string, file: string): Promise<void>;
  list(): Promise<Omit<BackupItem, 'target'>[]>;
  get(name: string, dest: string): Promise<void>;
  del(name: string): Promise<void>;
}

export const BACKUP_RE = /^hivelane-backup-\d{8}-\d{6}(-[\w-]+)?\.tar\.gz$/;
const safeName = (n: string) => { if (!BACKUP_RE.test(n)) throw new Error(st('백업 파일 이름이 올바르지 않습니다')); return n; };

/* ---------- 이 맥 폴더 ---------- */
export class LocalTarget implements TargetIO {
  private dir: string;
  constructor(dir: string) { this.dir = dir.replace(/^~(?=\/|$)/, homedir()); }
  private ensure(): void {
    if (this.dir.startsWith('/Volumes/') && !existsSync(this.dir.split('/').slice(0, 3).join('/'))) throw new Error(st('NAS 폴더가 연결돼 있지 않습니다({dir}). Finder 에서 NAS 에 연결하세요', { dir: this.dir }));
    mkdirSync(this.dir, { recursive: true });
  }
  async put(name: string, file: string): Promise<void> { this.ensure(); copyFileSync(file, join(this.dir, safeName(name))); }
  async list(): Promise<Omit<BackupItem, 'target'>[]> {
    if (!existsSync(this.dir)) { this.ensure(); return []; }
    return readdirSync(this.dir).filter((n) => BACKUP_RE.test(n)).map((n) => { const s = statSync(join(this.dir, n)); return { name: n, size: s.size, at: s.mtime.toISOString() }; });
  }
  async get(name: string, dest: string): Promise<void> { copyFileSync(join(this.dir, safeName(name)), dest); }
  async del(name: string): Promise<void> { rmSync(join(this.dir, safeName(name)), { force: true }); }
}

/* ---------- WebDAV(시놀로지 NAS 의 WebDAV Server 등) ---------- */
export class WebDavTarget implements TargetIO {
  private base: string;
  constructor(url: string, private user: string, private pass: string, private fetchFn: typeof fetch = fetch) { this.base = url.replace(/\/+$/, '') + '/'; }
  private h(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.user ? { Authorization: `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}` } : {}), ...extra };
  }
  private async req(method: string, url: string, init: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> {
    const r = await this.fetchFn(url, { method, headers: this.h(init.headers), body: init.body as BodyInit | undefined });
    if (r.status === 401) throw new Error(st('WebDAV 로그인 실패(사용자·비밀번호 확인)'));
    return r;
  }
  async put(name: string, file: string): Promise<void> {
    await this.req('MKCOL', this.base).catch(() => undefined); // 폴더가 없으면 만든다(있으면 405, 무시)
    const r = await this.req('PUT', this.base + encodeURIComponent(safeName(name)), { body: readFileSync(file), headers: { 'Content-Type': 'application/gzip' } });
    if (!r.ok) throw new Error(st('WebDAV 올리기 실패(HTTP {status})', { status: r.status }));
  }
  async list(): Promise<Omit<BackupItem, 'target'>[]> {
    const r = await this.req('PROPFIND', this.base, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>' });
    if (r.status === 404) return [];
    if (!r.ok && r.status !== 207) throw new Error(st('WebDAV 목록 실패(HTTP {status})', { status: r.status }));
    return parseDavList(await r.text());
  }
  async get(name: string, dest: string): Promise<void> {
    const r = await this.req('GET', this.base + encodeURIComponent(safeName(name)));
    if (!r.ok) throw new Error(st('WebDAV 받기 실패(HTTP {status})', { status: r.status }));
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  async del(name: string): Promise<void> {
    const r = await this.req('DELETE', this.base + encodeURIComponent(safeName(name)));
    if (!r.ok && r.status !== 404) throw new Error(st('WebDAV 지우기 실패(HTTP {status})', { status: r.status }));
  }
}

export function parseDavList(xml: string): Omit<BackupItem, 'target'>[] {
  const out: Omit<BackupItem, 'target'>[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi)) {
    const block = m[0];
    const href = block.match(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/i)?.[1] ?? '';
    const name = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() ?? '');
    if (!BACKUP_RE.test(name)) continue;
    const size = Number(block.match(/<(?:\w+:)?getcontentlength>(\d+)</i)?.[1] ?? 0);
    const mod = block.match(/<(?:\w+:)?getlastmodified>([^<]+)</i)?.[1];
    out.push({ name, size, at: mod ? new Date(mod).toISOString() : null });
  }
  return out;
}

/* ---------- S3(AWS · S3 호환: 시놀로지 C2 · MinIO 등) ---------- */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** AWS 서명 v4 헤더 만들기(테스트용으로 따로 둔다) */
export function signS3(o: { method: string; url: URL; region: string; accessKeyId: string; secret: string; payloadHash: string; now?: Date }): Record<string, string> {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const query = [...o.url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const headers: Record<string, string> = { host: o.url.host, 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [o.method, o.url.pathname, query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n');
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secret}`, day), o.region), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
}

export class S3Target implements TargetIO {
  constructor(private t: { bucket: string; region: string; endpoint?: string; prefix?: string; accessKeyId: string; secret: string }, private fetchFn: typeof fetch = fetch) {}
  private prefix(): string { const p = (this.t.prefix ?? '').replace(/^\/+|\/+$/g, ''); return p ? `${p}/` : ''; }
  private url(key = '', query: Record<string, string> = {}): URL {
    const path = key ? '/' + key.split('/').map(enc).join('/') : '/';
    const u = this.t.endpoint
      ? new URL(`${this.t.endpoint.replace(/\/+$/, '')}/${enc(this.t.bucket)}${path}`) // 호환 저장소는 경로 방식
      : new URL(`https://${this.t.bucket}.s3.${this.t.region}.amazonaws.com${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }
  private async req(method: string, u: URL, body?: Buffer): Promise<Response> {
    const payloadHash = body ? sha256(body) : sha256('');
    const headers = signS3({ method, url: u, region: this.t.region || 'us-east-1', accessKeyId: this.t.accessKeyId, secret: this.t.secret, payloadHash });
    delete (headers as Record<string, string | undefined>).host;
    const r = await this.fetchFn(u, { method, headers, body: body as BodyInit | undefined });
    if (r.status === 403) { const t = await r.text(); throw new Error(st('S3 권한 오류: {msg}', { msg: t.match(/<Message>([^<]+)/)?.[1] ?? 'Access Denied' })); }
    return r;
  }
  async put(name: string, file: string): Promise<void> {
    const r = await this.req('PUT', this.url(this.prefix() + safeName(name)), readFileSync(file));
    if (!r.ok) throw new Error(st('S3 올리기 실패(HTTP {status}) {msg}', { status: r.status, msg: (await r.text()).match(/<Message>([^<]+)/)?.[1] ?? '' }));
  }
  async list(): Promise<Omit<BackupItem, 'target'>[]> {
    const r = await this.req('GET', this.url('', { 'list-type': '2', prefix: this.prefix() + 'hivelane-backup-' }));
    if (!r.ok) throw new Error(st('S3 목록 실패(HTTP {status}) {msg}', { status: r.status, msg: (await r.text()).match(/<Message>([^<]+)/)?.[1] ?? '' }));
    return parseS3List(await r.text(), this.prefix());
  }
  async get(name: string, dest: string): Promise<void> {
    const r = await this.req('GET', this.url(this.prefix() + safeName(name)));
    if (!r.ok) throw new Error(st('S3 받기 실패(HTTP {status})', { status: r.status }));
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  async del(name: string): Promise<void> {
    const r = await this.req('DELETE', this.url(this.prefix() + safeName(name)));
    if (!r.ok && r.status !== 404) throw new Error(st('S3 지우기 실패(HTTP {status})', { status: r.status }));
  }
}

export function parseS3List(xml: string, prefix: string): Omit<BackupItem, 'target'>[] {
  const out: Omit<BackupItem, 'target'>[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = m[1]!.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? '';
    const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    if (!BACKUP_RE.test(name)) continue;
    out.push({ name, size: Number(m[1]!.match(/<Size>(\d+)/)?.[1] ?? 0), at: m[1]!.match(/<LastModified>([^<]+)/)?.[1] ?? null });
  }
  return out;
}

/** 설정 + 비밀값 → 저장소 */
export function makeTarget(t: BackupTarget, secret: string | null, fetchFn?: typeof fetch): TargetIO {
  if (t.type === 'local') { if (!t.path) throw new Error(st('폴더 경로가 없습니다')); return new LocalTarget(t.path); }
  if (t.type === 'webdav') { if (!t.url) throw new Error(st('WebDAV 주소가 없습니다')); return new WebDavTarget(t.url, t.username ?? '', secret ?? '', fetchFn); }
  if (!t.bucket || !t.accessKeyId || !secret) throw new Error(st('S3 버킷·접근 키·비밀 키가 필요합니다'));
  return new S3Target({ bucket: t.bucket, region: t.region || 'us-east-1', endpoint: t.endpoint || undefined, prefix: t.prefix, accessKeyId: t.accessKeyId, secret }, fetchFn);
}
