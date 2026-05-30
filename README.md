# NovelEPUB — TXT → EPUB3 변환기

> 소설 TXT 파일을 EPUB3 전자책으로 변환하는 **순수 프론트엔드 SPA**.  
> 파일이 서버로 전송되지 않으며, 모든 처리가 브라우저 안에서 완결됩니다.

🌐 **데모**: [novel2epub.pages.dev](https://novel2epub.pages.dev)

---

## ✨ 주요 기능

### 📖 TXT → EPUB3 변환
- 단일/다중 TXT 파일 드래그&드롭 업로드
- **48종 챕터 패턴 자동 감지** (제N화, Chapter N, 〈N화〉, [EP.N], 숫자만 등)
- 커스텀 정규식 직접 입력 및 복수 패턴 OR 결합
- 표지 이미지, 삽화(자동/수동) 삽입
- 이탤릭 회상 대사, 들여쓰기, 폰트·줄간격·여백 CSS 설정
- 변환 중단 버튼, 단계별 진행 표시

### 📚 일괄 변환 (Batch)
- 여러 소설 파일을 한 번에 변환
- `navigator.hardwareConcurrency` 기반 **최대 4개 병렬 처리**
- 파일별 진행률·성공/실패 상태 카드

### ✏️ EPUB 편집
- 기존 EPUB 파일을 불러와 목차·CSS 수정 후 재생성

### 🗂 변환 히스토리
- IndexedDB에 변환 이력(제목·작가·챕터수·크기·날짜) 저장
- 기존 EPUB Blob 재다운로드

---

## 🎨 UI/UX 개선 사항

### 1. 시각 계층 강화 — `meta-block` 섹션 분리
설정 폼을 `📖 기본 정보`와 `⚙️ 장/화 분할 규칙` 두 블록으로 분리합니다. 각 블록은 구분선과 대문자 레이블(`meta-block-title`)로 명확히 구획됩니다.

### 2. 메타데이터 영역 분리 — `opt-card-layout` 2단 그리드
옵션 패널을 **좌측 설정 컬럼(1fr)** + **우측 미니 리더 컬럼(260px)** 2단 그리드로 나누어, 설정과 미리보기를 한 화면에서 동시에 확인할 수 있습니다.

### 3. 미니 리더 미리보기 — `mini-reader`
EPUB 스타일 설정(폰트·줄간격·배경색·글자색) 변경 시 **0.4초 플래시 애니메이션**과 함께 우측 미니 리더에 실시간으로 반영됩니다.

### 4. 실시간 피드백 피드 — `regex-feed`
패턴 칩 선택 또는 정규식 입력 후 목차 갱신 시 `#regexFeed` 패널이 노출됩니다. 감지 수 배지, 짧은 챕터 경고, 실제 매칭 줄 5개 미리보기를 표시합니다.

### 5. 스티키 변환 바 — `btm-status` 플로팅 바
하단에 항상 고정된 플로팅 액션 바입니다. 파일 선택 여부에 따라 활성 상태가 전환됩니다.

### 6. 헤더 타이포그래피 강화
`.hdr-title`에 `font-weight:900`, `letter-spacing:.04em`, `text-shadow` 적용. 부제(`.hdr-sub`)는 반투명 pill 형태로 표시됩니다.

### 7. 섹션 헤더 액센트 바
`.sec-title`에 `border-left:4px solid var(--accent)`, `padding-left:10px` 적용. 모든 섹션 제목에 자동 적용됩니다.

### 8. 카드 hover 상승
`.card:hover { transform:translateY(-2px) }` 적용. 모든 설정 카드에 인터랙티브 피드백이 제공됩니다.

### 9. 하단 변환 버튼 풀 너비
`.btm .btn-accent { width:100%; max-width:500px; height:48px }`. 글라스모피즘 배경 + `btmShimmer` 애니메이션으로 준비 상태를 시각적으로 강조합니다.

### 10. 드롭존 SVG 아이콘
모든 TXT 드롭존(변환/일괄변환/삽입)의 이모지를 파일 모양 인라인 SVG로 교체. CSS 변수 `color:var(--text3)`으로 다크모드 자동 대응합니다.

### 11. 탭 방향성 전환 애니메이션
`_lastPageIndex` 추적 → 우측 탭 `slideFromRight`, 좌측 탭 `slideFromLeft` 키프레임 적용.

### 12. 결과 카드 연출
변환 완료 시 ① shimmer 효과(0.7초), ② count-up 애니메이션(0→목표값 600ms), ③ 다운로드 버튼 pulseOnce 1회.

### 13. 설정 요약 배지 바
`updateSettingsSummary()`가 chip 배지 방식(`opt-badge`)으로 현재 설정을 한눈에 요약합니다.

### 14. 컬러 테마 스킨 3종
`[data-skin=indigo]`, `[data-skin=forest]` CSS 변수 오버라이드 방식. `setSkin()` / `initSkin()` 함수로 localStorage 영속 저장.

### 15. 모바일 스와이프 탭 전환
`setupSwipe()` IIFE로 touchstart/move/end 이벤트 등록. 52px 이상 수평 스와이프 시 탭 전환. 기존 드래그 정렬과 충돌 없음.

---

## 📊 챕터 통계 (I 시리즈)

| # | 항목 | 구현 |
|---|------|------|
| I1 | `tocItems.body` 직접 저장 | 파싱 시점에 bodyText/bodyLen 저장 → 드래그 재정렬 후에도 정확한 글자수 |
| I2 | 통계 칩 배지 | 총 X만자 · 평균 Xk · ⚠짧은챕터 N |
| I3 | 글자수 포맷 | `4.5k`, `1.2만` 단위 표시 |
| I4 | 짧은 챕터 기준 슬라이더 | 20~500자 범위, `getSuspThreshold()` + localStorage |
| I5 | 짧은 챕터 칩 클릭 → 스크롤 | previewToc 완료 후 이벤트 바인딩 |
| I6 | 글자수 배지 hover → 팝오버 | charBadge mouseover → 본문 앞 3줄 미리보기 |
| I7 | 챕터별 SVG 미니 막대 차트 | `renderTocMiniChart()` + `#tocMiniChart` div |
| I8 | 연속 짧은 챕터 병합 제안 | 3개 이상 연속 시 Toast.warn 자동 감지 (duration 6000ms) |
| I9 | 재감지 delta 표시 | 이전 대비 +N챕터 / ±M만자 Toast.info (HTML 배지 렌더링) |
| I10 | 목차 TXT 내보내기 | `exportTocWithStats()` + 글자수 포함 내보내기 버튼 |

---

## 🐛 버그 수정 (B 시리즈)

| # | 원인 | 수정 |
|---|------|------|
| B1 | `updateTocStat` 글자수 집계 코드 없음 | 활성 챕터의 `totalChars`, `avgChars` 집계 추가 |
| B2 | 드래그 재정렬 시 slice 역전 → 0자 오인식 | `found.push` 시점에 `body`, `bodyLen` 저장 |
| B3 | `Math.round(4500/1000)=5` → "5k자" 올림 표시 | `toFixed(1)+'k'` 방식으로 "4.5k" 정확 표시 |
| B4 | 기준값 50이 두 곳에 하드코딩 | `const SUSP_THRESHOLD` 전역 상수 통일 |
| B5 | `updateTocStat` 글자수 계산에 `item.body` 미사용 | `item.bodyLen` 직접 참조로 교체 |
| B6 | 마지막 챕터 `_fullRawLines.length+1` 슬라이스 오버슈트 | `body` 직접 저장으로 슬라이스 의존 제거 |
| B7 | 툴팁 "50자"가 리터럴 | `SUSP_THRESHOLD+'자 미만이에요'` 상수 참조 |
| B8 | 병합 후 `bodyLen`이 첫 챕터 값만 유지 | 병합 시 모든 body 합산 → `mergedBody`, `mergedBodyLen` 재계산 |
| B9 | `_fullRawLines` 없을 때 빈 `<span>` DOM 잔류 | `_bLen > 0` 조건 체크 후 렌더링 |
| B10 | 비활성 챕터도 총 글자수에 포함 | `if(!t.enabled) return` 조건으로 활성 챕터만 집계 |

---

## 🏗 아키텍처

```
index.html          — 단일 페이지 SPA 마크업 (1,178줄)
├── style.css       — CSS 변수 76개+, 키프레임 14개+ (1,150줄)
├── parser.js       — 텍스트 파싱 엔진 (1,985줄)
├── epub-gen.js     — EPUB3 생성 엔진, Blob Worker 격리 (388줄)
├── main.js         — UI 제어, 이벤트 위임, 상태 관리 (7,498줄)
├── worker.js       — 인코딩 감지·디코딩·챕터 파싱 전담 Web Worker (354줄)
└── sw.js           — Service Worker, 오프라인/PWA 지원 (50줄)
```

> **총 코드량: 11,603줄** | 구문 오류 0개 | 중복 ID 0개

### 상태 관리 (StateManager + Proxy)

| 스토어 | 역할 |
|--------|------|
| `convert` | 변환 탭: txtFiles, coverFile, illFiles, tocItems, epubBlob |
| `batch`   | 일괄변환 탭: txtFiles, coverMap, patterns, results |
| `edit`    | EPUB편집 탭: epubFile, chapters, spineOrder |
| `editIll` | 편집 삽화: files, manualRows |

### 데이터 저장소

| 저장소 | 용도 |
|--------|------|
| `IndexedDB` — `novelepub_hist` | 변환 히스토리 + EPUB Blob |
| `IndexedDB` — `novelepub_settings` | 폰트 데이터, 사용자 칩, 설정 프리셋 |
| `localStorage` | 테마, 스킨, CSS 설정, 변환 옵션, 짧은챕터 기준값 |

---

## 🔤 챕터 패턴 인식

`parser.js`의 `bestPat()` 함수가 본문 전체를 스캔하여 최적 패턴을 자동 선택합니다.

**감지 우선순위** (높음 → 낮음)
1. 빈 줄로 둘러싸인 줄 (가중치 3배)
2. 숫자 연속성 (n→n+1 비율 60% 이상 시 50% 보너스)
3. 패턴 지배도 75% 이상이면 단독 패턴으로 확정
4. 복수 패턴 감지 시 OR 결합 자동 적용

**지원 패턴 그룹 (총 48종)**

| 그룹 | 예시 |
|------|------|
| 화/장 번호 | `제1화`, `1화`, `〈1화〉`, `N부 M화`, `소설명+1화` |
| 챕터/파트 | `Chapter 1`, `Part 1`, `EP.01`, `Act 1` |
| 특수 형식 | `[파일명.txt]`, `[EP.N]`, `NNN  제목`, `【제목】`, `=== [제N화] ===` |
| 키워드 | 프롤로그, 에필로그, 외전, 번외, 서장, 종장, 후기 등 |

---

## 🖼 삽화 처리

### 자동 매핑 규칙 (C-07 강화)

```
16.jpg       → 16화 앞에 삽입
16_1.jpg     → 16화 1번째 삽화 (file_idx 정렬로 순서 보장)
cover.jpg    → 표지로 자동 인식
prologue.jpg → 프롤로그 챕터에 자동 매핑
epilogue.jpg → 에필로그 챕터에 자동 매핑
side.jpg     → 외전 챕터에 자동 매핑
```

---

## 🔧 파일명 메타 인식

**지원 구분자 (8종)**

```
[작가] 제목      → 작가: 작가, 제목: 제목
제목@작가        → 제목: 제목, 작가: 작가
제목 - 작가      → 하이픈 with 공백
제목(작가)       → 괄호
제목[작가]       → 대괄호
제목 by 작가     → 영문 소설
작가의 제목      → '의' 키워드
제목_작가        → 언더스코어 (작가명이 인명 형식일 때만)
```

---

## 🧩 빠른 선택 칩 (A 시리즈)

| 기능 | 설명 |
|------|------|
| **카테고리 접이식** | 화/장번호·챕터/파트·특수형식 3그룹, ▾/▸ 토글 |
| **실시간 카운터** | 클릭 즉시 현재 파일에서 매칭 수를 `<sup>` 배지로 표시 |
| **hover 팝오버** | 400ms 딜레이 후 실제 매칭 줄 5개 미리보기 |
| **충돌 감지** | 2개 이상 선택 시 교집합 50% 초과 → 경고 배너 |
| **사용자 정의 칩** | 직접 입력 패턴 저장·재사용 (IndexedDB) |

---

## ⚡ 성능 최적화

| 항목 | 방식 |
|------|------|
| EPUB 압축 | Blob Worker 격리 (JSZip importScripts) — 메인 스레드 비블로킹 |
| 텍스트 디코딩 | 5MB 이상 파일 → `worker.js` Transferable 위임 |
| 챕터 파싱 | `splitChaptersAsync` 2분 타임아웃 + 동기 폴백 |
| 일괄 변환 | `navigator.hardwareConcurrency` 기반 최대 4개 병렬 슬롯 |
| 이미지 변환 | Promise.all 4개 배치 병렬 + file_idx 정렬로 순서 보장 |
| 목차 렌더링 | 가상 스크롤 (ResizeObserver + rAF, lastStart+lastEnd 추적) |
| 챕터 캐시 | `파일명:크기:lastModified§패턴§설정해시` 키 — 내용 변경 시 자동 무효화 |
| 메모리 관리 | `StateManager.reset()` 시 null 참조 해제 → GC 유도 |
| 정규식 | 루프 외부 사전 컴파일 (`RX_AUTO_PAGE`, `RX_CHAPTER_N` 등) |

---

## 🎨 디자인 시스템

### 테마
- **라이트**: `radial-gradient` 배경 미세 그라데이션
- **다크**: `#121212` 기반, warm-slate 텍스트, 채도 낮춘 포인트 컬러
- CSS 변수 76개+ + 키프레임 애니메이션 14개+
- JS `initTheme()` 우선, OS `prefers-color-scheme` 폴백

### 컬러 스킨 3종
| 스킨 | 액센트 | 적용 |
|------|--------|------|
| 테라코타 (기본) | `#d45a46` | 기본값, `data-skin` 없음 |
| 인디고 블루 | `#4855a8` | `[data-skin=indigo]` |
| 포레스트 그린 | `#2a7a4a` | `[data-skin=forest]` |

### 인터랙션

| 요소 | 동작 |
|------|------|
| 버튼 | hover `translateY(-1px)` 엠보싱, active `scale(.98)` 디보싱 |
| 드롭존 | dragover 시 점선→실선, `scale(1.02)`, 브랜드 컬러 강조 |
| 카드 | hover `translateY(-2px)` 상승 + `shadow-lg` |
| 업로드 완료 | `checkPop` keyframe 체크 팝 애니메이션 |
| 테마 스위처 | `themeFlip` keyframe 360° 회전 |
| 진행 스테퍼 | `stepBlink` keyframe 현재 단계 글로우 |
| 복사 버튼 | `tooltipFade` 1초 "복사됨!" 툴팁 |
| 미니 리더 | `readerFlash` 0.4초 설정 변경 플래시 |
| 결과 카드 | shimmer → count-up → pulseOnce 3단계 연출 |
| 탭 전환 | `slideFromRight` / `slideFromLeft` 방향성 애니메이션 |

---

## ⌨️ 키보드 단축키

| 단축키 | 기능 |
|--------|------|
| `Ctrl+Enter` | ✨ 변환 시작 |
| `Ctrl+P` | 🔍 목차 확인 |
| `Ctrl+Shift+P` | 👁 미리보기 |
| `Ctrl+D` | ⬇ 다운로드 |
| `Ctrl+Z` | ↩ 목차 Undo |
| `Ctrl+클릭` | 목차 다중 선택/병합 |
| `Ctrl+?` | ⌨️ 단축키 도움말 |
| `Esc` | 모달 닫기 |

---

## 📦 파일 구조

```
novel2epub/
├── index.html      # 메인 HTML (SPA, 1,178줄)
├── main.js         # UI 제어, StateManager, 이벤트 위임, 변환 흐름 (7,498줄)
├── parser.js       # 텍스트 파싱, 목차 추출, 가상 스크롤 (1,985줄)
├── epub-gen.js     # EPUB3 생성, Blob Worker, 이미지 병렬 처리 (388줄)
├── worker.js       # Web Worker: 인코딩 감지·디코딩·챕터 파싱 (354줄)
├── sw.js           # Service Worker: 오프라인 캐시, PWA (50줄)
├── style.css       # 테마·컴포넌트·애니메이션 (1,150줄)
└── README.md
```

> **총 코드량: 11,603줄** | 구문 오류 0개 | 중복 ID 0개

### 외부 의존성 (CDN — Service Worker에 의해 오프라인 캐시됨)

| 라이브러리 | 용도 | 버전 |
|-----------|------|------|
| [JSZip](https://stuk.github.io/jszip/) | EPUB ZIP 패키징 | 3.10.1 |

---

## 🚀 시작하기

```bash
# 로컬 서버 예시
npx serve .
# 또는
python3 -m http.server 8080
```

브라우저에서 `http://localhost:8080` 접속 후 TXT 파일을 드래그&드롭하면 됩니다.

### Cloudflare Pages 배포

```bash
# 저장소 루트에 파일들이 있으면 바로 배포 가능
# Build command: (없음)
# Output directory: /
```

### PWA 설치

Chrome/Edge에서 주소창 우측 설치 아이콘 클릭 → 홈화면에 추가.  
이후 오프라인 상태에서도 변환 가능 (Service Worker 캐시).

---

## 🔒 보안 & 프라이버시

- **서버 업로드 없음**: 모든 파일 처리가 브라우저 내에서 완료
- **XSS 방지**: Toast confirm/prompt 모두 DOM API (`textContent`) 사용. Toast 메시지는 내부 생성 HTML(I9 delta 배지)에만 `innerHTML` 허용하며 외부 입력은 textContent로 처리
- **입력 이스케이프**: `escHtml()`, `escAttr()`, `sanitizeLine()` 적용
- **Content Security Policy** 호환: 인라인 스크립트 없음
- **정규식 안전화**: `buildCombinedPat` `^`/`$`/`|` 포함 패턴 안전 그룹화, 백트래킹 최적화

---

## 📋 브라우저 지원

| 기능 | 최소 버전 |
|------|----------|
| Web Worker | Chrome 4+, Firefox 3.5+ |
| Service Worker | Chrome 40+, Firefox 44+ |
| IndexedDB | Chrome 24+, Firefox 16+ |
| Transferable ArrayBuffer | Chrome 17+, Firefox 18+ |
| `navigator.hardwareConcurrency` | Chrome 37+, Firefox 48+ |

> **권장**: Chrome 90+ / Firefox 90+ / Safari 15+ / Edge 90+

---

## 🧪 코드 품질 지표

| 항목 | 수치 |
|------|------|
| 총 줄수 | 11,603줄 |
| 구문 오류 | 0개 (`node --check` 전 파일 통과) |
| 중복 ID | 0개 |
| 하드코딩 색상 | 0개 (전부 CSS 변수) |
| Toast innerHTML | 내부 생성 HTML(delta 배지)만 허용, 외부 입력 textContent 처리 |
| Web API 폴백 | FileReader → ArrayBuffer → readAsText 이중 폴백 |
| 타임아웃 보호 | fileToText 30초, splitChapters 2분 |
| IndexedDB 경합 | `_dbPromise` 싱글톤으로 완전 해결 |

---

## 📝 아키텍처 진화

```
단순 FileReader + 동기 ZIP 생성
   ↓
Web Worker 격리 + Transferable ArrayBuffer
   ↓
StateManager(Proxy) + EventBus + 탭별 상태 격리
   ↓
Service Worker 캐시 + IndexedDB 영속화 + 병렬 처리
   ↓
meta-block 계층 분리 + opt-card 2단 레이아웃
+ mini-reader 실시간 미리보기 + regex-feed 피드백 패널
+ btm-status 스티키 변환 바
   ↓
컬러 스킨 3종 + 모바일 스와이프 탭 + 챕터 통계 (I 시리즈)
+ B 시리즈 버그 수정 10개 + Toast HTML 지원 (I9 delta)
+ 드롭존 전면 SVG 교체 (일괄변환·삽입 포함)
```

---

## 📄 라이선스

MIT License

---

*NovelEPUB — 소설을 전자책으로, 빠르고 안전하게.*
