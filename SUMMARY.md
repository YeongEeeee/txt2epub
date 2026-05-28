# NovelEPUB 개발 세션 Summary

## 프로젝트 개요

**NovelEPUB** — TXT → EPUB3 변환기  
순수 프론트엔드 SPA. 서버 없이 브라우저에서 모든 처리 완료.  
총 코드량: **11,497줄** (main.js 7,244 + parser.js 1,793 + 기타)

---

## 세션별 작업 이력

### Phase 1 — 구조 안정화

#### 버그 수정
- `main.js` `showErrorBoundary` 고아 본문 (`Illegal return statement`) 제거
- `parser.js` 고아 문자열 연결 코드, `idbSet` try 블록 누락 catch 추가
- Optional Chaining 136곳 추가, 좌변 할당 복원
- `_chaptersCache` 무효화 정책: `파일명:크기:lastModified§패턴§설정해시` 조합 키
- `DataTypes.Integer` 대소문자 오류, `lagitude` 타입 수정

#### 아키텍처 수정
- `SettingsDB._dbPromise` 싱글톤 → 경합 조건 해결
- `fileToText` Promise 안전성: 30초 타임아웃 + done() 래퍼 + 이중 폴백
- `splitChaptersAsync` 2분 타임아웃 + 동기 폴백
- `handleTxt` 디바운스 + `optAutoPreview` null 가드
- `getParserWorker` 중복 if 데드코드 → `resetParserWorker()` 분리
- `StateManager.reset()` 대용량 배열 null 해제 → GC 유도
- `switchPage` contentVisibility='hidden' + `_tabRendered` 지연 렌더링
- `getCssVar` 헬퍼 추가, 하드코딩 색상 → CSS 변수 참조
- `handleCustomFont` parser.js → main.js 이동 (의존성 순서)
- Toast `innerHTML` → DOM API 전면 교체 (XSS 방지)

---

### Phase 2 — 성능 최적화 (9가지 개선)

#### 1. 메모리 관리
- StateManager `reset()`: 기존 배열 null 참조 해제 후 새 배열 생성
- `set()` 배열 교체 시 기존 `.length=0` 후 새 참조로 교체

#### 2. UI 렌더링 성능
- `createVirtualScroll`: lastEnd 추적, ResizeObserver, update() API, dynamic viewH
- 비활성 탭 `contentVisibility:hidden`, 첫 방문 시 1회만 렌더링

#### 3. Web Worker 도입
- `epub-gen.js` JSZip 압축 → Blob Worker 격리 (메인 스레드 완전 비블로킹)
- yieldToMain 완전 제거

#### 4. Regex 최적화
- `buildCombinedPat`: `^`, `$`, `|` 포함 패턴 안전 그룹화
- PAT_PRESETS: `.*` → `[^\r\n]*`, lookahead(`(?=\d+화)`) 제거
- 루프 외부 정규식 사전 컴파일 (`RX_AUTO_PAGE`, `RX_CHAPTER_N`)

#### 5. CSS 변수 일관성
- `getCssVar()` 헬퍼, `generateTextCover` 하드코딩 색상 → CSS var 참조

#### 6. 비동기 에러 핸들링
- `addImg` try-catch: 단일 이미지 실패 시 전체 중단 없이 Toast.warn 후 계속
- `imgIdx++` 유지 → 파일명 충돌 방지

#### 7. 웹 접근성 (A11y)
- `.toc-drag-handle`: tabindex=0, role=button, aria-label
- `.sw-slider`: aria-hidden=true (20개)
- 탭 내비게이션: role=tablist + role=tab

#### 8. 다크모드 단일화
- CSS `@media(prefers-color-scheme:dark)` → `:root:not([data-theme])` 조건
- JS `initTheme()` localStorage 우선

#### 9. IndexedDB 전환
- `SettingsDB` 모듈: 커스텀 폰트 base64 → IDB 저장 (localStorage 5MB 제한 우회)

---

### Phase 3 — EPUB 생성 엔진 최적화 (4가지 개선)

#### epub-gen.js 전면 개편
1. **Worker 격리**: `launchEpubWorker()` Blob Worker, `buildEpub()` 하위 호환 래퍼
2. **이미지 병렬 처리**: `IMG_CONCURRENCY=4` 배치 Promise.all, file_idx 정렬 순서 보장
3. **Streaming**: `streamFiles:true` DEFLATE+STORE, Two-Pass 압축
4. **루프 최적화**: `RX_AUTO_PAGE`, `RX_CHAPTER_N` 사전 컴파일, `makeMatchIll()` 팩토리

#### HTML 중복 제거
- `index.html` 535줄 중복 블록 2개 제거 (1563줄 → 1028줄)
- 중복 ID 96개 → 0개

#### matchIll 버그 수정
- `if(il.idx)` falsy 체크 → `typeof il.idx === 'number'` (인덱스 0 정상 처리)

---

### Phase 4 — UI/UX 리디자인 (스타일 전면 개편)

#### style.css 전면 재작성 (495 → 580줄)
- 라이트: `radial-gradient` 배경 미세 그라데이션
- 다크: `#121212` 기반, warm-slate 텍스트, 채도 낮춘 포인트 컬러
- 그림자 시스템: `--shadow-xs/sm/md/lg/xl`
- 트랜지션 변수: `--dur-fast/base/slow`
- 버튼 엠보싱/디보싱: hover translateY(-1px), active scale(.98)
- 드롭존 .over: 점선→실선, scale(1.02), 브랜드컬러 강조
- 체크 팝 애니메이션 (`checkPop`), 스테퍼 글로우 (`stepBlink`)
- 테마 스위처 회전 (`themeFlip`), 복사 툴팁 (`tooltipFade`)
- `.code-badge` 정규식 가이드 배지 (JetBrains Mono)
- `:focus-visible` 포커스 링 전체 컴포넌트 적용

