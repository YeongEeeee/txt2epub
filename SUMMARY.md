# NovelEPUB 개발 세션 Summary

## 프로젝트 개요

**NovelEPUB** — TXT → EPUB3 변환기  
순수 프론트엔드 SPA. 서버 없이 브라우저에서 모든 처리 완료.  
총 코드량: **11,603줄** (main.js 7,498 + parser.js 1,985 + 기타)

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

1. **메모리 관리**: StateManager `reset()` null 참조 해제, 배열 교체 시 `.length=0`
2. **UI 렌더링**: `createVirtualScroll` lastEnd 추적, ResizeObserver, dynamic viewH
3. **Web Worker 도입**: `epub-gen.js` JSZip → Blob Worker 격리
4. **Regex 최적화**: `buildCombinedPat` 안전 그룹화, PAT_PRESETS `.*` → `[^\r\n]*`
5. **CSS 변수 일관성**: `getCssVar()` 헬퍼, `generateTextCover` 하드코딩 색상 제거
6. **비동기 에러 핸들링**: `addImg` try-catch 단일 이미지 실패 시 Toast.warn 후 계속
7. **웹 접근성**: `.toc-drag-handle` tabindex/role/aria-label, `.sw-slider` aria-hidden
8. **다크모드 단일화**: CSS `@media` → `:root:not([data-theme])` 조건
9. **IndexedDB 전환**: `SettingsDB` 모듈, 커스텀 폰트 base64 IDB 저장

---

### Phase 3 — EPUB 생성 엔진 최적화 (4가지 개선)

1. **Worker 격리**: `launchEpubWorker()` Blob Worker, `buildEpub()` 하위 호환 래퍼
2. **이미지 병렬 처리**: `IMG_CONCURRENCY=4` 배치 Promise.all, file_idx 정렬
3. **Streaming**: `streamFiles:true` DEFLATE+STORE, Two-Pass 압축
4. **루프 최적화**: `RX_AUTO_PAGE`, `RX_CHAPTER_N` 사전 컴파일, `makeMatchIll()` 팩토리

#### HTML 중복 제거
- `index.html` 535줄 중복 블록 2개 제거 (1563줄 → 1028줄)
- 중복 ID 96개 → 0개

---

### Phase 4 — UI/UX 리디자인 (스타일 전면 개편)

- 라이트: `radial-gradient` 배경 미세 그라데이션
- 다크: `#121212` 기반, warm-slate 텍스트, 채도 낮춘 포인트 컬러
- 그림자 시스템: `--shadow-xs/sm/md/lg/xl`
- 버튼 엠보싱/디보싱, 드롭존 .over 강조, 체크 팝 애니메이션
- `.code-badge` 정규식 가이드 배지 (JetBrains Mono)
- `:focus-visible` 포커스 링 전체 컴포넌트 적용

---

### Phase 5 — 텍스트 Worker + 추가 최적화

#### worker.js 신규 생성 (354줄)
- `DETECT_ENCODING`, `DECODE_TEXT`, `FILE_TO_TEXT`, `PARSE_CHAPTERS`, `PROCESS_FILES`
- 5000줄마다 PROGRESS 발송

#### main.js TextWorker 모듈
- 5MB 이상 → Transferable ArrayBuffer Worker 위임, 실패 시 자동 폴백

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
| C-01 | parser.js | 목차 드래그 병합 | Ctrl+클릭 다중선택, 병합 툴바 |
| C-02 | main.js | EPUB 예상 크기 | 변환 버튼 옆 실시간 계산 배지 |
| C-03 | sw.js (신규) | Service Worker/PWA | 핵심 에셋 캐시, 오프라인 폴백 |
| C-04 | main.js | 리더 시뮬 미리보기 | ☀️/📜/🌙 테마 스위처 |
| C-05 | parser.js | 챕터 통계 | 총 글자수·평균·짧은/긴 챕터 경고 배지 |
| C-06 | main.js | 설정 프리셋 | `SettingsPreset` 모듈, 저장/불러오기/삭제 UI |
| C-07 | epub-gen.js | 삽화 자동 인식 | `KEYWORD_MAP`, 16_1.jpg 순서 보장 |
| C-08 | main.js | 변환 오류 리포트 | 완료 후 `#convertReport` 경고 항목 요약 |
| C-09 | main.js | 키보드 단축키 | Ctrl+P, Ctrl+Shift+P, Ctrl+Z 추가 |
| C-10 | main.js | 병렬 일괄 변환 | `hardwareConcurrency` 기반 최대 4개 슬롯 |

