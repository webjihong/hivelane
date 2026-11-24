# Hivelane 명세 (완성품 기준)

> 구현 기준 명세입니다. 동작을 바꾸면 이 파일도 함께 고칩니다.

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
- 업무별 예산: `maxBudgetUsd`(설정 기본값, 기본 무제한=null, 업무마다 변경). 상한이 있을 때 초과 시 waiting_human(「예산 초과」).
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
- git 권한(프로젝트별 `git_mode`): `none`(기본, 커밋·푸시·PR 막음) | `push`(커밋·일반 푸시·fetch/pull·PR 만들기 허용). `push` 에서도 보호 브랜치(`protected_branches`, 기본 prod·main·master) 직접 푸시, 강제·삭제 푸시(`-f`·`--force*`·`--delete`·`+refspec`), `gh pr merge/close`, 저장소·릴리스 조작, update-ref·worktree 조작은 막는다. 팀·역할 지시문의 git 규칙도 프로젝트 설정을 따른다.

## 6. PO 에이전트

- cwd `~/.hivelane/po`, 프로젝트 경로는 additionalDirectories(읽기 도구만).
- MCP 도구: `list_projects`, `list_templates`, `list_teams`, `get_task_status`, `find_changes`, `get_timeline`, `search_records`, `propose_team`, `system_status`, `send_to_team`, `set_priority`, `pause_team`, `resume_team`, `pin_team`.
- 맥 진단: `system_status`(CPU·메모리, 출처별 합계 = 가까운 Claude Code 세션·앱·Hivelane 팀, 상위 프로세스, 작업 디렉토리) + 진단용 Bash. Bash 는 기본 막을 명령 + `kill/pkill/killall`·launchctl 변경·설치·tailscale 변경·`defaults write` 금지, 쓰기는 PO 폴더만, 무거운 명령은 슬롯 대기.
- 프롬프트에 Hivelane 사용법(프로젝트·직속 팀·설정 위치)을 넣어 사용자 질문에 직접 안내한다.
- 학습(po_knowledge): 사용자가 「배워」「기억해」「잊어」라고 하면 PO 가 `learn`/`recall`/`forget` 으로 관리. skill = 해 보고 확인한 절차(프롬프트엔 이름·언제만, 본문은 recall), note = 늘 기억할 사실(프롬프트에 본문, 6000자 상한). 검색 색인에도 들어간다. 학습은 권한·막힌 명령을 넓히지 못한다. 화면: PO 대화창 「배운 것」(보기·고치기·지우기). PO 는 WebFetch·WebSearch 로 문서를 읽어 배울 수 있다.
- 자기 개선: 코드가 필요한 기능은 프로젝트 「Hivelane」에 개발팀을 제안한다. 반영(병합·재시작)은 사람.
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
- 외부 부하: 빨강이 CPU 때문만이고(메모리 정상) Hivelane 팀 CPU 몫이 25% 미만이면 멈추지 않는다(새 팀만 대기). 이미 엔진이 멈춘 팀도 resumeSec 간격으로 하나씩 재개. 팀 프로세스를 잴 수 없으면 예전대로.
- 사람이 직접 재개한 팀은 15분 동안 자동 멈춤 대상에서 빠진다(MEM≥95 제외).
- 엔진이 멈춘 팀은 「조치 필요」에 올리지 않는다(리소스 회복 시 자동 재개). 사람이 멈춘 팀만 올린다.
- 모든 조치 → po_decisions + po_events + SSE.

## 8. 직속 팀

- 사용자가 만든다(설정 화면, 또는 PO 에게 시키면 `create_standing_team` 으로 바로 생성 · 사용자 메시지가 있는 PO 턴에서만): 이름, 프로젝트(선택), 템플릿, 상시 지시서, 점검 명령(선택)+주기.
- 종료: 사용자가 화면에서 「직속 팀 종료」 하거나, 사용자가 PO 에게 끝내라고 할 때만(`end_standing_team`, 사용자 턴에서만). 그 밖에는 유지: 일이 끝나면 대기, 오류는 되살리기, 되살리기 실패(down)는 엔진이 2·5·15분 뒤, 이후 30분마다 계속 재시도. PO 의 전달(send_to_team)은 직속 팀을 바로 깨운다.
- 평소 대기(턴 없음). 사용자 메시지·점검 이상 시 깨어난다.
- 점검: 엔진이 쉘 명령 실행(타임아웃 60초). 종료 코드≠0이면 출력과 함께 팀을 깨운다(토큰은 이상 때만).
- 되살리기: 실행 중 query가 오류로 끝나면 resume 재시도(3회) → 실패 시 새 세션(지시서+최근 요약). 매번 슬랙·푸시 알림.
- 기록 범위: 자기 팀 + 사용자가 허용한 팀.
- 작업 환경(팀별 `env_mode`, 모든 팀 공통): `isolated`(기본, 저장소 규칙만) | `mine`(사용자 전역 설정·플러그인·스킬·MCP 로드(settingSources user), 역할 도구 제한 해제, 가드 통과 도구는 허용, 프로젝트 메모리 폴더 쓰기). `mine` 에서 운영 명령(db:prod·prod:sync·--profile <운영 프로필>·terraform apply/destroy·npm publish)은 막는 대신 `request_approval` → 사람 「승인」 → 그 명령 그대로 한 번만 실행. sudo·rm -rf /·git 보호 규칙은 그대로.

