import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as webpush from 'web-push';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';

const log = logger('notify');

/** scope: 이 알림이 속한 대화('team:<id>' | 'po'). 누군가 그 대화를 화면에 띄워 보고 있으면 알리지 않는다. */
export interface Notice { title: string; body: string; url?: string; level?: 'info' | 'warn' | 'crit' | 'good'; tag?: string; scope?: string }

export interface Notifier { send(n: Notice): Promise<void>; vapidPublicKey(): string | null; presence?(device: string, view: string | null): void; sendTo?(endpoint: string, n: Notice): Promise<{ ok: boolean; status?: number; error?: string }> }

/** 마크다운 → 슬랙 mrkdwn: **굵게** → *굵게*, 제목 # → 굵게, 표는 그대로. */
export function toSlack(md: string): string {
  return md.replace(/\*\*([^*\n]+)\*\*/g, '*$1*').replace(/^#{1,4}\s+(.+)$/gm, '*$1*').replace(/!\[([^\]]*)\]\(\/api\/uploads\/[^)]+\)/g, '[이미지 $1]');
}

/** 슬랙 웹훅 + 웹 푸시. 둘 다 실패해도 호출자를 막지 않는다. */
export class AppNotifier implements Notifier {
  private vapid: { publicKey: string; privateKey: string } | null = null;

  constructor(private store: Store, home: string) {
    const file = join(home, 'vapid.json');
    try {
      if (existsSync(file)) this.vapid = JSON.parse(readFileSync(file, 'utf8'));
      else { this.vapid = webpush.generateVAPIDKeys(); writeFileSync(file, JSON.stringify(this.vapid), { mode: 0o600 }); }
    } catch (e) { log.warn('VAPID 키 준비 실패, 웹 푸시 꺼짐', e); this.vapid = null; }
  }

  vapidPublicKey(): string | null { return this.vapid?.publicKey ?? null; }

  /**
   * VAPID 연락처(sub). 애플 푸시(web.push.apple.com)는 localhost 같은 가짜 주소면 403 BadJwtToken 으로 거절한다.
   * → 원격 주소(https://…ts.net) · 주인 계정 메일 · 저장소 주소 순으로 실제 주소를 쓴다.
   */
  private vapidDetails(): { subject: string; publicKey: string; privateKey: string } {
    const pub = this.store.getKv<string | null>('public_url', null);
    const owner = this.store.getSettings().ownerLogin;
    const subject = pub && /^https:\/\//.test(pub) ? pub : owner && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(owner) ? `mailto:${owner}` : 'https://github.com/webjihong/hivelane';
    return { subject, publicKey: this.vapid!.publicKey, privateKey: this.vapid!.privateKey };
  }

  /** 슬랙 「열기」 링크: 원격(Tailscale) 주소가 있으면 그것, 없으면 로컬 */
  private baseUrl(): string { return process.env.HIVELANE_PUBLIC_URL ?? this.store.getKv<string | null>('public_url', null) ?? `http://127.0.0.1:${process.env.HIVELANE_PORT ?? 4310}`; }

  /** 기기별로 지금 화면에 띄운 대화(45초 안에 알린 것만 유효) */
  private views = new Map<string, { view: string; at: number }>();
  presence(device: string, view: string | null): void { if (view) this.views.set(device, { view, at: Date.now() }); else this.views.delete(device); }
  viewing(scope: string): boolean { const now = Date.now(); return [...this.views.values()].some((v) => v.view === scope && now - v.at < 45_000); }

  async send(n: Notice): Promise<void> {
    if (n.scope && this.viewing(n.scope)) { log.info(`알림 생략(보고 있는 대화) · ${n.title}`); return; }
    await Promise.allSettled([this.slack(n), this.push(n)]);
  }

  private async slack(n: Notice): Promise<void> {
    const url = this.store.getSettings().slackWebhook;
    if (!url) return;
    const icon = { info: '🐝', warn: '🟠', crit: '🔴', good: '🟢' }[n.level ?? 'info'];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${icon} *${n.title}*\n${toSlack(n.body)}${n.url ? `\n<${/^https?:/.test(n.url) ? n.url : this.baseUrl() + n.url}|열기>` : ''}` }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) log.warn(`슬랙 전송 실패 ${r.status}`);
    } catch (e) { log.warn('슬랙 전송 실패', e); }
  }

  /** 한 기기에만 보내고 푸시 서비스 응답을 그대로 돌려준다(점검용). */
  async sendTo(endpoint: string, n: Notice): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!this.vapid) return { ok: false, error: 'VAPID 키 없음' };
    const s = this.store.pushSubs().find((x) => x.endpoint === endpoint);
    if (!s) return { ok: false, error: '서버에 이 기기 구독이 없습니다' };
    try {
      const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify({ title: `Hivelane · ${n.title}`, body: n.body, url: n.url ?? '/', tag: n.tag, level: n.level ?? 'info' }), { TTL: 600, urgency: 'high', vapidDetails: this.vapidDetails() });
      log.info(`푸시 점검 보냄 · ${s.device} · ${r.statusCode}`);
      return { ok: true, status: r.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const body = (e as { body?: string }).body || String(e);
      log.warn(`푸시 점검 실패 · ${s.device} · ${status ?? '-'} · ${String(body).slice(0, 200)}`);
      if (status === 404 || status === 410) this.store.removePushSub(s.endpoint);
      return { ok: false, status, error: body };
    }
  }

  private async push(n: Notice): Promise<void> {
    if (!this.vapid) return;
    const payload = JSON.stringify({ title: `Hivelane · ${n.title}`, body: n.body.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), url: n.url ?? '/', tag: n.tag, level: n.level ?? 'info' });
    for (const s of this.store.pushSubs()) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, { TTL: 86_400, urgency: 'high', vapidDetails: this.vapidDetails() });
        log.info(`푸시 보냄 · ${s.device} · ${n.title}`);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.store.removePushSub(s.endpoint);
        else log.warn(`웹 푸시 실패 · ${s.device} · ${code ?? '-'} · ${String((e as { body?: string }).body ?? e).slice(0, 200)}`);
      }
    }
  }
}

export class NullNotifier implements Notifier {
  sent: Notice[] = [];
  async send(n: Notice): Promise<void> { this.sent.push(n); }
  vapidPublicKey(): string | null { return null; }
}
