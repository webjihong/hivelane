/* 처음 실행 안내 화면 동작 (preload.cjs 의 window.hl 을 쓴다) */
const $ = (id) => document.getElementById(id);
const mark = (id, cls) => { const el = $(id); el.classList.remove('ok', 'need', 'opt'); if (cls) el.classList.add(cls); };
const button = (label, onClick) => { const b = document.createElement('button'); b.textContent = label; b.onclick = onClick; return b; };

/* 언어: main.mjs 가 ?lang=ko|en 으로 넘긴다. 영어면 setup.html 의 data-en 글로 바꾼다 */
const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ko';
const L = (ko, en) => (LANG === 'ko' ? ko : en);
if (LANG === 'en') {
  document.documentElement.lang = 'en';
  document.title = 'Get started with Hivelane';
  for (const el of document.querySelectorAll('[data-en]')) el.textContent = el.dataset.en;
}

async function refresh() {
  const s = await window.hl.status();
  // git
  mark('s-git', s.git ? 'ok' : 'need');
  $('d-git').textContent = s.git
    ? L(`${s.git} — 준비됨`, `${s.git} — ready`)
    : L('없습니다. 「설치」를 누르면 맥의 개발자 도구 설치 창이 뜹니다(몇 분 걸림). 끝나면 「다시 확인」을 누르세요.', 'Not found. Click “Install” to open the macOS developer tools installer (takes a few minutes). When it finishes, click “Check again”.');
  $('b-git').replaceChildren(...(s.git ? [] : [button(L('설치', 'Install'), () => window.hl.installCLT()), button(L('다시 확인', 'Check again'), refresh)]));
  // tailscale
  mark('s-ts', s.tailscale && s.tailscale !== 'installed' ? 'ok' : 'opt');
  if (!s.tailscale) {
    $('d-ts').textContent = L('없어도 맥에서는 쓸 수 있습니다. 휴대폰으로 보려면 Tailscale 을 설치하고 로그인하세요.', 'Not required on the Mac. To use it from your phone, install Tailscale and log in.');
    $('b-ts').replaceChildren(button(L('받으러 가기', 'Download'), () => window.hl.link('https://tailscale.com/download/mac')));
  } else if (s.tailscale === 'installed') {
    $('d-ts').textContent = L('설치되어 있습니다. 서버를 시작한 뒤 「휴대폰 연결」을 누르면 내 기기들에서만 열리는 주소가 생깁니다.', 'Installed. After the server starts, click “Connect phone” to get an address that opens only on your own devices.');
    $('b-ts').replaceChildren(button(L('휴대폰 연결', 'Connect phone'), async () => {
      const r = await window.hl.tailscale();
      $('msg').className = r.ok ? 'msg' : 'msg err';
      $('msg').textContent = r.ok ? L(`휴대폰에서: ${r.url ?? '(tailscale serve status 확인)'}`, `On your phone: ${r.url ?? '(see tailscale serve status)'}`) : L(`연결 실패: ${r.error}`, `Connection failed: ${r.error}`);
      void refresh();
    }));
  } else {
    $('d-ts').textContent = L(`휴대폰에서: ${s.tailscale}`, `On your phone: ${s.tailscale}`);
    $('b-ts').replaceChildren(button(L('주소 복사', 'Copy address'), async () => { await window.hl.copy(s.tailscale); $('msg').className = 'msg'; $('msg').textContent = L('주소를 복사했습니다. 휴대폰으로 보내 여세요.', 'Address copied. Send it to your phone and open it.'); }));
  }
  // 서버
  mark('s-server', s.server ? 'ok' : 'need');
  $('d-server').textContent = s.server
    ? L(`실행 중 (${s.service === 'app' ? '이 앱이 관리' : s.service === 'other' ? '다른 방식으로 설치됨' : '등록 없음'}) · 데이터 ${s.data}`,
      `Running (${s.service === 'app' ? 'managed by this app' : s.service === 'other' ? 'installed another way' : 'not registered'}) · data ${s.data}`)
    : L(`아직 없습니다. 설치하면 맥에 로그인할 때마다 자동으로 켜지고, 앱을 닫아도 계속 돌아갑니다. 데이터: ${s.data}`,
      `Not installed yet. Once installed it starts automatically when you log in to your Mac and keeps running even if you close the app. Data: ${s.data}`);
  const btn = $('install');
  btn.disabled = !s.git;
  btn.textContent = s.server ? L('관제실 열기', 'Open control room') : L('서버 설치하고 시작', 'Install server and start');
  btn.onclick = s.server ? () => window.hl.open() : install;
}

async function install() {
  const btn = $('install');
  btn.disabled = true;
  $('msg').className = 'msg';
  $('msg').textContent = L('서버를 설치하고 켜는 중… (최대 30초)', 'Installing and starting the server… (up to 30 seconds)');
  const r = await window.hl.install();
  if (r.ok) { $('msg').textContent = L('서버가 켜졌습니다.', 'Server started.'); await window.hl.open(); return; }
  $('msg').className = 'msg err';
  $('msg').textContent = L(`서버가 응답하지 않습니다. ${r.error ?? ''}\n기록: ${r.log}/launchd.err.log`, `The server is not responding. ${r.error ?? ''}\nLog: ${r.log}/launchd.err.log`);
  btn.disabled = false;
}

void refresh();
