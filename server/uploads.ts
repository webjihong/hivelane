import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { st } from './i18n.ts';

/** 사람이 붙여 넣은 이미지. ~/.hivelane/uploads/<id>.<ext> 에 저장하고, 에이전트는 Read 도구로 본다. */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ID = /^u-[a-z0-9]{12}\.(png|jpg|gif|webp)$/;

export function saveUpload(cfg: AppConfig, type: string, base64: string): string {
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new Error(st('이미지(png·jpg·gif·webp)만 올릴 수 있습니다'));
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new Error(st('빈 파일입니다'));
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error(st('이미지는 10MB 까지입니다'));
  mkdirSync(cfg.uploadsDir, { recursive: true });
  const id = `u-${randomBytes(6).toString('hex')}.${ext}`;
  writeFileSync(join(cfg.uploadsDir, id), buf);
  return id;
}

export function readUpload(cfg: AppConfig, id: string): { buf: Buffer; type: string } | null {
  if (!ID.test(id)) return null;
  const p = join(cfg.uploadsDir, id);
  if (!existsSync(p)) return null;
  const ext = id.split('.').pop()!;
  const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)![0];
  return { buf: readFileSync(p), type };
}

/** 화면용 표기 ![이름](/api/uploads/<id>) → 에이전트가 읽을 안내(절대 경로 + Read 도구). */
export function forAgent(cfg: AppConfig, text: string): string {
  return text.replace(/!\[([^\]]*)\]\(\/api\/uploads\/(u-[a-z0-9]{12}\.(?:png|jpg|gif|webp))\)/g, (_m, name: string, id: string) =>
    `[첨부 이미지${name ? ` ${name}` : ''}: ${join(cfg.uploadsDir, id)} — Read 도구로 열어서 보고 답에 반영해라]`);
}
