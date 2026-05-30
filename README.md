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

## 🎨 UI/UX 개선 사항 (최신 5가지)

### 1. 시각 계층 강화 — `meta-block` 섹션 분리
설정 폼을 `📖 기본 정보`와 `⚙️ 장/화 분할 규칙` 두 블록으로 분리합니다. 각 블록은 구분선과 대문자 레이블(`meta-block-title`)로 명확히 구획되어, 처음 사용자도 설정 항목을 직관적으로 파악할 수 있습니다.

```
┌──────────────────────────────┐
│ 📖 기본 정보 ─────────────── │  ← meta-block
│  제목 · 작가 · 표지 · 폰트   │
├──────────────────────────────┤
│ ⚙️ 장/화 분할 규칙 ────────  │  ← meta-block
│  패턴 칩 · 정규식 · 옵션    │
└──────────────────────────────┘
```

### 2. 메타데이터 영역 분리 — `opt-card-layout` 2단 그리드
옵션 패널을 **좌측 설정 컬럼(1fr)** + **우측 미니 리더 컬럼(260px)** 2단 그리드로 나누어, 설정과 미리보기를 한 화면에서 동시에 확인할 수 있습니다. 모바일에서는 자동으로 1단 세로 배치로 전환됩니다.

### 3. 미니 리더 미리보기 — `mini-reader`
EPUB 스타일 설정(폰트·줄간격·배경색·글자색) 변경 시 **0.4초 플래시 애니메이션**과 함께 우측 미니 리더에 실시간으로 반영됩니다. 목차가 존재하면 첫 챕터의 실제 본문(200자)을 불러와 표시하며, 하단 스탯 배지에 현재 적용된 폰트·줄간격·크기를 요약합니다.

```
┌─ 미리보기 ─────────────────────────────────┐
│  1화 — 시작                                │  ← 실제 챕터명
│  가나다라마바사아자차카타파하. 한글 소설…   │  ← 첫 챕터 본문 200자
│    — 이것은 회상 대사입니다.              │  ← italic em
├──────────────────────────────────────────── │
│ [폰트 Noto Serif KR] [줄간격 1.9] [1em]   │  ← 스탯 배지
└────────────────────────────────────────────┘
```

### 4. 실시간 피드백 피드 — `regex-feed`
패턴 칩 선택 또는 정규식 입력 후 목차가 갱신될 때마다 `#regexFeed` 패널이 노출됩니다. 감지된 챕터 수 배지, 짧은 챕터 경고, 실제 매칭된 줄 5개 미리보기, 짧은 챕터 비율 통계를 스크롤 가능한 목록으로 표시합니다. 목차가 없을 때는 패널이 자동으로 숨겨집니다.

```
┌─ 🔍 패턴 감지 결과 ──── [18]개 장 감지됨 ─┐
│  ✔ 1화 — 프롤로그                (184자)  │
│  ✔ 2화 — 첫 만남                (2,341자) │
│  ⚠ 3화 — 짧은 챕터              (31자)   │
│  ...                                      │
│  짧은 챕터 1개 (5.6%)                     │
└────────────────────────────────────────────┘
```

### 5. 스티키 변환 바 — `btm-status` 플로팅 바
하단에 항상 고정된 플로팅 액션 바입니다. 파일이 선택되지 않으면 `선택 안 됨`(회색), 파일이 선택되면 파일명 또는 파일 수와 용량(초록색)이 표시됩니다. `ready` 클래스와 연동하여 변환 버튼의 활성 상태도 함께 전환됩니다.

```
┌──────────────────────────────────────────────────┐
│  파일  소나기.txt (142KB)    [🚀 EPUB 변환하기]  │  ← btm-status 플로팅 바
└──────────────────────────────────────────────────┘
```

---

## 🏗 아키텍처

