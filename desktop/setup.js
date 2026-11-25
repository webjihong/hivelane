/* 처음 실행 안내 화면 동작 (preload.cjs 의 window.hl 을 쓴다) */
const $ = (id) => document.getElementById(id);
const mark = (id, cls) => { const el = $(id); el.classList.remove('ok', 'need', 'opt'); if (cls) el.classList.add(cls); };
const button = (label, onClick) => { const b = document.createElement('button'); b.textContent = label; b.onclick = onClick; return b; };

async function refresh() {
  const s = await window.hl.status();
  // git
  mark('s-git', s.git ? 'ok' : 'need');
  $('d-git').textContent = s.git ? `${s.git} — 준비됨` : '없습니다. 「설치」를 누르면 맥의 개발자 도구 설치 창이 뜹니다(몇 분 걸림). 끝나면 「다시 확인」을 누르세요.';
  $('b-git').replaceChildren(...(s.git ? [] : [button('설치', () => window.hl.installCLT()), button('다시 확인', refresh)]));
  // tailscale
  mark('s-ts', s.tailscale && s.tailscale !== 'installed' ? 'ok' : 'opt');
  if (!s.tailscale) {
    $('d-ts').textContent = '없어도 맥에서는 쓸 수 있습니다. 휴대폰으로 보려면 Tailscale 을 설치하고 로그인하세요.';
    $('b-ts').replaceChildren(button('받으러 가기', () => window.hl.link('https://tailscale.com/download/mac')));
  } else if (s.tailscale === 'installed') {
    $('d-ts').textContent = '설치되어 있습니다. 서버를 시작한 뒤 「휴대폰 연결」을 누르면 내 기기들에서만 열리는 주소가 생깁니다.';
    $('b-ts').replaceChildren(button('휴대폰 연결', async () => {
      const r = await window.hl.tailscale();
      $('msg').className = r.ok ? 'msg' : 'msg err';
      $('msg').textContent = r.ok ? `휴대폰에서: ${r.url ?? '(tailscale serve status 확인)'}` : `연결 실패: ${r.error}`;
      void refresh();
    }));
  } else {
    $('d-ts').textContent = `휴대폰에서: ${s.tailscale}`;
    $('b-ts').replaceChildren();
  }
  // 서버
  mark('s-server', s.server ? 'ok' : 'need');
  $('d-server').textContent = s.server
    ? `실행 중 (${s.service === 'app' ? '이 앱이 관리' : s.service === 'other' ? '다른 방식으로 설치됨' : '등록 없음'}) · 데이터 ${s.data}`
    : `아직 없습니다. 설치하면 맥에 로그인할 때마다 자동으로 켜지고, 앱을 닫아도 계속 돌아갑니다. 데이터: ${s.data}`;
  const btn = $('install');
  btn.disabled = !s.git;
  btn.textContent = s.server ? '관제실 열기' : '서버 설치하고 시작';
  btn.onclick = s.server ? () => window.hl.open() : install;
}

async function install() {
  const btn = $('install');
  btn.disabled = true;
  $('msg').className = 'msg';
  $('msg').textContent = '서버를 설치하고 켜는 중… (최대 30초)';
  const r = await window.hl.install();
  if (r.ok) { $('msg').textContent = '서버가 켜졌습니다.'; await window.hl.open(); return; }
  $('msg').className = 'msg err';
  $('msg').textContent = `서버가 응답하지 않습니다. ${r.error ?? ''}\n기록: ${r.log}/launchd.err.log`;
  btn.disabled = false;
}

void refresh();
