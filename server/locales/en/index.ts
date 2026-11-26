/** 서버 글 영어 사전: 파일마다 나눠 두고 여기서 합친다 */
import accounts from './accounts.ts';
import agents from './agents.ts';
import backup from './backup.ts';
import common from './common.ts';
import engine from './engine.ts';
import http from './http.ts';
import misc from './misc.ts';
import notify from './notify.ts';
import orchestrator from './orchestrator.ts';
import po from './po.ts';
import projects from './projects.ts';

export const SERVER_EN: Record<string, string> = { ...common, ...orchestrator, ...http, ...po, ...engine, ...agents, ...notify, ...projects, ...backup, ...accounts, ...misc };
