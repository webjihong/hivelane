# Hivelane

맥 한 대에서 **AI 개발팀 여러 개**를 동시에 돌리는 관제실.
사용자는 PO에게 지시하고, PO가 팀(PM·개발·QA…)을 꾸려 맡기고, PO 엔진이 맥의 CPU·메모리를 보며 팀을 멈추고 재개한다.
진행 상황은 웹 화면(맥·휴대폰)에서 공장 생산 라인처럼 본다.

- PO 에이전트(Claude 세션): 지시 접수 · 팀 구성 제안 · 모든 작업 질문에 기록으로 답변 · 사건 때만 깨어남
- PO 엔진(코드): 5초마다 리소스 측정 · 초록/노랑/빨강 구간 · 시작·부드러운/강한 멈춤·재개 · 무거운 명령(테스트·빌드) 대기열
- 팀: PM(항상 독립 세션) + 역할별 서브에이전트/독립 세션 · 업무마다 git worktree · 커밋·푸시·운영 명령 차단
- 직속 팀: 사용자가 직접 지시하는 상시 팀(서버 점검·긴급 대응) · 점검 명령 · 죽으면 되살리기
- 기록: 모든 대화·도구 실행·바뀐 파일·요약을 SQLite에 · FTS5(한국어 trigram) + 선택적 벡터 검색

자세한 명세: [`docs/SPEC.md`](docs/SPEC.md)

## 준비물

- macOS, Node 22 이상(개발은 26), git
- Claude Code 로그인(이 맥에서 `claude` 가 동작하면 된다. API 키 불필요)
- (원격) Tailscale + 관리 콘솔에서 HTTPS Certificates 켜기

## 설치·실행

```bash
cd ~/Desktop/jobs/hivelane
npm install
npm run service:install      # 화면 빌드 → launchd 상시 실행 → tailscale serve
open http://127.0.0.1:4310
```

- 상태: `npm run service:status` · 다시 시작: `npm run service:restart` · 해제: `npm run service:uninstall`
- 데이터: `~/.hivelane/` (DB, worktree, 로그). 해제해도 데이터는 남는다.
- 로그: `~/.hivelane/logs/server.log`

### 처음 할 일

1. 설정 › 프로젝트: 저장소 경로 등록(예: `~/code/my-app`). 기준 브랜치·메모리 경로는 자동으로 채워진다.
2. (원격) 설정 › 원격 접속: 휴대폰으로 한 번 열어 보면 「마지막 원격 시도」에 계정이 뜬다 → 주인으로 등록.
3. (알림) 설정 › 알림: 슬랙 웹훅, 휴대폰에서 「웹 푸시 켜기」.
4. PO 대화창에 지시 → 제안 카드 확인·수정 → 승인.

## 개발

```bash
npm run dev          # 서버(4310, tsx watch) + 화면(4311, Vite)
npm test             # 단위 테스트
npm run typecheck
npm run e2e          # 실제 Claude(Haiku)로 팀 한 번 돌려 보기 (연습 저장소, 몇 센트)
npx tsx scripts/e2e-po.ts      # PO: 지시 → 제안 → 완료 → 질문 답변
npx tsx scripts/e2e-pause.ts   # 멈춤·재개
```

개발 중에는 `HIVELANE_HOME=/tmp/hl-dev` 처럼 따로 데이터 폴더를 쓰면 실제 데이터와 섞이지 않는다.

## 구조

```
server/
  index.ts            부팅·종료·caffeinate
  store.ts            SQLite 접근(모든 기록)
  agents/runner.ts    Agent SDK 한 턴 실행 + 훅(가드·대기열·일시정지) + 기록
  agents/guard.ts     경로·명령 가드, 무거운 명령 판별
  teams/orchestrator  팀 생성·시작·PM 턴 루프·질문/답변·멈춤/재개·직속 팀·복구
  teams/tools.ts      PM 전용 MCP 도구(set_plan·ask_human·report·delegate…)
  po/agent.ts         PO 에이전트 + PO MCP 도구(조회·검색·제안·팀 조작)
  po/engine.ts        PO 엔진(측정·결정 실행·정체·생존 확인·점검)
  po/policy.ts        구간 판정·조치 결정(순수 함수)
  projects/git.ts     worktree·의존성 링크·변경 수집·diff
  search/index.ts     FTS5 + sqlite-vec
  http/app.ts         REST·SSE·접근 제어
web/                  React 화면(공장 라인·작업장 로봇·PO 대화·설정), PWA
shared/types.ts       서버·화면 공용 타입
```

## 안전장치

- 팀은 자기 worktree 밖에 쓸 수 없다(쓰기 도구·리다이렉션 가드).
- 커밋·푸시·reset·rebase·worktree 조작·운영 DB/배포·sudo 등은 막는다(프로젝트별로 수정 가능). 병합은 사람이 한다.
- 원격(Tailscale)은 주인 계정만, 설정·템플릿·프로젝트 변경과 worktree 정리는 맥에서만.
- 업무마다 비용 상한(기본 $20). 넘으면 사람에게 묻는다.
