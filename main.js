/**
 * main.js — NovelEPUB 통합 진입점 오케스트레이터
 * ════════════════════════════════════════════════════════════
 *
 * 역할:
 *   1. 모든 모듈(core.js → settings.js → cover-search.js →
 *      convert.js → edit.js → ui-state.js)의 초기화 순서를
 *      DOMContentLoaded 단일 지점에서 직렬 보장
 *   2. window._autoSplitActive 등 공유 전역 상태를 최초 1회만
 *      안전하게 정의 (Proxy 재정의 레이스 원천 차단)
 *   3. JSZip CDN 로드 실패 시 사용자 안내 (오프라인 안전망)
 *   4. Service Worker 등록 · CHECK_CACHE · controllerchange
 *      · SKIP_WAITING · 업데이트 배너 로직 완전 통합
 *   5. 이미 DOMContentLoaded에서 모듈 자체 init을 수행하는
 *      ui-state.js와 충돌하지 않도록 이 파일은 load 이벤트
 *      이후 / DOMContentLoaded 직전에만 전역 가드 처리
 *
 * 로드 순서 (index.html 스크립트 태그 기준):
 *   parser.js → epub-gen.js → core.js → settings.js →
 *   cover-search.js → convert.js → edit.js → ui-state.js
 *   → main.js  ← 이 파일 (마지막 로드)
 *
 * ★ Phase 4 개선 목록:
 *   M-01: JSZip 로드 실패 감지 가드
 *   M-02: window._autoSplitActive Proxy 최초 1회 정의 통합
 *   M-03: 모듈 init 함수 존재 여부 방어 점검 (typeof 가드)
 *   M-04: SW 등록 완전 통합 (index.html 인라인 제거 대상)
 *   M-05: controllerchange → reload 레이스 방지
 *         (beforeunload 등록 여부로 중복 reload 차단)
 *   M-06: 업데이트 배너 중복 생성 방지 + 자동 소멸
 *   M-07: 전역 unhandledRejection / error 핸들러
 *   M-08: 초기 페이지 복원 (마지막 탭 기억)
 * ════════════════════════════════════════════════════════════
 */

'use strict';

