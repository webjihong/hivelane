import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPendingRestore, BackupManager, scheduleTimes, type SecretStore } from '../server/backup/index.ts';
import { parseDavList, parseS3List, S3Target, signS3, WebDavTarget } from '../server/backup/targets.ts';
import { openDb } from '../server/db/index.ts';
import { Store } from '../server/store.ts';
import { testEnv, tmp } from './helpers.ts';

const memSecrets = (): SecretStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, async get(id) { return m.get(id) ?? null; }, async set(id, v) { m.set(id, v); }, async del(id) { m.delete(id); } };
};

function setup() {
  const { cfg, store } = testEnv();
  const dir = tmp('hl-bk-');
  const secrets = memSecrets();
  let exited = 0;
  const bm = new BackupManager({ cfg, store, onChange: () => {}, secrets, exit: () => { exited++; } });
  return { cfg, store, dir, bm, secrets, exited: () => exited };
}

describe('백업', () => {
  it('이 맥 폴더로 백업 → 목록 → 열어 보기(읽기 전용)로 그때 팀 대화 확인 · 보관 개수 넘으면 오래된 것 지움', async () => {
    const { cfg, store, dir, bm } = setup();
    const team = store.db.prepare("INSERT INTO teams (id, name, state, created_at, updated_at) VALUES ('t1', '옛 팀', 'done', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z') RETURNING id").get() as { id: string };
    store.addMessage({ team_id: team.id, from_label: '사용자', to_label: 'PM', kind: 'instruction', body: '예전 지시: 로그인 고쳐' });
    writeFileSync(join(cfg.uploadsDir, 'u-1.png'), 'img');
    await bm.saveConfig({ keep: 2, targets: [{ id: 'loc', type: 'local', name: '맥 폴더', enabled: true, path: dir }] });

    const r = await bm.backupNow();
    expect(r.ok).toBe(true);
    expect(r.size).toBeGreaterThan(0);
    const { items } = await bm.list();
    expect(items.map((i) => i.name)).toEqual([r.file]);

    // 지금 기록은 바뀌어도 백업 안은 그대로
    store.db.prepare("UPDATE teams SET name = '바뀐 팀' WHERE id = 't1'").run();
    const vid = await bm.open('loc', r.file!);
    expect(bm.viewTeams(vid).map((t) => t.name)).toEqual(['옛 팀']);
    expect(bm.viewTeams(vid, '로그인')).toHaveLength(1);
    expect(bm.viewTeam(vid, 't1').messages).toEqual([expect.objectContaining({ body: '예전 지시: 로그인 고쳐' })]);
    bm.close(vid);

    // 보관 2개: 세 번째를 만들면 가장 오래된 것이 지워진다(파일 이름은 초 단위라 1초씩 띄움)
    await new Promise((res) => setTimeout(res, 1100)); await bm.backupNow();
    await new Promise((res) => setTimeout(res, 1100)); await bm.backupNow();
    const after = (await bm.list()).items.map((i) => i.name);
    expect(after).toHaveLength(2);
    expect(after).not.toContain(r.file);
  }, 20_000);

  it('주기: 바뀐 게 없으면 건너뜀 · 켜진 저장소가 없으면 실패로 남김 · 지운 저장소의 비밀값도 지움', async () => {
    const { dir, bm, secrets } = setup();
    expect((await bm.backupNow('schedule')).error).toContain('저장소가 없습니다');
    await bm.saveConfig({ targets: [{ id: 'loc', type: 'local', name: '맥', enabled: true, path: dir }, { id: 'dav', type: 'webdav', name: 'NAS', enabled: false, url: 'https://nas.local/backup' }] }, { dav: 'pw' });
    expect(secrets.m.get('dav')).toBe('pw');
    expect((await bm.backupNow('schedule')).skipped).toBeUndefined();
    expect((await bm.backupNow('schedule')).skipped).toBe(true);
    expect((await bm.backupNow('manual')).skipped).toBeUndefined(); // 직접 누르면 늘 만든다
    await bm.saveConfig({ targets: [{ id: 'loc', type: 'local', name: '맥', enabled: true, path: dir }] });
    expect(secrets.m.has('dav')).toBe(false);
  }, 20_000);

  it('예정 시각: 매일 03:00 · 매주 월요일 · 끄기 · 30분/6시간마다', () => {
    const now = new Date(2026, 10, 26, 10, 0); // 목요일 10:00
    const d = scheduleTimes({ mode: 'daily', time: '03:00', weekday: 1, everyMin: 60 }, now);
    expect(d.lastDue?.getDate()).toBe(26); expect(d.next?.getDate()).toBe(27);
    const early = scheduleTimes({ mode: 'daily', time: '23:00', weekday: 1, everyMin: 60 }, now);
    expect(early.lastDue?.getDate()).toBe(25);
    const w = scheduleTimes({ mode: 'weekly', time: '03:00', weekday: 1, everyMin: 60 }, now);
    expect(w.lastDue?.getDay()).toBe(1); expect(w.lastDue?.getDate()).toBe(23); expect(w.next?.getDate()).toBe(30);
    expect(scheduleTimes({ mode: 'off', time: '03:00', weekday: 1, everyMin: 60 }, now)).toEqual({ lastDue: null, next: null });
    // 30분마다: 10:00 → 지난 예정 10:00, 다음 10:30 · 10:47 → 10:30 / 11:00
    const h = scheduleTimes({ mode: 'interval', time: '03:00', weekday: 1, everyMin: 30 }, new Date(2026, 10, 26, 10, 47));
    expect([h.lastDue?.getHours(), h.lastDue?.getMinutes(), h.next?.getHours(), h.next?.getMinutes()]).toEqual([10, 30, 11, 0]);
    // 6시간마다: 0·6·12·18시
    const six = scheduleTimes({ mode: 'interval', time: '03:00', weekday: 1, everyMin: 360 }, new Date(2026, 10, 26, 13, 5));
    expect([six.lastDue?.getHours(), six.next?.getHours()]).toEqual([12, 18]);
    // 하루가 나누어떨어지지 않으면 다음 예정은 자정에서 다시 맞춤(7시간: 21시 → 다음은 자정)
    const seven = scheduleTimes({ mode: 'interval', time: '03:00', weekday: 1, everyMin: 420 }, new Date(2026, 10, 26, 22, 0));
    expect([seven.lastDue?.getHours(), seven.next?.getDate(), seven.next?.getHours()]).toEqual([21, 27, 0]);
  });

  it('복구: 직전 상태를 먼저 백업하고 풀어 둔 뒤 다시 시작 → 시작할 때 바꿔 끼움(지금 DB 는 restored-old 로)', async () => {
    const { cfg, store, dir, bm, exited } = setup();
    store.addMessage({ team_id: null, from_label: '사용자', kind: 'instruction', body: '백업 시점 기록' });
    await bm.saveConfig({ targets: [{ id: 'loc', type: 'local', name: '맥', enabled: true, path: dir }] });
    const r = await bm.backupNow();
    store.addMessage({ team_id: null, from_label: '사용자', kind: 'instruction', body: '백업 뒤 기록' });
    await new Promise((res) => setTimeout(res, 1100));
    const out = await bm.restore('loc', r.file!);
    expect(out.before.file).toContain('before-restore');
    await new Promise((res) => setTimeout(res, 1600));
    expect(exited()).toBe(1);
    store.db.close();
    expect(applyPendingRestore(cfg)).toContain(r.file!);
    const restored = new Store(openDb(cfg.dbPath));
    const bodies = (restored.db.prepare('SELECT body FROM messages').all() as { body: string }[]).map((m) => m.body);
    expect(bodies).toContain('백업 시점 기록');
    expect(bodies).not.toContain('백업 뒤 기록');
    expect(applyPendingRestore(cfg)).toBeNull();
  }, 20_000);

  it('NAS 폴더가 연결돼 있지 않으면 알아듣게 실패', async () => {
    const { bm } = setup();
    const t = await bm.test({ id: 'x', type: 'local', name: 'NAS', enabled: true, path: '/Volumes/없는-NAS-hivelane/backup' });
    expect(t.ok).toBe(false);
    expect(t.error).toContain('NAS 폴더가 연결돼 있지 않습니다');
  });
});