#### main.js 추가
- `toggleTheme()` ibtn-icon span 회전 애니메이션
- 복사 툴팁 이벤트 위임 (`[data-copy]` 클릭 → 1초 툴팁)

---

### Phase 5 — 텍스트 Worker + 추가 최적화

#### worker.js 신규 생성 (355줄)
- `DETECT_ENCODING`: BOM + UTF-8 오류율 + EUC-KR 비교
- `DECODE_TEXT`: UTF-8 깨짐 감지 시 EUC-KR 재시도
- `FILE_TO_TEXT`: 감지+디코딩 통합 (단일 왕복)
- `PARSE_CHAPTERS`: 5000줄마다 PROGRESS 발송
- `PROCESS_FILES`: 여러 파일 ArrayBuffer 일괄 처리

#### main.js TextWorker 모듈
- 5MB 이상 → Transferable ArrayBuffer Worker 위임
- 실패 시 메인 스레드 자동 폴백

#### 하단 버튼 바 복구
- `#btmConvert`, `#btmBatch`, `#btmEdit` div 누락 → 재추가
- `data-action` 이름 main.js 핸들러와 정확히 일치

---

### Phase 6 — 20가지 개선 (빠른 선택 + 파일명 인식 + 추가)

#### A. 빠른 선택 칩 5가지

| # | 항목 | 구현 |
|---|------|------|
| A-01 | 실시간 카운터 | 클릭 즉시 `_fullRawLines` 카운팅 → `<sup class="chip-count">` 배지 |
| A-02 | 카테고리 접이식 | `PAT_PRESET_GROUPS` 3그룹 + ▾/▸ 토글 |
| A-03 | 사용자 칩 저장 | SettingsDB `userPatChips` + "＋ 저장" + ✕ 삭제 |
| A-04 | hover 팝오버 | 400ms 딜레이, 실제 매칭 줄 5개 fixed 팝오버 |
| A-05 | 충돌 감지 | 2개 이상 선택 시 교집합 50% 초과 → 경고 배너 |

#### B. 파일명·본문 메타 인식 5가지

| # | 항목 | 구현 |
|---|------|------|
| B-01 | 구분자 8종 확장 | [작가], @, ` - `, `_`, `()`, `[]`, by, 의 |
| B-02 | 본문 첫 10줄 스캔 | `제목:`, `작가:`, `저자:` 레이블 자동 파싱 |
| B-03 | 제목 후처리 정규화 | 날짜 접두사, 완결, N권, N부, 범위 표시 제거 |
| B-04 | 다중파일 LCP | 최장 공통 접두사 → 제목 후보 |
| B-05 | 신뢰도 배지 | ● 높음/보통/낮음 + 낮음 시 입력창 강조 |

#### C. 추가 개선 10가지

| # | 파일 | 항목 | 구현 |
|---|------|------|------|
| C-01 | parser.js | 목차 드래그 병합 | Ctrl+클릭 다중선택, 병합 툴바 (기존 코드 확인·유지) |
| C-02 | main.js | EPUB 예상 크기 | 변환 버튼 옆 실시간 계산 배지 (20MB+ 경고색) |
| C-03 | sw.js (신규) | Service Worker/PWA | 핵심 에셋 캐시, 오프라인 폴백, 홈화면 설치 |
| C-04 | main.js | 리더 시뮬 미리보기 | ☀️화이트/📜세피아/🌙다크 테마 스위처 |
| C-05 | parser.js | 챕터 통계 | 총 글자수·평균·짧은/긴 챕터 경고 배지 |
| C-06 | main.js | 설정 프리셋 | `SettingsPreset` 모듈, 저장/불러오기/삭제 UI |
| C-07 | epub-gen.js | 삽화 자동 인식 | `KEYWORD_MAP`, 16_1.jpg 순서 보장 |
| C-08 | main.js | 변환 오류 리포트 | 완료 후 `#convertReport` 경고 항목 요약 |
| C-09 | main.js | 키보드 단축키 | Ctrl+P, Ctrl+Shift+P, Ctrl+Z 추가 |
| C-10 | main.js | 병렬 일괄 변환 | `hardwareConcurrency` 기반 최대 4개 슬롯 |

---

## 코드 품질 지표

| 항목 | 수치 |
|------|------|
| 총 줄수 | 11,497줄 |
| 구문 오류 | 0개 (전 파일 `node --check` 통과) |
| 중복 ID | 0개 |
| 하드코딩 색상 | 0개 (전부 CSS 변수) |
| `innerHTML` 사용 | Toast 내 0개 (DOM API 교체) |
| Web API 폴백 | FileReader → ArrayBuffer → readAsText |
| 타임아웃 보호 | fileToText 30초, splitChapters 2분 |
| IndexedDB 경합 | `_dbPromise` 싱글톤 완전 해결 |

---

## 파일별 역할 요약

| 파일 | 줄수 | 역할 |
|------|------|------|
| `main.js` | 7,244 | UI 제어, StateManager, 이벤트 위임, 변환 흐름 |
| `parser.js` | 1,793 | 챕터 파싱, 목차 렌더링, 인코딩, 캐시 |
| `epub-gen.js` | 410 | EPUB3 생성, Blob Worker, 이미지 병렬 처리 |
| `worker.js` | 355 | 인코딩 감지, 텍스트 디코딩, 경량 파서 |
| `sw.js` | 51 | Service Worker, 오프라인 캐시 |
| `index.html` | 1,049 | SPA 마크업, 탭 구조 |
| `style.css` | 595 | 테마, 컴포넌트, 애니메이션 |

---

*Generated from development session logs.*
