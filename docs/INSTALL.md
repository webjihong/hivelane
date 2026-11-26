# 설치 가이드

> 터미널 없이 쓰고 싶다면 이 문서 대신 **[맥 앱 가이드](MAC_APP.md)** 를 보세요. DMG 파일 하나로 설치합니다. 이 문서는 소스 코드로 설치하는 방법입니다.

## 1. 준비물

| 항목 | 내용 |
| --- | --- |
| macOS | Apple Silicon 권장. 상시 실행은 launchd를 씁니다 |
| Node.js | 22 이상 (`node --version`) |
| git | 팀이 일할 저장소는 git 저장소여야 합니다 |
| Claude Code | 이 맥에서 `claude` 가 로그인된 상태로 동작해야 합니다. Hivelane은 같은 로그인을 씁니다(API 키 불필요). Pro/Max 구독이면 사이드바에 플랜 사용량이 보입니다 |
| GitHub CLI (선택) | `gh auth login` 해 두면 PR 목록·검사·병합이 동작합니다 |
| Tailscale (선택) | 휴대폰에서 쓰려면 필요합니다 |

### 처음이라면: 준비물 설치

터미널(응용 프로그램 › 유틸리티 › 터미널)을 열고 한 줄씩 붙여 넣습니다. 이미 있는 것은 건너뜁니다.

```bash
# 1) Homebrew(맥용 설치 도구) — 안내가 나오면 맥 비밀번호를 넣습니다
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# 2) Node.js 와 git
brew install node git
# 3) Claude Code 설치 후 로그인(브라우저가 열리면 Claude 계정으로 승인)
npm install -g @anthropic-ai/claude-code
claude
```

`claude` 화면이 뜨고 로그인이 끝나면 `/exit` 로 나옵니다.

Claude Code 로그인 확인:

```bash
claude auth status --text
```

## 2. 설치

```bash
git clone https://github.com/webjihong/hivelane.git
cd hivelane
npm install
```

### 상시 실행(권장)

```bash
npm run service:install
```

하는 일:

1. 화면을 빌드합니다(`dist/web`).
2. launchd 사용자 서비스 `com.webjihong.hivelane` 을 등록하고 시작합니다. 맥에 로그인하면 저절로 켜지고, 죽으면 다시 켜집니다. 시스템 설정 › 일반 › 로그인 항목의 「백그라운드에서 허용」에 **Hivelane** 으로 보입니다(`~/.hivelane/Hivelane.app` 껍데기가 서버를 띄움).
3. Tailscale이 깔려 있으면 `tailscale serve --bg 4312` 로 tailnet 안에서만 원격 화면을 엽니다.

브라우저에서 <http://127.0.0.1:4310> 을 엽니다.

| 명령 | 설명 |
| --- | --- |
| `npm run service:status` | launchd 상태 · tailscale serve 주소 · 서버 응답 |
| `npm run service:restart` | 화면을 다시 빌드하고 서버 다시 시작 (일하는 팀의 턴이 끊기니 팀이 쉴 때) |
| `npm run service:uninstall` | 서비스·tailscale serve 해제 (데이터는 남음) |

### 직접 실행(시험용)

```bash
npm run build
npm start          # http://127.0.0.1:4310
```

## 3. 데이터와 설정 위치

| 경로 | 내용 |
| --- | --- |
| `~/.hivelane/hivelane.db` | 모든 기록(SQLite) |
| `~/.hivelane/worktrees/` | 업무 팀이 일하는 git worktree |
| `~/.hivelane/po/`, `standing/` | 총괄·직속 팀 작업 폴더 |
| `~/.hivelane/logs/server.log` | 서버 로그 |
| `~/.hivelane/archive/` | 정리한 worktree·브랜치의 변경 패치 |
| `~/.hivelane/vapid.json` | 웹 푸시 키(자동 생성, 공유 금지) |

환경 변수:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `HIVELANE_HOME` | `~/.hivelane` | 데이터 폴더 |
| `HIVELANE_PORT` | `4310` | 맥 로컬 화면 |
| `HIVELANE_REMOTE_PORT` | `4312` | tailscale serve 전용 원격 리스너 |
| `VOYAGE_API_KEY` | 없음 | 벡터 검색을 Voyage로 할 때만 |