---

### Phase 7 — UI/UX 모던화 2차 (10가지 스타일 개선)

#### CSS 전용 (style.css)
| # | 항목 | 구현 |
|---|------|------|
| 01 | 헤더 타이포그래피 | `.hdr-title` font-weight:900, letter-spacing, text-shadow. `.hdr-sub` 반투명 pill |
| 02 | 섹션 헤더 액센트 바 | `.sec-title` border-left:4px solid var(--accent), padding-left:10px |
| 03 | 카드 hover 상승 | `.card:hover` translateY(-2px) + shadow-lg |
| 04 | btm 버튼 풀 너비 | `.btm .btn-accent` width:100%, max-width:500px, height:48px, 글라스모피즘 |

#### HTML + CSS (index.html + style.css)
| # | 항목 | 구현 |
|---|------|------|
| 05 | 드롭존 SVG 아이콘 | 변환·일괄변환·삽입 드롭존 `📄` 이모지 → 인라인 SVG (var(--text3) 테마 대응) |
| 06 | 탭 방향성 전환 | `_lastPageIndex` 추적 → slideFromRight / slideFromLeft 키프레임 |
| 07 | 결과 카드 연출 | shimmer 0.7초 + count-up 600ms + pulseOnce 다운로드 버튼 |
| 08 | 설정 요약 배너 | `updateSettingsSummary()` opt-badge 칩 방식 전면 재작성 |

#### 디자인 시스템 (main.js + style.css + index.html)
| # | 항목 | 구현 |
|---|------|------|
| 09 | 컬러 테마 스킨 3종 | `[data-skin=indigo]`, `[data-skin=forest]` CSS 변수 오버라이드. `setSkin()` / `initSkin()` localStorage 영속 |
| 10 | 모바일 스와이프 탭 | `setupSwipe()` IIFE, 52px+ 수평 스와이프 탭 전환, 수직 스크롤 자동 비활성화 |

---

### Phase 8 — 챕터 통계 고도화 (B 시리즈 버그 수정 + I 시리즈 개선)

#### B 시리즈 — 버그 수정 10개 (parser.js)
| # | 원인 | 수정 |
|---|------|------|
| B1 | updateTocStat 글자수 집계 없음 | 활성 챕터 totalChars, avgChars 집계 추가 |
| B2 | 드래그 재정렬 시 slice 역전 | found.push 시점에 body, bodyLen 저장 |
| B3 | Math.round 올림 표시 | toFixed(1)+'k' 방식으로 4.5k 정확 표시 |
| B4 | 기준값 50 하드코딩 중복 | const SUSP_THRESHOLD 전역 상수 통일 |
| B5 | updateTocStat item.body 미사용 | item.bodyLen 직접 참조 |
| B6 | 마지막 챕터 슬라이스 오버슈트 | body 직접 저장, 슬라이스 의존 제거 |
| B7 | 툴팁 "50자" 리터럴 | SUSP_THRESHOLD+'자 미만' 상수 참조 |
| B8 | 병합 후 bodyLen 첫 챕터 값만 유지 | mergedBody, mergedBodyLen 재계산 |
| B9 | _fullRawLines 없을 때 빈 DOM 잔류 | _bLen > 0 조건 체크 |
| B10 | 비활성 챕터 글자수 포함 | if(!t.enabled) return 조건 |

