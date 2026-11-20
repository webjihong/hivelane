# Hivelane 명세 (완성품 기준)

> 정본 설계안: claude.ai 문서 「로컬 AI 개발팀 오케스트레이터 설계안」(LDpjtu9aYZk1BQn5a3QuaL).
> 이 파일은 구현 기준으로 그 설계안을 고정한 것이다. 둘이 다르면 이 파일을 고치고 설계안에도 반영한다.
> 화면 프로토타입: claude.ai 아티팩트 「AI 팀 관제실」(TBEoRMA773kWFERcDZBue1). UI는 이 화면을 실제 데이터로 구현한다.

## 0. 한 줄

맥 한 대에서 AI 팀 여러 개가 업무를 동시에 처리하고, PO(에이전트+엔진)가 지시·기억·리소스를 지휘하며, 사람은 웹(로컬·Tailscale)에서 지시하고 승인한다.

## 1. 범위

포함: 설계안 전 기능 + 독립 세션 실행 방식 + 같은 역할 여러 명 + 업무별 비용 상한 + 벡터 검색 + 원격 접속(Tailscale)·PWA·웹 푸시 + launchd 상시 실행.
제외: 여러 사람이 함께 쓰기, Claude 외 모델, 클라우드 서버 실행.

## 2. 실행 환경

- 맥에서 직접 실행. 도커 없음. Node ≥ 22, TypeScript, `tsx`로 실행.
- 데이터: `~/.hivelane/` (`HIVELANE_HOME`으로 변경 가능)
  - `hivelane.db` SQLite(WAL), `worktrees/<project>/<task>`, `po/`, `standing/<team>/`, `logs/`, `vapid.json`
- 서버: Hono, `127.0.0.1:4310`(`HIVELANE_PORT`). 빌드된 웹 화면도 같은 서버가 제공.
- 상시 실행: launchd(KeepAlive) + 서버가 `caffeinate -i -w <pid>`로 잠자기 방지.
- 원격: 원격 전용 리스너 `127.0.0.1:4312`(`HIVELANE_REMOTE_PORT`)를 `tailscale serve --bg 4312` 로 연다. funnel 금지. 로컬 4310 은 serve 에 연결하지 않는다.
- 인증: SDK가 맥의 Claude Code 로그인을 그대로 쓴다(API 키 불필요, 확인 2026-11-20).

## 3. 개념

| 개념 | 설명 |
| --- | --- |
| 프로젝트 | 팀이 일할 git 저장소. 경로·기준 ref·의존성 방식·무거운/막을 명령 패턴·참조 메모리·기본 템플릿 |
| 업무(task) | 사용자가 PO에게 준 지시. PO가 brief로 다듬는다 |
| 팀(team) | 업무 하나를 맡은 에이전트 묶음. PO 팀(lifetime=task) 또는 직속 팀(lifetime=standing) |
| 에이전트 | 팀원. 역할(PM·개발·QA·탐색·리뷰어…), 모델(opus/sonnet/haiku), 실행 방식(session/subagent) |
| PO 에이전트 | Claude 세션 하나. 지시 접수·팀 구성 제안·진행 검토·작업 질문 답변. 이벤트 때만 깨어남 |
| PO 엔진 | 코드. 5초마다 리소스 측정, 구간 판정, 시작·멈춤·재개, 무거운 명령 대기열, 강한 멈춤 |

## 4. 팀 실행 방식

- PM은 항상 독립 세션(SDK `query`)이다. cwd = 팀 worktree.
- 역할의 실행 방식
  - subagent: PM 세션의 `agents` 옵션으로 정의. PM이 `Agent` 도구로 부른다. 메시지는 `parent_tool_use_id`, 훅은 `agent_id`/`agent_type`으로 구분.
  - session: 별도 SDK 세션. PM이 MCP 도구 `delegate(role_key, instruction)`로 부르면 그 세션을 이어서(resume) 실행하고 마지막 답을 돌려준다. 기억이 유지된다.