// ══════════════════════════════════════════════════════════════
// § 0. 모듈 가드 — 중복 실행 방지
// ══════════════════════════════════════════════════════════════
if (window.__NOVELEPUB_MAIN_LOADED__) {
  console.warn('[main.js] 중복 로드 감지 — 실행 건너뜀');
} else {
window.__NOVELEPUB_MAIN_LOADED__ = true;

// ══════════════════════════════════════════════════════════════
// § 1. 전역 공유 상태 — 최초 1회 안전 정의
//   ★ M-02: Proxy 재정의 레이스 원천 차단
//   convert.js / parser.js 어느 쪽이 먼저 로드되어도
//   main.js가 스크립트 맨 마지막에 로드되어 단 1회만 defineProperty
// ══════════════════════════════════════════════════════════════
(function _initSharedState() {
  // _autoSplitActive
  if (!Object.getOwnPropertyDescriptor(window, '_autoSplitActive')) {
    let __val = false;
    Object.defineProperty(window, '_autoSplitActive', {
      get() { return __val; },
      set(v) { __val = !!v; },
      configurable: true,
    });
  }

  // _autoSplitLines — parser.js 소유이지만 convert.js도 읽어야 함
  // parser.js가 이미 정의했을 수 있으므로 미정의 시에만 초기 stub 설정
  if (!Object.getOwnPropertyDescriptor(window, '_autoSplitLines')) {
    Object.defineProperty(window, '_autoSplitLines', {
      get() { return null; },
      set() {},
      configurable: true,   // parser.js가 나중에 정확한 getter로 덮어씀
    });
  }

  // _fullRawLines
  if (!Object.getOwnPropertyDescriptor(window, '_fullRawLines')) {
    Object.defineProperty(window, '_fullRawLines', {
      get() { return []; },
      set() {},
      configurable: true,
    });
  }
})();

// ══════════════════════════════════════════════════════════════
// § 2. JSZip 로드 실패 가드  ★ M-01
//   CDN 로드 실패 시 사용자에게 즉시 안내 + EPUB 생성 시도 차단
// ══════════════════════════════════════════════════════════════
function _checkJSZip() {
  if (typeof JSZip !== 'undefined') return true;

  console.error('[main.js] JSZip 로드 실패 — CDN 응답 없음');

  // DOMContentLoaded 후 Toast가 사용 가능한 시점에 경고
  const _warn = () => {
    if (typeof Toast !== 'undefined') {
      Toast.error(
        'EPUB 패키징 라이브러리(JSZip)를 불러오지 못했어요.<br>' +
        '네트워크 연결을 확인하거나 페이지를 새로고침해 주세요.',
        0   // 자동 닫힘 없음
      );
    } else {
      alert('JSZip 로드 실패: 네트워크 연결을 확인하고 페이지를 새로고침해 주세요.');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _warn, { once: true });
  } else {
    setTimeout(_warn, 0);
  }

  // buildEpub 호출 시 즉시 에러 반환하는 안전 스텁
  window.buildEpub = async function() {
    throw new Error('JSZip 로드 실패로 EPUB 생성이 불가능합니다. 페이지를 새로고침해 주세요.');
  };

  return false;
}

// ══════════════════════════════════════════════════════════════
// § 3. 전역 에러 핸들러  ★ M-07
//   잡히지 않은 Promise rejection / 동기 에러를 Toast로 표시
//   (Worker 고스트 에러, 비동기 변환 실패 등 최후 안전망)
// ══════════════════════════════════════════════════════════════
window.addEventListener('unhandledrejection', function(e) {
  const reason = e.reason;
  // Worker 정상 abort, Toast 취소 등은 무시
  if (!reason) return;
  if (reason.name === 'AbortError') return;
  if (typeof reason === 'string' && reason.includes('취소')) return;

  console.error('[main.js] unhandledRejection:', reason);

  if (typeof Toast !== 'undefined') {
    const msg = reason.message || String(reason);
    // 메시지가 너무 길면 잘라서 표시
    Toast.error('예기치 않은 오류: ' + msg.slice(0, 120));
  }
});

window.addEventListener('error', function(e) {
  // 스크립트 로드 실패 (CDN 등)
  if (e.target && e.target.tagName === 'SCRIPT') {
    console.error('[main.js] 스크립트 로드 실패:', e.target.src);
    return;
  }
  console.error('[main.js] 전역 오류:', e.message, e.filename, e.lineno);
});

// ══════════════════════════════════════════════════════════════
// § 4. Service Worker 오케스트레이션  ★ M-04 M-05 M-06
// ══════════════════════════════════════════════════════════════
(function _initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // ★ sw.js의 CACHE_VERSION과 반드시 동기화
  const EXPECTED_CACHE = 'novelepub-2026-05-31T00:00:00';

  // 새로고침(F5 / Ctrl+R) 감지
  let isReload = false;
  try {
    const navEntries = performance.getEntriesByType('navigation');
    isReload = navEntries.length > 0
      ? navEntries[0].type === 'reload'
      : (performance.navigation && performance.navigation.type === 1);
  } catch (e) {}

  // ── 업데이트 배너  ★ M-06: 중복 생성 방지 + 10초 자동 소멸 ──
  function _showUpdateBanner() {
    if (document.getElementById('_swUpdateBanner')) return; // 이미 표시 중

    const banner = document.createElement('div');
    banner.id = '_swUpdateBanner';
    banner.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
      'background:var(--panel,#fff)', 'border:1.5px solid var(--accent,#d45a46)',
      'border-radius:10px', 'padding:10px 16px',
      'box-shadow:0 4px 20px rgba(0,0,0,.18)',
      'z-index:99997', 'display:flex', 'align-items:center', 'gap:10px',
      'font-size:13px', 'color:var(--text,#1c1410)', 'white-space:nowrap',
      'animation:fadeUp .3s ease',
    ].join(';');
    // textContent 사용 — XSS 방어
    const msgSpan = document.createElement('span');
    msgSpan.textContent = '🔄 새 버전이 준비됐어요.';
    banner.appendChild(msgSpan);

    const updateBtn = document.createElement('button');
    updateBtn.textContent = '지금 업데이트';
    updateBtn.style.cssText = [
      'background:var(--accent,#d45a46)', 'color:#fff', 'border:none',
      'border-radius:6px', 'padding:4px 10px', 'cursor:pointer',
      'font-size:12px', 'font-weight:600',
    ].join(';');
    updateBtn.addEventListener('click', function () {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      } else {
        window.location.reload();
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'background:none', 'border:none', 'cursor:pointer',
      'color:var(--text2,#7a6a60)', 'font-size:14px', 'padding:0 2px',
    ].join(';');
    closeBtn.addEventListener('click', function () { banner.remove(); });

    banner.appendChild(updateBtn);
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);

    // 10초 자동 소멸
    setTimeout(function () { banner.remove(); }, 10000);
  }

  // ── controllerchange: reload 레이스 방지  ★ M-05 ──
  // 빠른 연속 클릭 시 reload가 여러 번 발생하지 않도록 플래그 관리
  let _reloadPending = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (_reloadPending) return;
    _reloadPending = true;
    window.location.reload();
  });

  // ── SW 메시지 수신 ──
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'CACHE_OUTDATED') {
      _showUpdateBanner();
    }
  });

  // ── SW 등록 ──
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(function (reg) {
        // 새로고침 시 캐시 버전 검증 요청
        if (isReload && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'CHECK_CACHE',
            expected: EXPECTED_CACHE,
          });
        }

        // 새 버전 SW 설치 감지
        reg.addEventListener('updatefound', function () {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function () {
            // 새 SW가 설치 완료 + 기존 SW가 활성 상태일 때만 배너 표시
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              _showUpdateBanner();
            }
          });
        });
      })
      .catch(function (err) {
        // CSP나 HTTPS 미적용 환경에서는 SW 등록 실패가 정상 케이스일 수 있음
        console.warn('[SW] 등록 실패 (개발 환경이거나 CSP 제한일 수 있음):', err.message || err);
      });
  }, { once: true });
})();