#### I 시리즈 — 개선 10개 (main.js + parser.js)
| # | 항목 | 구현 |
|---|------|------|
| I1 | tocItems.body 직접 저장 | 파싱 시점 bodyText/bodyLen 저장 |
| I2 | 통계 칩 배지 | 총 X만자 · 평균 Xk · ⚠짧은챕터 N |
| I3 | 글자수 포맷 | 4.5k, 1.2만 단위 표시 |
| I4 | 짧은 챕터 기준 슬라이더 | 20~500자, getSuspThreshold() + localStorage |
| I5 | 짧은 챕터 칩 클릭 → 스크롤 | previewToc 완료 후 이벤트 바인딩 |
| I6 | 글자수 배지 hover → 팝오버 | charBadge mouseover → 본문 앞 3줄 |
| I7 | 챕터별 SVG 미니 막대 차트 | renderTocMiniChart() + #tocMiniChart div |
| I8 | 연속 짧은 챕터 병합 제안 | 3개 이상 연속 → Toast.warn(msg, 6000) |
| I9 | 재감지 delta 표시 | Toast.info(HTML배지, 4000) — delta 색상 강조 |
| I10 | 목차 TXT 내보내기 | exportTocWithStats() + 글자수 포함 버튼 |

---

### Phase 9 — Toast 개선 및 드롭존 SVG 완결 (main.js + index.html)

#### Toast 개선 (main.js)
- **`_show()` HTML 지원**: msg에 `<tag>` 패턴 포함 시 innerHTML로 렌더링 (I9 delta 배지 색상 표시 목적). 외부 입력(파일명 등)은 textContent 유지
- **public API duration 파라미터 추가**: `info(msg, duration?)`, `success(msg, duration?)`, `error(msg, duration?)`, `warn(msg, duration?)` — I8의 `Toast.warn(msg, 6000)` 정상 작동

#### 드롭존 SVG 완결 (index.html)
- **`#batchTxtDrop`**: `📄` 이모지 → 인라인 SVG (다중 파일 화살표 표시 추가)
- **`#insTxtDrop`**: `📄` 이모지 → 인라인 SVG
- (참고: `#txtDz` 메인 드롭존은 Phase 7에서 이미 SVG 교체 완료)

---

## 코드 품질 지표

| 항목 | 수치 |
|------|------|
| 총 줄수 | 11,603줄 |
| 구문 오류 | 0개 (전 파일 `node --check` 통과) |
| 중복 ID | 0개 |
| 하드코딩 색상 | 0개 (전부 CSS 변수) |
| Toast innerHTML | 내부 생성 HTML만 허용 (I9 delta), 외부 입력 textContent |
| Web API 폴백 | FileReader → ArrayBuffer → readAsText |
| 타임아웃 보호 | fileToText 30초, splitChapters 2분 |
| IndexedDB 경합 | `_dbPromise` 싱글톤 완전 해결 |

---

## 파일별 역할 요약

| 파일 | 줄수 | 역할 |
|------|------|------|
| `main.js` | 7,498 | UI 제어, StateManager, 이벤트 위임, 변환 흐름, Toast |
| `parser.js` | 1,985 | 챕터 파싱, 목차 렌더링, 인코딩, 캐시, 통계 |
| `epub-gen.js` | 388 | EPUB3 생성, Blob Worker, 이미지 병렬 처리 |
| `worker.js` | 354 | 인코딩 감지, 텍스트 디코딩, 경량 파서 |
| `sw.js` | 50 | Service Worker, 오프라인 캐시 |
| `index.html` | 1,178 | SPA 마크업, 탭 구조, SVG 드롭존 |
| `style.css` | 1,150 | 테마, 컴포넌트, 애니메이션, 스킨 시스템 |

---

*Generated from development session logs.*
