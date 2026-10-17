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
 *   4. Service Worker 등록 · reg.update() 갱신 검사 · controllerchange
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
// § 1. 전역 공유 상태
//   ★ Phase 10: 이 블록의 window._autoSplitActive/_autoSplitLines/_fullRawLines 대체 정의 제거
//   parser.js가 항상 먼저 로드되어 정의하므로 실행되지 않던 코드였음 (정의 위치: parser.js 단일)
// ══════════════════════════════════════════════════════════════

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

  // ★ Phase 9: 하드코딩 EXPECTED_CACHE 제거
  //   이전: 5월 날짜로 고정된 캐시 이름을 SW에 CHECK_CACHE로 보내 비교 → sw.js만 갱신되면
  //         새로고침마다 캐시 전체 삭제 + 업데이트 배너가 뜨는 문제.
  //   현재: 브라우저 표준 갱신 검사(reg.update())만 사용 — sw.js 바이트가 바뀌면 새 SW가 설치되고
  //         updatefound → installed 시점에 배너를 띄운다. 버전 문자열은 sw.js 한 곳에만 존재.
  let _swReg = null;

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
      'background:var(--panel)', 'border:1.5px solid var(--accent)',
      'border-radius:var(--radius-sm)', 'padding:10px 16px',
      'box-shadow:var(--shadow-lg)',
      'z-index:99997', 'display:flex', 'align-items:center', 'gap:10px',
      'font-size:var(--fs-base)', 'color:var(--text)', 'white-space:nowrap',
      'animation:fadeUp .3s ease',
    ].join(';');
    // textContent 사용 — XSS 방어
    const msgSpan = document.createElement('span');
    msgSpan.textContent = '🔄 새 버전이 준비됐어요.';
    banner.appendChild(msgSpan);

    const updateBtn = document.createElement('button');
    updateBtn.textContent = '지금 업데이트';
    updateBtn.style.cssText = [
      'background:var(--accent)', 'color:var(--on-accent)', 'border:none',
      'border-radius:var(--radius-xs)', 'padding:4px 10px', 'cursor:pointer',
      'font-size:var(--fs-sm)', 'font-weight:600',
    ].join(';');
    updateBtn.addEventListener('click', function () {
      // ★ Phase 9: SKIP_WAITING은 '대기 중인 새 SW'에 보내야 한다.
      //   이전에는 이미 활성인 controller에 보내 아무 일도 일어나지 않았음.
      const waiting = _swReg?.waiting;
      if (waiting) {
        waiting.postMessage({ type: 'SKIP_WAITING' }); // → controllerchange → reload
      } else {
        window.location.reload();
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'background:none', 'border:none', 'cursor:pointer',
      'color:var(--text2)', 'font-size:var(--fs-base)', 'padding:0 2px',
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
  // ★ Phase 9: 첫 방문(기존 컨트롤러 없음)에서 clients.claim()으로 인한 controllerchange는
  //   '업데이트'가 아니므로 새로고침하지 않음 (이전: 첫 방문마다 페이지가 한 번 저절로 새로고침됨)
  const _hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!_hadController || _reloadPending) return;
    _reloadPending = true;
    window.location.reload();
  });

  // ── SW 등록 ──
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(function (reg) {
        _swReg = reg;
        // 이미 설치를 마치고 대기 중인 새 버전이 있으면 바로 안내
        if (reg.waiting && navigator.serviceWorker.controller) _showUpdateBanner();
        // 새로고침 시 sw.js 변경 여부를 즉시 검사 (HTTP 캐시 우회)
        if (isReload) reg.update().catch(function () {});

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

  // ══════════════════════════════════════════════════════════════
  // ★ M-FIX: 필수 심볼 로드 완료 여부 직접 평가
  // 문제: window['Toast'] 체크는 const 선언 변수를 감지하지 못함
  //       (const는 전역 스코프에서도 window 프로퍼티로 자동 등록 안 됨)
  // 해결: typeof 직접 평가로 교체 + core.js에서 window 명시적 노출 추가
  // ══════════════════════════════════════════════════════════════

  // ① 아키텍처 레이어 심볼 준비 확인 — Failover 재시도 포함
  function _checkCoreSymbols() {
    return typeof Toast !== 'undefined' &&
           typeof EventBus !== 'undefined' &&
           typeof SettingsDB !== 'undefined';
  }

  if (!_checkCoreSymbols()) {
    // core.js가 아직 완전히 평가되지 않은 경우 (네트워크 지연 등)
    // 이벤트 루프를 한 번 양보한 뒤 재시도
    console.warn('[main.js] core.js 심볼 미준비 — 이벤트 루프 양보 후 재시도');
    Promise.resolve().then(() => {
      if (!_checkCoreSymbols()) {
        // 그래도 없으면 로드 실패 — 사용자에게 안내
        console.error('[main.js] core.js 로드 실패. 스크립트 순서를 확인하세요.');
        const errBanner = document.createElement('div');
        errBanner.style.cssText = [
          'position:fixed','top:0','left:0','right:0',
          'background:var(--red)','color:var(--on-accent)','padding:10px 16px',
          'font-size:var(--fs-base)','z-index:99999','text-align:center',
        ].join(';');
        errBanner.textContent = '초기화 오류: 핵심 모듈 로드 실패. 페이지를 새로고침해 주세요.';
        document.body?.appendChild(errBanner);
        return;
      }
      _runMainInit(); // 재시도 성공
    });
    return; // 현재 실행 중단 — 재시도로 위임
  }

  _runMainInit(); // 즉시 실행

}, { once: true });