// ══════════════════════════════════════════════════════════════
// § 5. DOMContentLoaded 오케스트레이터  ★ M-03 M-08
//   ── ui-state.js의 DOMContentLoaded 블록과 충돌하지 않음 ──
//
//   ui-state.js는 자신의 DOMContentLoaded 안에서:
//     initTheme, loadCssSettings, buildPatHelpers,
//     setupDragDrop, setupEventListeners, setupEventDelegate 등을 실행
//
//   main.js는 그 후처리 역할만 담당:
//     ① JSZip 로드 확인
//     ② 마지막 방문 탭 복원 (M-08)
//     ③ 공유 전역 상태 로깅 (개발 환경 디버그)
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function _mainInit() {
  // ① JSZip 가드 — DOMContentLoaded 시점에 최종 확인
  _checkJSZip();

  // ② ui-state.js 초기화 함수 호출  ★ Phase 4 핵심
  //    이전: ui-state.js가 자체 DOMContentLoaded 소유 → 레이스 위험
  //    이후: main.js가 단일 DOMContentLoaded에서 순서 보장하며 호출
  if (typeof window.initUiState === 'function') {
    window.initUiState();
  } else {
    console.error('[main.js] window.initUiState 미정의 — ui-state.js 로드 순서 확인 필요');
  }

  // ② 모듈 init 함수 존재 여부 방어 점검  ★ M-03
  //    필수 함수가 없으면 콘솔 경고 (런타임 크래시 예방)
  const REQUIRED_FNS = [
    // parser.js
    'escHtml', 'renderBodyHtml', 'sanitizeLine',
    'previewToc', 'autoSplitByInterval', 'bestPat',
    // epub-gen.js
    'buildEpub', 'buildCss', 'generateTextCover',
    // convert.js
    'handleTxt', 'fileToText', 'startConvert', 'splitChapters',
    // settings.js
    'saveCssSettings', 'loadCssSettings', 'renderCssPresetList',
    // ui-state.js
    'switchPage', 'setupEventDelegate', 'initTheme',
    // edit.js
    'loadEpub', 'renderChList',
    // core.js
    'Toast', 'SettingsDB', 'EventBus',
  ];
  const missing = REQUIRED_FNS.filter(fn => {
    const val = window[fn];
    return typeof val === 'undefined';
  });
  if (missing.length > 0) {
    console.warn('[main.js] 필수 심볼 미로드:', missing.join(', '));
    // 개발 환경에서만 Toast 경고 (production 빌드에서는 조용히 넘김)
    if (typeof Toast !== 'undefined' && location.hostname === 'localhost') {
      Toast.warn('누락된 모듈: ' + missing.join(', '), 5000);
    }
  }

  // ③ 마지막 방문 탭 복원  ★ M-08
  //    ui-state.js의 switchPage를 사용
  //    단, 초기화가 완전히 끝난 뒤 실행해야 하므로 rAF(double) 지연
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      try {
        const lastPage = localStorage.getItem('novelepub_last_page') || 'convert';
        const validPages = ['convert', 'batch', 'edit', 'history', 'settings'];
        if (
          validPages.includes(lastPage) &&
          lastPage !== 'convert' &&   // 기본 탭이 아닐 때만 복원
          typeof switchPage === 'function'
        ) {
          switchPage(lastPage);
        }
      } catch (e) {
        // localStorage 접근 실패(프라이빗 브라우징 등) — 무시
      }
    });
  });

  // ④ splitBtn 초기 상태 보장
  //    파일이 없는 초기 상태에서 splitBtn이 활성화되어 있으면
  //    _syncSplitBtn('nofile')로 강제 비활성화
  try {
    const splitBtn = document.querySelector('button[data-action="autoSplitByInterval"]');
    if (splitBtn && typeof _syncSplitBtn === 'function') {
      _syncSplitBtn('nofile');
    }
  } catch (e) {}

  // ⑤ 개발 환경 디버그 정보 출력
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    console.info(
      '%c[NovelEPUB] 초기화 완료%c\n' +
      '  window._autoSplitActive: ' + window._autoSplitActive + '\n' +
      '  JSZip: ' + (typeof JSZip !== 'undefined' ? 'OK' : '❌ 미로드') + '\n' +
      '  ServiceWorker: ' + ('serviceWorker' in navigator ? 'OK' : '미지원'),
      'color:#4a90d9;font-weight:bold',
      'color:inherit'
    );
  }
}, { once: true }); // ← once:true — 리스너 중복 등록 방지

