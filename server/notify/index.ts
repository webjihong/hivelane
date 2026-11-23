import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as webpush from 'web-push';
import { logger } from '../log.ts';
import type { Store } from '../store.ts';

const log = logger('notify');

export interface Notice { title: string; body: string; url?: string; level?: 'info' | 'warn' | 'crit' | 'good'; tag?: string }

export interface Notifier { send(n: Notice): Promise<void>; vapidPublicKey(): string | null }

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
      webpush.setVapidDetails('mailto:hivelane@localhost', this.vapid!.publicKey, this.vapid!.privateKey);
    } catch (e) { log.warn('VAPID 키 준비 실패, 웹 푸시 꺼짐', e); this.vapid = null; }
  }

  vapidPublicKey(): string | null { return this.vapid?.publicKey ?? null; }

  /** 슬랙 「열기」 링크: 원격(Tailscale) 주소가 있으면 그것, 없으면 로컬 */
  private baseUrl(): string { return process.env.HIVELANE_PUBLIC_URL ?? this.store.getKv<string | null>('public_url', null) ?? `http://127.0.0.1:${process.env.HIVELANE_PORT ?? 4310}`; }

  async send(n: Notice): Promise<void> {
    await Promise.allSettled([this.slack(n), this.push(n)]);
  }

  private async slack(n: Notice): Promise<void> {
    const url = this.store.getSettings().slackWebhook;
    if (!url) return;
    const icon = { info: '🐝', warn: '🟠', crit: '🔴', good: '🟢' }[n.level ?? 'info'];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${icon} *${n.title}*\n${toSlack(n.body)}${n.url ? `\n<${this.baseUrl()}${n.url}|열기>` : ''}` }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) log.warn(`슬랙 전송 실패 ${r.status}`);
    } catch (e) { log.warn('슬랙 전송 실패', e); }
  }

  private async push(n: Notice): Promise<void> {
    if (!this.vapid) return;
    const payload = JSON.stringify({ title: `Hivelane · ${n.title}`, body: n.body.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), url: n.url ?? '/', tag: n.tag, level: n.level ?? 'info' });
    for (const s of this.store.pushSubs()) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload, { TTL: 86_400, urgency: 'high' });
        log.info(`푸시 보냄 · ${s.device} · ${n.title}`);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.store.removePushSub(s.endpoint);
        else log.warn('웹 푸시 실패', e);
      }
    }
  }
}

export class NullNotifier implements Notifier {
  sent: Notice[] = [];
  async send(n: Notice): Promise<void> { this.sent.push(n); }
  vapidPublicKey(): string | null { return null; }
}
