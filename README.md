# Hivelane

맥 한 대에서 **AI 개발팀 여러 개**를 동시에 돌리는 관제실입니다.
총괄에게 일을 말하면 총괄이 팀(PM·개발·QA…)을 꾸려 맡기고, 총괄 엔진이 맥의 CPU·메모리를 보며 팀을 멈추고 다시 돌립니다.
진행 상황은 메신저처럼 생긴 웹 화면에서 맥과 휴대폰으로 봅니다.

> *Hivelane is a local orchestrator that runs several Claude Code agent teams on one Mac, with a lead agent ("총괄") that plans and a resource engine that pauses/resumes teams. The UI is in Korean.*

## 무엇을 하나

- **총괄 에이전트**: 지시를 받아 팀 구성을 제안하고, 진행을 보고, 작업 질문에 기록을 찾아 답합니다. git 정리·맥 진단도 맡깁니다.
- **총괄 엔진**: 5초마다 CPU·메모리를 재고 초록/노랑/빨강 구간에 맞춰 팀을 시작·멈춤·재개합니다. 테스트·빌드 같은 무거운 명령은 대기열로 돌립니다.
- **업무 팀**: PM과 역할별 팀원이 업무마다 따로 만든 git worktree에서 일합니다. 커밋·푸시·운영 명령은 기본으로 막혀 있습니다.
- **직속 팀**: 서버 점검·긴급 대응처럼 늘 대기하며 바로 지시받는 팀입니다. 죽으면 스스로 되살아납니다.
- **PR·저장소·스크립트**: 열린 PR의 검사·리뷰를 보고 병합하고, 저장소 상태를 보고, 자주 쓰는 터미널 명령을 버튼으로 실행합니다(휴대폰에서도).
- **기록**: 대화·도구 실행·바뀐 파일·요약을 모두 SQLite에 남기고 검색합니다.
- **사이드바 상태줄**: CPU·메모리, Claude 플랜 토큰 사용량(n% 사용 중 · 초기화 요일), 로그인 만료일과 재인증.

## 문서

- [설치 가이드](docs/INSTALL.md): 준비물, 설치, 상시 실행, 휴대폰(Tailscale), 업데이트·제거, 문제 해결
- [사용 가이드](docs/GUIDE.md): 화면 구성, 총괄에게 일 맡기기, 팀 채널, PR·스크립트, 설정, 안전장치
- [명세](docs/SPEC.md): 설계와 동작 규칙(개발자용)

## 빠른 시작

```bash
git clone https://github.com/webjihong/hivelane.git
cd hivelane
npm install
npm run service:install   # 화면 빌드 → launchd 상시 실행 → (있으면) tailscale serve
open http://127.0.0.1:4310
```

준비물: macOS, Node 22 이상, git, 로그인된 Claude Code(`claude` 명령이 동작하면 됨, API 키 불필요). 자세한 내용은 [설치 가이드](docs/INSTALL.md).

### 맥 앱(DMG)

```bash
npm run desktop     # 개발: 앱 창으로 띄우기(떠 있는 서버에 붙음)
npm run dist:mac    # 서명 없는 Apple 실리콘용 DMG → dist/desktop/Hivelane-<버전>-arm64.dmg
```

- 앱 안에 Node·서버·화면이 모두 들어 있어 받는 사람은 Node를 설치하지 않아도 됩니다(git·Claude 계정은 필요).
- 처음 열면 안내 화면에서 git·Tailscale을 확인하고 「서버 설치하고 시작」으로 서버를 launchd에 등록합니다. 앱 창을 닫거나 앱을 꺼도 서버(팀)는 계속 돕니다. 메뉴 막대 아이콘에서 열기·재시작·기록 폴더·서버 끄기.
- 이미 `npm run service:install`로 서버가 떠 있으면 앱은 그 서버에 붙기만 합니다.
- 서명하지 않은 앱이라 처음 열 때 막히면: 시스템 설정 › 개인정보 보호 및 보안 › 「그래도 열기」.

## ⚠️ 먼저 알아 둘 것

- Hivelane은 **AI 에이전트가 내 맥에서 파일을 고치고 명령을 실행**하게 하는 도구입니다. 가드(작업 폴더 밖 쓰기 금지, 위험 명령 차단)가 있지만 완벽하지 않습니다. 중요한 저장소는 백업하고, 막을 명령 목록을 프로젝트에 맞게 확인하세요.
- 팀은 내 Claude 구독(또는 계정) 사용량을 씁니다. 업무마다 비용 상한을 둘 수 있습니다.
- 원격 접속은 Tailscale 내 tailnet 안에서만(funnel 아님), 등록한 주인 계정만 허용합니다. 인터넷에 직접 열지 마세요.

## 개발

```bash
npm run dev          # 서버(4310, tsx watch) + 화면(4311, Vite)
npm test             # 단위 테스트(vitest)
npm run typecheck
npm run e2e          # 실제 Claude(Haiku)로 연습 저장소에서 팀 한 번 돌려 보기(몇 센트)
```

개발할 때는 `HIVELANE_HOME=/tmp/hl-dev npm run dev` 처럼 데이터 폴더를 따로 쓰면 실제 데이터와 섞이지 않습니다.

## 구조

```
server/
  index.ts            부팅·종료·잠자기 방지
  store.ts            SQLite 접근(모든 기록)
  agents/             Agent SDK 실행(runner) · 경로·명령 가드 · 역할 지시문
  teams/              팀 생성·PM 턴 루프·질문/답변·멈춤/재개·직속 팀·복구 · PM 전용 도구
  po/                 총괄 에이전트·도구 · 엔진(측정·정책) · 무거운 명령 슬롯 · 플랜 사용량 · 재인증
  projects/           worktree·PR·저장소 상태·git 정리
  scripts.ts          스크립트 버튼 실행
  search/             FTS5(한국어 trigram) + 선택적 벡터 검색
  http/app.ts         REST·SSE·접근 제어
web/src/              React 화면(채널 목록·지금 볼 것·총괄·팀 채널·PR·스크립트·설정), PWA
shared/types.ts       서버·화면 공용 타입
```

## 라이선스

[MIT](LICENSE)