- 같은 역할 여러 명: role_key가 다르면 된다(dev1, dev2). PM은 서로 다른 파일을 맡기도록 지시받는다.
- PM 전용 MCP 도구(`hivelane`): `set_plan`, `check_item`, `set_stage`, `delegate`, `ask_human`, `report`.
  - `ask_human(question, options[])`: 질문 등록, 팀 waiting_human, PM은 턴을 끝낸다. 답은 다음 사용자 메시지로 이어진다.
  - `report(status, summary)`: done/failed. 결과 요약은 work_summaries.
- 턴 루프: query가 끝났는데 report도 ask_human도 없으면 「계속하거나 report」 재촉을 최대 3번, 그 뒤 waiting_human.
- 업무별 예산: `maxBudgetUsd`(설정 기본값, 업무마다 변경). 초과 시 waiting_human(「예산 초과」).
- 권한: `permissionMode: 'dontAsk'` + 역할별 `allowedTools`. `settingSources: ['project','local']`(CLAUDE.md 로드, 사용자 전역 설정은 제외).
- 훅(PreToolUse/PostToolUse/PostToolUseFailure, 메인·서브에이전트 공통)
  - 일시정지 게이트: 멈춤 요청이 있으면 도구를 거부하고 `interrupt()`. 재개는 resume + 「이어서 진행」.
  - 경로 가드: Write/Edit/MultiEdit/NotebookEdit 대상이 worktree 밖이면 거부.
  - 막을 명령: 프로젝트 blocked_patterns(기본: git commit/push/reset --hard/rebase, 운영 배포·DB) 거부.
  - 무거운 명령: heavy_patterns이면 엔진 슬롯을 받을 때까지 대기(직속 팀 우선), 끝나면 반납.
- 강한 멈춤: Claude 프로세스를 `spawnClaudeCodeProcess`로 detached 실행 → 프로세스 그룹에 SIGSTOP/SIGCONT.

## 5. 프로젝트와 worktree

- 등록: 경로가 git 저장소인지 확인(`git rev-parse`). 이름·기준 ref(기본 `origin/<기본 브랜치>`).
- 팀 생성 시: `git fetch` → `git worktree add -b hivelane/<task-id> <worktrees>/<project>/<task-id> <base_ref>` → base_sha 기록.
- 의존성: `symlink`(메인 트리의 node_modules를 하위 디렉토리까지 링크, lock 파일이 다르면 그 디렉토리만 `npm ci`) | `install` | `none`.
- 참조 메모리: `memory_paths`를 additionalDirectories로 읽기 허용 + 프롬프트에 「MEMORY.md를 먼저 읽어라」.
- 변경 수집: 턴이 끝날 때마다 `git diff --numstat <base_sha>` + 새 파일 → file_changes(팀별 스냅샷).
- 정리: 사람이 「worktree 정리」. 브랜치는 남긴다.

## 6. PO 에이전트

- cwd `~/.hivelane/po`, 프로젝트 경로는 additionalDirectories(읽기 도구만).
- MCP 도구: `list_projects`, `list_templates`, `list_teams`, `get_task_status`, `find_changes`, `get_timeline`, `search_records`, `propose_team`, `send_to_team`, `set_priority`, `pause_team`, `resume_team`, `pin_team`.
- 깨우는 사건(po_events): 사용자 메시지, 팀 report, ask_human, 정체(설정 분, 기본 20), 엔진 멈춤·재개, 팀 간 파일 겹침, 예산 초과, 직속 팀 장애.
- 한 번에 하나의 PO 턴만 실행(큐). 맥락이 임계(입력 토큰 150k)를 넘으면 새 세션 + DB 요약으로 시작.
- 팀 구성: `propose_team` → 제안 카드 → 사용자 승인(자동 승인 설정 가능) → 팀 생성.

## 7. PO 엔진 정책 (설정으로 조정)