// ══════════════════════════════════════════════════════════════
// § 6. 탭 전환 시 마지막 방문 탭 저장
//   ui-state.js의 switchPage를 래핑하여 localStorage에 기록
//   ★ switchPage가 이미 정의된 후 실행되어야 하므로
//     DOMContentLoaded 내 rAF 이후에 래핑
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function _wrapSwitchPage() {
  // double rAF — 모든 모듈 init 완료 보장 후 래핑
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (typeof switchPage !== 'function') return;
      const _original = switchPage;
      window.switchPage = function(name) {
        _original(name);
        try {
          localStorage.setItem('novelepub_last_page', name);
        } catch (e) {}
      };
    });
  });
}, { once: true });

// ══════════════════════════════════════════════════════════════
// § 7. 키보드 단축키 — 통합 핸들러
//   각 모듈에 흩어진 단축키 바인딩을 한 곳에서 관리
//   ★ 기존 단축키 (ui-state.js setupEventListeners) 유지하되
//     누락된 전역 단축키만 추가 등록
// ══════════════════════════════════════════════════════════════
document.addEventListener('keydown', function _globalShortcuts(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  // Ctrl+Space: 변환 시작 (입력창 포커스 중이면 무시)
  if (e.code === 'Space' && !e.shiftKey) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (typeof startConvert === 'function') startConvert();
    return;
  }

  // Ctrl+S: EPUB 다운로드
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    const dlBtn = document.querySelector('[data-action="downloadEpub"]');
    if (dlBtn && !dlBtn.disabled) dlBtn.click();
    return;
  }

  // Ctrl+/: 단축키 도움말 토글
  if (e.key === '/' || e.key === '?') {
    e.preventDefault();
    if (typeof showShortcutHelp === 'function') showShortcutHelp();
    return;
  }

  // Ctrl+Z: 목차 Undo (목차 패널이 열려 있을 때만)
  if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    const tocPanel = document.getElementById('tocPanel');
    if (tocPanel?.classList.contains('show')) {
      e.preventDefault();
      if (typeof undoToc === 'function') undoToc();
    }
    return;
  }
});

// ══════════════════════════════════════════════════════════════
// § 8. 개발 환경 핫 리로드 지원
//   Cloudflare Pages / GitHub Pages 배포 환경에서는 비활성
//   localhost에서만 파일 변경 감지 → 자동 새로고침 안내
// ══════════════════════════════════════════════════════════════
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  let _devReloadTimer = null;
  window.addEventListener('focus', function() {
    // 창 포커스 복귀 시 SW 캐시 재검증 요청 (개발 중 파일 변경 감지)
    clearTimeout(_devReloadTimer);
    _devReloadTimer = setTimeout(function() {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'CHECK_CACHE',
          expected: 'novelepub-2026-05-31T00:00:00',
        });
      }
    }, 500);
  });
}

// ══════════════════════════════════════════════════════════════
// § 9. 정합성 자가 진단 (production 배포 전 체크)
// ══════════════════════════════════════════════════════════════
window.__novelepubDiag = function() {
  const result = {
    jszip:      typeof JSZip !== 'undefined',
    toast:      typeof Toast !== 'undefined',
    settingsDB: typeof SettingsDB !== 'undefined',
    eventBus:   typeof EventBus !== 'undefined',
    sw:         'serviceWorker' in navigator,
    autoSplit:  typeof window._autoSplitActive,
    escHtml:    typeof escHtml !== 'undefined',
    buildEpub:  typeof buildEpub !== 'undefined',
  };
  console.table(result);
  const fails = Object.entries(result).filter(([,v]) => v === false || v === 'undefined');
  if (fails.length === 0) {
    console.info('%c✅ 모든 모듈 정상 로드됨', 'color:green;font-weight:bold');
  } else {
    console.warn('%c⚠️ 누락/오류:', 'color:orange;font-weight:bold', fails.map(([k])=>k).join(', '));
  }
  return result;
};

} // end if(!__NOVELEPUB_MAIN_LOADED__)