describe('백업 저장소(WebDAV·S3)', () => {
  it('WebDAV: 올리기·목록·지우기(가짜 서버)', async () => {
    const files = new Map<string, Buffer>();
    const fake = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u); const m = init?.method ?? 'GET';
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`);
      if (m === 'MKCOL') return new Response('', { status: 405 });
      if (m === 'PUT') { files.set(url.split('/').pop()!, Buffer.from(init!.body as Buffer)); return new Response('', { status: 201 }); }
      if (m === 'DELETE') { files.delete(url.split('/').pop()!); return new Response(null, { status: 204 }); }
      if (m === 'PROPFIND') return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/backup/</D:href></D:response>${[...files.entries()].map(([n, b]) => `<D:response><D:href>/backup/${n}</D:href><D:propstat><D:prop><D:getcontentlength>${b.length}</D:getcontentlength><D:getlastmodified>Wed, 26 Nov 2026 03:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>`).join('')}</D:multistatus>`, { status: 207 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const dav = new WebDavTarget('https://nas.local:5006/backup/', 'me', 'pw', fake);
    const f = join(tmp('hl-dav-'), 'x'); writeFileSync(f, 'abc');
    await dav.put('hivelane-backup-20261126-030000.tar.gz', f);
    expect(await dav.list()).toEqual([{ name: 'hivelane-backup-20261126-030000.tar.gz', size: 3, at: '2026-11-26T03:00:00.000Z' }]);
    await dav.del('hivelane-backup-20261126-030000.tar.gz');
    expect(await dav.list()).toEqual([]);
    await expect(dav.put('../etc/passwd', f)).rejects.toThrow('이름');
  });

  it('S3: 서명 헤더 모양 · 호환 저장소는 경로 방식 주소 · 목록 해석', async () => {
    const h = signS3({ method: 'GET', url: new URL('https://b.s3.ap-northeast-2.amazonaws.com/?list-type=2&prefix=x'), region: 'ap-northeast-2', accessKeyId: 'AKIDEXAMPLE', secret: 's', payloadHash: 'e3b0', now: new Date('2026-11-26T03:00:00Z') });
    expect(h['x-amz-date']).toBe('20261126T030000Z');
    expect(h.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261126\/ap-northeast-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const urls: string[] = [];
    const fake = (async (u: string | URL) => { urls.push(String(u)); return new Response('<ListBucketResult><Contents><Key>hl/hivelane-backup-20261126-030000.tar.gz</Key><Size>10</Size><LastModified>2026-11-26T03:00:01.000Z</LastModified></Contents><Contents><Key>hl/other.txt</Key><Size>1</Size></Contents></ListBucketResult>'); }) as typeof fetch;
    const s3 = new S3Target({ bucket: 'bk', region: 'us-east-1', endpoint: 'https://nas.local:9000', prefix: 'hl', accessKeyId: 'a', secret: 's' }, fake);
    expect(await s3.list()).toEqual([{ name: 'hivelane-backup-20261126-030000.tar.gz', size: 10, at: '2026-11-26T03:00:01.000Z' }]);
    expect(urls[0]).toBe('https://nas.local:9000/bk/?list-type=2&prefix=hl%2Fhivelane-backup-');
    expect(parseS3List('<Contents><Key>hivelane-backup-20261126-030000-before-restore.tar.gz</Key><Size>5</Size></Contents>', '')[0]!.name).toContain('before-restore');
    expect(parseDavList('<response><href>/a/b.txt</href></response>')).toEqual([]);
  });
});