- 측정 5초: CPU%(os.cpus 차분), 메모리%(vm_stat: active+wired+compressed / 전체), 팀별 CPU·RSS(프로세스 그룹 합).
- 구간: 초록 / 노랑(CPU≥70 또는 MEM≥75, 30초 지속) / 빨강(CPU>85 또는 MEM>85, 30초 지속).
- 초록: 동시 PO 팀 상한(기본 3)까지 대기 팀 시작. 2분 유지 시 멈춘 팀을 우선순위 순으로 하나씩 재개.
- 노랑: 새 팀 시작 안 함. 무거운 명령 슬롯 1.
- 빨강: 우선순위 낮은 순(같으면 리소스 많이 쓰는 순)으로 60초마다 하나씩 부드러운 멈춤. 빨강 2분 지속 시 강한 멈춤. 직속 팀·고정 팀 제외(MEM≥95면 고정 팀도 멈춤).
- 무거운 명령 슬롯: 초록 2 / 노랑 1 / 빨강 0(직속 팀은 1 보장).
- 모든 조치 → po_decisions + po_events + SSE.

## 8. 직속 팀

- 사용자가 만든다: 이름, 프로젝트(선택), 템플릿, 상시 지시서, 점검 명령(선택)+주기.
- 평소 대기(턴 없음). 사용자 메시지·점검 이상 시 깨어난다.
- 점검: 엔진이 쉘 명령 실행(타임아웃 60초). 종료 코드≠0이면 출력과 함께 팀을 깨운다(토큰은 이상 때만).
- 되살리기: 실행 중 query가 오류로 끝나면 resume 재시도(3회) → 실패 시 새 세션(지시서+최근 요약). 매번 슬랙·푸시 알림.
- 기록 범위: 자기 팀 + 사용자가 허용한 팀.

## 9. 기록과 검색

- 테이블: settings, projects, team_templates, tasks, proposals, teams, agents, messages, agent_events, runs, file_changes, work_summaries, search_fts(FTS5 trigram), search_vec(선택), resource_samples, po_events, po_decisions, po_chat, push_subscriptions, checklist.
- 모든 기록에 project_id·task_id·team_id.
- 검색: 조회 도구 우선 → FTS5 → 벡터(Ollama 또는 Voyage 설정 시, 없으면 꺼짐).

## 10. 원격 접속·알림

- 로컬(4310 리스너): 모든 권한. 원격(4312 리스너): `Tailscale-User-Login` 이 주인 계정이어야 함(헤더 없는 태그 기기는 거부).
- 모든 API: Host 허용 목록(리바인딩 차단). 변경 요청: `Content-Type: application/json` + `X-Hivelane: 1` + Origin 일치(CSRF 차단).
- Tailscale(`Tailscale-User-Login` 헤더): 설정의 owner_login과 같아야 함. 원격 제한: 템플릿·설정·프로젝트 변경·worktree 정리 불가. 팀 구성 승인은 확인 단계 1번 더.
- PWA(manifest + service worker), 웹 푸시(VAPID, `web-push`). 슬랙 웹훅(설정).
- 알림 사건: 사람 확인 필요, 팀 완료·실패, 예산 초과, 직속 팀 장애·복구.

## 11. 화면

프로토타입과 같다: 상단(리소스·구간·재현 대신 실제 상태), 업무(조치 필요·현황판 필터·상시 설비·요약/라인 보기), 팀 상세(작업장 로봇·말풍선·대화·할 일·파일·결정·직접 지시/답변·diff), 에이전트 서랍(스트림·토큰·프롬프트), PO 대화창(제안 카드 승인·수정), 템플릿, 설정(엔진·프로젝트·직속 팀·알림·원격), 모바일 하단 탭바.

## 12. 품질 기준

- 서버 재시작 후 진행 중 팀 자동 이어가기.
- 오류는 화면에 이유와 함께. 서버 로그 `~/.hivelane/logs/server.log`.
- 단위 테스트: 엔진 정책, 대기열, 경로·명령 가드, 인증, worktree, 저장소, 검색, 오케스트레이터(가짜 러너).
- 실제 E2E: 연습 저장소에서 Haiku 팀이 버그 수정 → QA → report, 질문·답변, 멈춤·재개.