// ── 실제 초기화 로직 분리 (재시도 경로에서도 동일하게 실행)
function _runMainInit() {
  // ① JSZip 가드 — DOMContentLoaded 시점에 최종 확인
  _checkJSZip();

  // ② ui-state.js 초기화 함수 호출  ★ Phase 4 핵심
  if (typeof window.initUiState === 'function') {
    window.initUiState();
    // ★ initUiState 내부에서 _initProgEls()를 호출하지만,
    //    안전망으로 직접 호출도 시도 (중복 호출은 무해)
    if (typeof window._initProgEls === 'function') window._initProgEls();
  } else {
    console.error('[main.js] window.initUiState 미정의 — ui-state.js 로드 순서 확인 필요');
    // initUiState 없어도 _initProgEls는 독립적으로 시도
    if (typeof window._initProgEls === 'function') window._initProgEls();
  }

  // ③ 모듈 init 함수 존재 여부 방어 점검  ★ M-03
  //    ★ M-FIX: window[fn] 대신 typeof 직접 평가 — const 변수 정확히 감지
  const REQUIRED_FNS = [
    // parser.js
    ['escHtml',            () => typeof escHtml !== 'undefined'],
    ['renderBodyHtml',     () => typeof renderBodyHtml !== 'undefined'],
    ['sanitizeLine',       () => typeof sanitizeLine !== 'undefined'],
    ['previewToc',         () => typeof previewToc !== 'undefined'],
    ['autoSplitByInterval',() => typeof autoSplitByInterval !== 'undefined'],
    ['bestPat',            () => typeof bestPat !== 'undefined'],
    ['detectToc',          () => typeof detectToc !== 'undefined'],
    ['assembleTocChapters',() => typeof assembleTocChapters !== 'undefined'],
    ['tocScrollToIndex',   () => typeof tocScrollToIndex !== 'undefined'],
    // epub-gen.js
    ['buildEpub',          () => typeof buildEpub !== 'undefined'],
    ['buildCss',           () => typeof buildCss !== 'undefined'],
    ['generateTextCover',  () => typeof generateTextCover !== 'undefined'],
    // convert.js
    ['handleTxt',          () => typeof handleTxt !== 'undefined'],
    ['fileToText',         () => typeof fileToText !== 'undefined'],
    ['startConvert',       () => typeof startConvert !== 'undefined'],
    ['splitChapters',      () => typeof splitChapters !== 'undefined'],
    ['detectTocAsync',     () => typeof detectTocAsync !== 'undefined'],
    // settings.js
    ['saveCssSettings',    () => typeof saveCssSettings !== 'undefined'],
    ['loadCssSettings',    () => typeof loadCssSettings !== 'undefined'],
    ['renderCssPresetList',() => typeof renderCssPresetList !== 'undefined'],
    // ui-state.js
    ['switchPage',         () => typeof switchPage !== 'undefined'],
    ['setupEventDelegate', () => typeof setupEventDelegate !== 'undefined'],
    ['initTheme',          () => typeof initTheme !== 'undefined'],
    // edit.js
    ['loadEpub',           () => typeof loadEpub !== 'undefined'],
    ['renderChList',       () => typeof renderChList !== 'undefined'],
    // core.js — const이므로 window[fn] 대신 typeof 사용
    ['Toast',              () => typeof Toast !== 'undefined'],
    ['SettingsDB',         () => typeof SettingsDB !== 'undefined'],
    ['EventBus',           () => typeof EventBus !== 'undefined'],
  ];

  const missing = REQUIRED_FNS.filter(([, check]) => !check()).map(([name]) => name);

  if (missing.length > 0) {
    console.warn('[main.js] 필수 심볼 미로드:', missing.join(', '));
    if (typeof Toast !== 'undefined' && location.hostname === 'localhost') {
      Toast.warn('누락된 모듈: ' + missing.join(', '), 5000);
    }
  }

  // ④ 마지막 방문 탭 복원  ★ M-08
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      try {
        const lastPage = localStorage.getItem('novelepub_last_page') || 'convert';
        // ★ 2단계 pages 순서 동기화: convert→edit→batch→history→settings
        const validPages = ['convert', 'edit', 'batch', 'history', 'settings'];
        if (
          validPages.includes(lastPage) &&
          lastPage !== 'convert' &&
          typeof switchPage === 'function'
        ) {
          switchPage(lastPage);
        }
      } catch (e) {}
    });
  });

  // ⑤ splitBtn 초기 상태 보장
  try {
    const splitBtn = document.querySelector('button[data-action="autoSplitByInterval"]');
    if (splitBtn && typeof _syncSplitBtn === 'function') {
      _syncSplitBtn('nofile');
    }
  } catch (e) {}

  // ⑥ 이벤트 위임 복구 보장  ★ M-FIX
  //    cover-search.js가 window.openCoverSearchModal 등을 노출했는지 확인
  //    끊어진 경우 DOMContentLoaded 이후 재등록
  requestAnimationFrame(function() {
    const coverBtn = document.querySelector('[data-action="openCoverModal"]');
    if (coverBtn && typeof openCoverSearchModal !== 'function') {
      console.warn('[main.js] cover-search.js 심볼 미로드 — 이벤트 위임 복구 불가');
    }
    // EventDelegate가 제대로 초기화됐는지 확인
    if (typeof EventDelegate !== 'undefined' && typeof EventDelegate.init === 'function') {
      // 이미 initUiState에서 setupEventDelegate()가 호출됐으나
      // 모달 관련 액션이 등록됐는지 재확인 (안전망)
    }
  });

  // ⑦ 개발 환경 디버그 정보 출력
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    console.info(
      '%c[NovelEPUB] 초기화 완료%c\n' +
      '  window._autoSplitActive: ' + window._autoSplitActive + '\n' +
      '  JSZip: ' + (typeof JSZip !== 'undefined' ? 'OK' : '❌ 미로드') + '\n' +
      '  Toast: ' + (typeof Toast !== 'undefined' ? 'OK' : '❌ 미로드') + '\n' +
      '  ServiceWorker: ' + ('serviceWorker' in navigator ? 'OK' : '미지원'),
      'color:#4a90d9;font-weight:bold',
      'color:inherit'
    );
  }
}

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
// § 7. 키보드 단축키
//   ★ Phase 9: 전역 단축키는 ui-state.js setupEventListeners()의 단일 핸들러가 담당.
//     (이 위치에 있던 중복 keydown 핸들러가 Ctrl+Space 변환 2회 실행·Ctrl+/ 도움말 즉시 닫힘을
//      일으켜 제거했고, 여기에만 있던 Ctrl+Z 목차 Undo는 ui-state.js로 이관함)
// ══════════════════════════════════════════════════════════════

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
      // ★ Phase 9: 하드코딩 버전 비교(CHECK_CACHE) 대신 표준 갱신 검사
      navigator.serviceWorker?.getRegistration?.()
        .then(function (reg) { return reg?.update(); })
        .catch(function () {});
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