## 9. 기록과 검색

- 테이블: settings, projects, team_templates, tasks, proposals, teams, agents, messages, agent_events, runs, file_changes, work_summaries, search_fts(FTS5 trigram), search_vec(선택), resource_samples, po_events, po_decisions, po_chat, push_subscriptions, checklist.
- 모든 기록에 project_id·task_id·team_id.
- 검색: 조회 도구 우선 → FTS5 → 벡터(Ollama 또는 Voyage 설정 시, 없으면 꺼짐).

## 10. 원격 접속·알림

- 로컬(4310 리스너): 모든 권한. 원격(4312 리스너): `Tailscale-User-Login` 이 주인 계정이어야 함(헤더 없는 태그 기기는 거부).
- 모든 API: Host 허용 목록(리바인딩 차단). 변경 요청: `Content-Type: application/json` + `X-Hivelane: 1` + Origin 일치(CSRF 차단).
- Tailscale(`Tailscale-User-Login` 헤더): 설정의 owner_login과 같아야 함. 원격 제한: 템플릿·설정·프로젝트 변경·worktree 정리 불가. 팀 구성 승인은 확인 단계 1번 더.
- PWA(manifest + service worker), 웹 푸시(VAPID, `web-push`). 슬랙 웹훅(설정).
- 알림 사건: 사람 확인 필요, 팀 완료·실패, 직속 팀 답변, PO 답변(사용자 메시지에 대한), 예산 초과, 직속 팀 장애·복구, 읽지 않은 답변 다시 알림(설정 간격, 기본 30분, 0=끔).
- 읽음: 팀별·PO 마지막 본 id(kv `seen:*`). 팀 화면·PO 대화창이 실제로 보일 때 읽음 처리. 안 읽은 수는 목록 배지·조치 필요·하단 탭·탭 제목·앱 배지. 처음 켤 때 옛 기록은 읽음으로.

## 10-1. PR

- 등록된 저장소마다 `gh pr list`(2분마다, 화면에서 새로고침 가능): 열린 PR + 3일 안에 병합·닫힌 PR. 상태·초안·검사·리뷰·작성자, 누르면 GitHub PR 로 이동.
- 누르면 펼침: 검사 하나하나(상태·로그 링크), 리뷰, 병합 가능 상태(mergeStateStatus·충돌). 열린 PR 은 병합 방식(병합 커밋·스쿼시·리베이스) 고르고 확인 후 `gh pr merge` — 원격(휴대폰)에서도 가능. 보호 규칙·충돌은 gh 가 거절하고 그 이유를 보여 준다.
- 팀 연결: head 브랜치가 팀 브랜치이거나 팀 기록에 PR 주소가 있으면. 팀이 만든 PR 이 새로 생기거나 병합·닫히면 알림(슬랙은 PR 링크).

## 11. 화면 (메신저형, 11-23 개편)

- 왼쪽 채널 목록(어두운 칸): 「지금 볼 것 N」 → PO → 직속 팀(＋) → 업무 팀(끝난 팀 접기) → PR(열린 것, GitHub 링크). 채널마다 상태 점(초록 깜빡임 일하는 중 · 빨강 결정/실패/장애 · 노란 원 멈춤 · 점선 대기열 · 회색 대기)과 짧은 상태(구현 2/4 · 결정 · 멈춤…), 안 읽은 수. 로고 옆 설정 아이콘(설정·팀 템플릿 탭). 맨 아래 한 줄 리소스(구간 배지·CPU·메모리 막대, 누르면 출처별 진단).
- 가운데: 「지금 볼 것」 대시보드(숫자 4칸 · 내 답이 필요함 · 새 소식 · 일하는 중 · 열린 PR · 모두 읽음으로) / PO 채널 / 팀 채널(대화형: 내 지시는 오른쪽, PM·PO 는 왼쪽, 팀원 사이 맡김·보고는 접힌 한 줄, 질문·승인 요청은 입력칸 위 카드) / 「팀 상세」 옆 칸(할 일·바뀐 파일·결정 기록·작업장·상시 지시서·작업 환경·PR·관리 버튼).
- 휴대폰: 첫 화면은 채널 목록, 채널을 누르면 전체 화면 대화, 하단 탭 대화·PR·설정.
- 팀 템플릿: 프로젝트 기본 템플릿만 펼치고 나머지는 한 줄 요약(펼침 상태는 기기에 기억).

## 12. 품질 기준

- 서버 재시작 후 진행 중 팀 자동 이어가기.
- 오류는 화면에 이유와 함께. 서버 로그 `~/.hivelane/logs/server.log`.
- 단위 테스트: 엔진 정책, 대기열, 경로·명령 가드, 인증, worktree, 저장소, 검색, 오케스트레이터(가짜 러너).
- 실제 E2E: 연습 저장소에서 Haiku 팀이 버그 수정 → QA → report, 질문·답변, 멈춤·재개.