```
index.html          — 단일 페이지 SPA 마크업 (1,121줄)
├── style.css       — CSS 변수 76개, 키프레임 11개 (746줄)
├── parser.js       — 텍스트 파싱 엔진 (1,928줄)
├── epub-gen.js     — EPUB3 생성 엔진, Blob Worker 격리 (388줄)
├── main.js         — UI 제어, 이벤트 위임, 상태 관리 (7,142줄)
├── worker.js       — 인코딩 감지·디코딩·챕터 파싱 전담 Web Worker (354줄)
└── sw.js           — Service Worker, 오프라인/PWA 지원 (50줄)
```

> **총 코드량: 11,729줄** | 구문 오류 0개 | 중복 ID 0개

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
| `localStorage` | 테마, CSS 설정, 변환 옵션 |

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

### 이미지 처리 파이프라인

1. `resizeCoverIfNeeded()` — 표지 1200px 이하로 리사이징
2. `processImagesParallel()` — `IMG_CONCURRENCY = 4` 배치 병렬 변환
3. PNG/GIF/WebP → JPEG 자동 변환 (옵션)
4. Transferable ArrayBuffer로 Blob Worker에 zero-copy 전달

---

## 🔧 파일명 메타 인식

TXT 파일 업로드 시 제목·작가명을 자동 추출합니다.

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

**추가 인식 전략**

- **본문 첫 10줄 스캔**: `제목: `, `작가: `, `저자: ` 레이블 자동 파싱
- **다중 파일 LCP**: 여러 파일의 최장 공통 접두사를 제목으로 추론
- **제목 후처리**: 날짜 접두사, `완결`, `N권`, `N부`, 범위 표시 자동 제거
- **신뢰도 배지**: 높음/보통/낮음 표시 + 낮음이면 입력창 테두리 강조

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
- CSS 변수 76개 + 키프레임 애니메이션 11개
- JS `initTheme()` 우선, OS `prefers-color-scheme` 폴백

### 인터랙션

| 요소 | 동작 |
|------|------|
| 버튼 | hover `translateY(-1px)` 엠보싱, active `scale(.98)` 디보싱 |
| 드롭존 | dragover 시 점선→실선, `scale(1.02)`, 브랜드 컬러 강조 |
| 업로드 완료 | `checkPop` keyframe 체크 팝 애니메이션 |
| 테마 스위처 | `themeFlip` keyframe 360° 회전 |
| 진행 스테퍼 | `stepBlink` keyframe 현재 단계 글로우 |
| 복사 버튼 | `tooltipFade` 1초 "복사됨!" 툴팁 |
| 미니 리더 | `readerFlash` 0.4초 설정 변경 플래시 |

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
├── index.html      # 메인 HTML (SPA, 1,121줄)
├── main.js         # UI 제어, StateManager, 이벤트 위임, 변환 흐름 (7,142줄)
├── parser.js       # 텍스트 파싱, 목차 추출, 가상 스크롤 (1,928줄)
├── epub-gen.js     # EPUB3 생성, Blob Worker, 이미지 병렬 처리 (388줄)
├── worker.js       # Web Worker: 인코딩 감지·디코딩·챕터 파싱 (354줄)
├── sw.js           # Service Worker: 오프라인 캐시, PWA (50줄)
├── style.css       # 테마·컴포넌트·애니메이션 (746줄)
└── README.md
```

### 외부 의존성 (CDN — Service Worker에 의해 오프라인 캐시됨)

| 라이브러리 | 용도 | 버전 |
|-----------|------|------|
| [JSZip](https://stuk.github.io/jszip/) | EPUB ZIP 패키징 | 3.10.1 |

---

## 🚀 시작하기

### 바로 사용

별도 빌드 없이 정적 파일 그대로 서빙합니다.

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
- **XSS 방지**: Toast, confirm, prompt 모두 `innerHTML` → DOM API (`textContent`) 전면 교체
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
| 총 줄수 | 11,729줄 |
| 구문 오류 | 0개 (`node --check` 전 파일 통과) |
| 중복 ID | 0개 |
| 하드코딩 색상 | 0개 (전부 CSS 변수) |
| `innerHTML` (Toast) | 0개 (DOM API 전면 교체) |
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
```

---

## 📄 라이선스

MIT License

---

*NovelEPUB — 소설을 전자책으로, 빠르고 안전하게.*