## 4. 처음 설정

1. **설정 › 프로젝트**: 팀이 일할 저장소 경로를 등록합니다(「Finder에서 고르기」로 폴더 선택 가능). 기준 브랜치와 Claude Code 메모리 폴더는 자동으로 채워집니다. git 저장소가 아니면 「여기서 git 시작하기」로 기본 `.gitignore`(node_modules·.env 등 제외)와 첫 커밋을 만들고 등록합니다.
   - **git 권한**: 기본 `none`(커밋·푸시·PR 막음). `push` 로 바꾸면 팀이 브랜치를 푸시하고 PR까지 만들 수 있습니다(보호 브랜치·강제 푸시·병합은 여전히 막힘).
   - **막을 명령 / 무거운 명령**: 프로젝트에 맞게 확인하세요. 운영 배포·DB 명령은 꼭 막을 명령에 넣습니다.
2. **설정 › 알림**(선택): 슬랙 웹훅, 이 기기에서 「웹 푸시 켜기」.
3. **총괄 대화창**에 일을 말해 봅니다. 사용법은 [사용 가이드](GUIDE.md).

## 5. 휴대폰에서 쓰기(Tailscale)

1. 맥과 휴대폰에 Tailscale을 깔고 같은 계정으로 로그인합니다.
2. Tailscale 관리 콘솔 › DNS에서 **HTTPS Certificates** 를 켭니다.
3. `npm run service:install` (이미 했다면 `npm run service:status` 로 `https://<맥이름>.<tailnet>.ts.net` 주소 확인).
4. 휴대폰에서 그 주소를 한 번 엽니다 → 맥 화면 **설정 › 원격 접속**의 「마지막 원격 시도」에 계정이 뜨면 **주인으로 등록**.
5. 휴대폰 브라우저에서 「홈 화면에 추가」하면 앱처럼 쓰고 웹 푸시를 받을 수 있습니다.

원격에서는 보기·지시·답변·PR 병합·스크립트 실행은 되지만, 설정·템플릿·프로젝트 변경과 스크립트 추가/수정은 맥에서만 됩니다.

## 6. 업데이트

```bash
cd hivelane
git pull
npm install
npm run service:install   # 다시 빌드하고 서비스 다시 등록
```

DB 구조 변경(마이그레이션)은 서버가 켜질 때 저절로 적용됩니다. 일하는 팀이 있으면 끝난 뒤에 하세요.

## 7. 문제 해결

| 증상 | 확인 |
| --- | --- |
| 화면이 안 뜸 | `npm run service:status`, `~/.hivelane/logs/server.log`, `~/.hivelane/logs/launchd.err.log` |
| 팀이 바로 실패 · 로그인 오류 | 사이드바 「인증」이 빨간색이면 **재인증**. 또는 터미널에서 `claude auth login` |
| 토큰 줄이 안 보임 | API 키·Bedrock 등 구독이 아닌 로그인에서는 플랜 사용량이 없습니다 |
| PR 목록이 비어 있음 | `gh auth status` · 저장소에 GitHub 원격이 있는지 |
| 휴대폰에서 403 | 설정 › 원격 접속에 주인 계정이 등록됐는지 · Tailscale 사용자 기기인지(태그 기기는 거부) |
| 맥이 느려짐 | 사이드바 리소스 줄을 누르면 누가 CPU·메모리를 쓰는지 나옵니다. 설정 › 총괄 엔진에서 구간 기준·동시 실행 수 조정 |
| 화면이 하얗게 비어 있음 | 서버만 옛 판일 때 생길 수 있습니다. `npm run service:restart` 후 새로고침 |

## 8. 제거

```bash
npm run service:uninstall
rm -rf ~/.hivelane     # 기록까지 지우려면(되돌릴 수 없음)
```

팀이 만든 브랜치는 각 저장소에 남습니다. 총괄에게 「git 정리해줘」라고 하면 정리할 수 있는 worktree·로컬 브랜치를 골라 줍니다.
