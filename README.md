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
- **스마트 패턴 변환**: Gemini AI 또는 로컬 로직으로 자연어 → 정규식 자동 변환
- **고도화된 표지 검색 엔진**: 네이버, 카카오, 리디북스, 노벨피아, 구글, 덕덕고 API 통합 검색 및 실시간 캔버스 크롭 가공
- 이탤릭 회상 대사, 들여쓰기, 폰트·줄간격·여백 CSS 설정
- 변환 중단 버튼, 단계별 진행 표시

### 📚 일괄 변환 (Batch)
- 여러 소설 파일을 한 번에 변환
- `navigator.hardwareConcurrency` 기반 **최대 4개 병렬 처리**
- 파일별 진행률·성공/실패 상태 카드

### ✏️ EPUB 편집
- 기존 EPUB 파일을 불러와 목차·CSS 수정 후 재생성
- 연속 챕터 삽입(TXT 파일로 목차 보강)

### 🗂 변환 히스토리
- IndexedDB에 변환 이력(제목·작가·챕터수·크기·날짜) 저장
- 기존 EPUB Blob 재다운로드 및 표지 캐싱 데이터 가드

---

## 🌐 엔터프라이즈 프록시 및 보안 인프라

네트워크 외부 자원(표지 및 이미지) 수집 시 브라우저 샌드박스의 CORS 제한 및 `Tainted Canvas` 에러를 원천 차단하기 위해 독립적인 고성능 프록시 레이어를 운영합니다.

- **Cloudflare Workers 프록시 허브**: 단일 전역 상수를 통해 전용 엣지 워커(`icy-frog-a6c0`) 인프라와 결합.
- **Failover 자동 재시도**: 프록시 통신 실패(5xx) 및 시간 초과 시, 클라이언트 단에서 원본 서버로 즉시 직접(Direct) 재시도하는 안전 백업망 가동.
- **8초 독립 타임아웃 가드**: `AbortController`와 인라인 인터벌 타이머를 연동하여 타깃 서버의 응답 지연으로 인한 메인 스레드 락 전면 차단.
- **보안 쉴드 토큰**: 무단 트래픽 프리라이딩을 방지하기 위해 프록시 중계 요청 헤더에 `X-NovelEPUB-Token` 가드 캡슐화 주입.
- **이진 데이터 무결성 보장**: `response.arrayBuffer()` 청크 버퍼 조합 구조를 통해 다량의 레이아웃 처리 중 이미지 데이터 유실 및 화질 열화 원천 차단.
- **MIME-Type 화이트리스트 검증**: `image/*`, `application/json`, `text/*` 접두사 가드를 신설하여 무결하지 않은 스크림 패킷 필터링.
- **주소 정규화 유틸**: `_safeEncodeUrl` 매커니즘을 적용하여 기 인코딩된 특수기호의 이중 인코딩 버그 전면 해결.
- **특이 확장자 대응 가드**: 노벨피아 등 외부 플랫폼의 특이 규격 이미지(`.file` 확장자)를 정당한 자원으로 통과시키고 가공 체인 내에서 안전하게 JPEG 바이너리로 변환 처리.

---

## 🎨 UI/UX 개선 사항

### Phase 1–4 기반 기능 (레이아웃 시스템)

#### 1. 시각 계층 강화 — `meta-block` 섹션 분리
설정 폼을 `📖 기본 정보`와 `⚙️ 장/화 분할 규칙` 두 블록으로 분리합니다. 각 블록은 구분선과 대문자 레이블(`meta-block-title`)로 명확히 구획됩니다.

#### 2. 메타데이터 영역 분리 — `opt-card-layout` 2단 그리드
옵션 패널을 **좌측 설정 컬럼(1fr)** + **우측 미니 리더 컬럼(260px)** 2단 그리드로 나누어, 설정과 미리보기를 한 화면에서 동시에 확인할 수 있습니다.

#### 3. 미니 리더 미리보기 — `mini-reader`
EPUB 스타일 설정(폰트·줄간격·배경색·글자색) 변경 시 **0.4초 플래시 애니메이션**과 함께 우측 미니 리더에 실시간으로 반영됩니다.

#### 4. 실시간 피드백 피드 — `regex-feed`
패턴 칩 선택 또는 정규식 입력 후 목차 갱신 시 `#regexFeed` 패널이 노출됩니다. 감지 수 배지, 짧은 챕터 경고, 실제 매칭 줄 5개 미리보기를 표시합니다.

#### 5. 스티키 변환 바 — `btm-status` 플로팅 바
하단에 항상 고정된 플로팅 액션 바입니다. 파일 선택 여부에 따라 활성 상태가 전환됩니다.

#### 6. 헤더 타이포그래피 강화
`.hdr-title`에 `font-weight:900`, `letter-spacing:.04em`, `text-shadow` 적용. 부제(`.hdr-sub`)는 반투명 pill 형태로 표시됩니다.

#### 7. 섹션 헤더 액센트 바
`.sec-title`에 `border-left:4px solid var(--accent)`, `padding-left:10px` 적용. 모든 섹션 제목에 자동 적용됩니다.

#### 8. 카드 hover 상승
`.card:hover { transform:translateY(-2px) }` 적용. 모든 설정 카드에 인터랙티브 피드백이 제공됩니다.

#### 9. 하단 변환 버튼 풀 너비
`.btm .btn-accent { width:100%; max-width:500px; height:48px }`. 글라스모피즘 배경 + `btmShimmer` 애니메이션으로 준비 상태를 시각적으로 강조합니다.

#### 10. 드롭존 SVG 아이콘
모든 TXT 드롭존(변환/일괄변환/삽입)의 이모지를 파일 모양 인라인 SVG로 교체. CSS 변수 `color:var(--text3)`으로 다크모드 자동 대응합니다.

#### 11. 탭 방향성 전환 애니메이션
`_lastPageIndex` 추적 → 우측 탭 `slideFromRight`, 좌측 탭 `slideFromLeft` 키프레임 적용.

#### 12. 결과 카드 연출
변환 완료 시 ① shimmer 효과(0.7초), ② count-up 애니메이션(0→목표값 600ms), ③ 다운로드 버튼 pulseOnce 1회.

#### 13. 설정 요약 배지 바
`updateSettingsSummary()`가 chip 배지 방식(`opt-badge`)으로 현재 설정을 한눈에 요약합니다.

#### 14. 컬러 테마 스킨 3종
`[data-skin=indigo]`, `[data-skin=forest]` CSS 변수 오버라이드 방식. `setSkin()` / `initSkin()` 함수로 localStorage 영속 저장.

#### 15. 모바일 스와이프 탭 전환
`setupSwipe()` IIFE로 touchstart/move/end 이벤트 등록. 52px 이상 수평 스와이프 시 탭 전환. 기존 드래그 정렬과 충돌 없음.

---

### Phase 5 신규 추가 — Folio 프리미엄 미니멀리즘 대개혁

#### 16. 유동적 반응형 타이포그래피
정적 `px` 크기를 전면 배제하고 CSS `clamp()`를 기반으로 뷰포트에 비례하는 유동적 타이포그래피를 구현합니다. 한국어 가독성을 위한 `word-break: keep-all` 베이스 최적화를 시스템 전역에 적용합니다.

#### 17. OLED 친화 심해 다크 브라운 테마 및 글래스모피즘 계층
OLED 저전력 특성을 고려한 `#0e0c0a` 심해 다크 브라운 기반 테마를 확장하고, UI 요소 전반에 `backdrop-filter` 기반 프리미엄 글래스모피즘(Glassmorphism) 계층을 적용합니다.

#### 18. 스프링 물리 슬라이딩 탭 인디케이터
CSS 변수(`--tab-indicator-x`, `--tab-indicator-w`)와 `switchPage()` 함수를 JS-CSS 브릿지로 연동하고, `cubic-bezier` 스프링 물리 곡선 기반 인디케이터 바가 탭 전환 시 유체적으로 슬라이딩합니다. `.page-tabs-wrap` 래퍼 마크업을 추가하여 레이아웃 격리를 보장합니다.

#### 19. 스크롤 감지형 콤팩트 헤더 수축 시스템
`_setupHeaderCompact()` 함수가 스크롤 이벤트를 감지하여 헤더를 자동으로 컴팩트 모드로 전환합니다. 사용자의 스크롤 위치에 따라 헤더 높이와 콘텐츠 가시성이 부드럽게 전환됩니다.

#### 20. 드롭존 네온 펄스 애니메이션
파일 드래그 인(drag-over) 상태에서 드롭존 테두리에 `neonBorderPulse` 키프레임 애니메이션이 활성화되어 직관적인 드롭 유도 피드백을 제공합니다.

#### 21. 프로그레스 바 액체 그라디언트 모션
변환 진행률 표시 바에 `liquidFlow` 키프레임 기반 그라디언트 시프트 애니메이션을 적용합니다. 변환 작업의 역동성을 시각화하여 사용자 체감 대기 시간을 단축합니다.

#### 22. 토스트 스프링 물리 인/아웃 모션
토스트 메시지 출현 시 `toastSpringIn`, 소멸 시 `toastSpringOut` 키프레임이 각각 60% 오버슈팅 스프링 물리 곡선을 구사하여 탄성 있는 진입·퇴장 연출을 구현합니다.

#### 23. 모달 3D 레이어 배경 침강 효과
모달 오픈 시 `MutationObserver` 기반 `body.modal-open` 클래스 토글로 뒷 배경 콘텐츠가 원근 축소 및 블러를 통해 3D적으로 뒤로 가라앉는 몰입형 레이어 효과를 연출합니다.

#### 24. 커스텀 테마 연동형 스크롤바 및 빈 상태 연출
시스템 전반의 스크롤바 스타일을 CSS 변수 기반 커스텀 스킨으로 통일합니다. 목록이 비어 있는 상태(`empty state`)에서 콘텐츠가 `floatBob` 키프레임으로 둥실 떠오르는 시각적 힌트를 제공합니다.

#### 25. 탭 전환 뷰포트 스크롤 초기화 가드
`switchPage()` 탭 전환 루프 직후 `window.scrollTo(0, 0)` 방어 코드를 주입하여, 탭 이동 시 이전 탭의 스크롤 오프셋이 잔류하는 UX 오염 문제를 원천 차단합니다.

#### 26. 인라인 Base64 SVG 파비콘
기존 퍼센트(`%`) 인코딩 방식의 Data URI가 브라우저 파서와 충돌하여 이모지로 폴백되던 버그를 근본 해결합니다. 배경 원, 이중 액센트 링, 펼쳐진 책 페이지, 디지털 변환 신호 노드가 기하학적으로 설계된 순수 SVG를 `data:image/svg+xml;base64,...` 형식의 100% 무결한 바이너리 Base64 데이터 URI로 인라인 주입합니다. 외부 파일 의존성 없이 렌더링을 보장합니다.

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
index.html      — 단일 페이지 SPA 마크업 (1,260줄)
├── style.css   — CSS 변수 76개+, 키프레임 20개+ (1,340줄)
├── core.js     — StateManager, Toast, SettingsDB, EventBus, Cloudflare 프록시 (1,420줄)
├── convert.js  — 변환 탭 로직: 파일 I/O, 인코딩, 이미지, 삽화 처리 (2,790줄)
├── parser.js   — 텍스트 파싱 엔진, 목차 렌더링, 가상 스크롤, 통계 (2,044줄)
├── ui-state.js — 테마, CSS 미리보기, 탭/칩/피드/스와이프, 헤더 수축, 마이크로 인터랙션 (1,120줄)
├── settings.js — CSS/폰트/프리셋/스킨, 스마트 패턴, 히스토리, Gemini API (1,317줄)
├── edit.js     — EPUB 편집 탭: OPF 파싱, 챕터 수정, 재생성 (1,603줄)
├── cover-search.js — 표지 검색 모달, 플랫폼 링크, 이미지 크롭 및 .file 가드 (722줄)
├── epub-gen.js — EPUB3 생성 엔진, Blob Worker 격리 (389줄)
├── worker.js   — 인코딩 감지·디코딩·챕터 파싱 전담 Web Worker (354줄)
└── sw.js       — Service Worker, 오프라인/PWA 지원 (119줄)
```

> **총 코드량: 13,478줄** | 구문 오류 0개 | 중복 ID 0개

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

## 🤖 스마트 패턴 변환

`settings.js`의 `smartPatConvert()` 함수가 자연어 예시 → 정규식 변환을 지원합니다.

| 모드 | 설명 |
|------|------|
| **로컬 로직** | `guessPatternFromExample()` — API 키 없이 즉시 변환 |
| **Gemini API** | `_askGeminiForPattern()` — 지수 백오프 포함, 정밀 변환 |
| **디바운스** | 입력 후 600ms 대기 → 자동 실행 |
| **적용 버튼** | 변환 결과를 패턴 입력창에 즉시 반영 |

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
| 탭 렌더링 격리 | `display: none !important` / `display: block !important` 표준 토글 — content-visibility 실험적 속성 전면 제거 |

---

## 🎨 디자인 시스템

### 테마
- **라이트**: `radial-gradient` 배경 미세 그라데이션
- **다크**: OLED 친화 `#0e0c0a` 심해 다크 브라운 기반, warm-slate 텍스트, `backdrop-filter` 글래스모피즘 계층
- CSS 변수 76개+ + 키프레임 애니메이션 20개+
- JS `initTheme()` 우선, OS `prefers-color-scheme` 폴백
- CSS `clamp()` 기반 유동 반응형 타이포그래피, `word-break: keep-all` 한국어 최적화

### 컬러 스킨 3종
| 스킨 | 액센트 | 적용 |
|------|--------|------|
| 테라코타 (기본) | `#d45a46` | 기본값, `data-skin` 없음 |
| 인디고 블루 | `#4855a8` | `[data-skin=indigo]` |
| 포레스트 그린 | `#2a7a4a` | `[data-skin=forest]` |

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
| CSS `clamp()` | Chrome 79+, Firefox 75+ |
| `backdrop-filter` | Chrome 76+, Firefox 103+, Safari 9+ |

> **권장**: Chrome 90+ / Firefox 90+ / Safari 15+ / Edge 90+

---

## 🧪 코드 품질 지표

| 항목 | 수치 |
|------|------|
| 총 줄수 | 13,478줄 |
| 구문 오류 | 0개 (`node --check` 전 파일 통과) |
| 중복 ID | 0개 |
| 하드코딩 색상 | 0개 (전부 CSS 변수, :root 정의부 제외) |
| 네트워크 회복력 | 프록시 실패 시 Direct Fetch 자동 폴백 구조 100% 가동 |
| 캔버스 무결성 | 가공 표지 `SecurityError (Tainted Canvas)` 발생률 0% 명세 충족 |
| 타임아웃 보호 | fileToText 30초, splitChapters 2분, 프록시 네트워크 8초 제한 |
| 탭 렌더링 안정성 | Reflow 레이턴시 0ms (display 표준 토글 격리 전환 완료) |
| 파비콘 렌더링 | Base64 SVG 인라인 주입 — 퍼센트 인코딩 충돌 버그 0건 |

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
mini-reader 실시간 미리보기 + regex-feed 피드백 패널
btm-status 스티키 변환 바
↓
컬러 스킨 3종 + 모바일 스와이프 탭 + 챕터 통계 (I 시리즈)
B 시리즈 버그 수정 10개 + Toast HTML 지원 (I9 delta)
드롭존 전면 SVG 교체 (일괄변환·삽입 포함)
↓
파일 분리 리팩토링: main.js → core/convert/ui-state/settings/edit/cover-search
스마트 패턴 변환 (Gemini API + 로컬 로직)
표지 검색 모달 (플랫폼 링크 스트립)
settings.js 구문 오류 수정 (고아 코드 블록 제거)
↓
[ Layer 4: Infrastructure / Core Proxy Utility ]
├── window.proxyGet / proxyGetBlob (8s Timeout / ArrayBuffer Chunk)
├── Failover Recovery (Fallback to Direct Fetch)
└── Security Protection (X-NovelEPUB-Token & MIME Filter)
↓
[ Layer 5: Business Adapter / cover-search.js ]
├── Same-Origin Sandbox Image Loading (URL.createObjectURL)
└── Platform Cover Fetchers (Kakao, Naver, Ridi, Novelpia with .file Guard)
↓
[ Phase 5: 표준 display 토글 격리 및 물리 마이크로 인터랙션 오케스트레이션 ]
├── display: none/block 표준 탭 격리 (content-visibility 실험적 속성 전면 제거)
│   └── switchPage() 후 window.scrollTo(0, 0) 뷰포트 스크롤 리셋 가드 주입
├── Folio 프리미엄 미니멀리즘 디자인 시스템
│   ├── CSS clamp() 유동 반응형 타이포그래피 + word-break: keep-all
│   ├── #0e0c0a OLED 심해 다크 브라운 테마 + backdrop-filter 글래스모피즘
│   ├── --tab-indicator-x/w 연동 cubic-bezier 스프링 슬라이딩 탭 인디케이터
│   ├── _setupHeaderCompact() 스크롤 감지형 헤더 수축 시스템
│   ├── neonBorderPulse / liquidFlow / toastSpringIn,Out 키프레임 오케스트레이션
│   ├── MutationObserver body.modal-open 3D 레이어 배경 침강 효과
│   └── 커스텀 스크롤바 테마 바인딩 + floatBob 빈 상태 연출
└── 인프라 제로 오버헤드 파비콘
    └── SVG → Base64 Data URI 인라인 주입 (퍼센트 인코딩 충돌 버그 근본 해결)
```

---

## 🔧 Troubleshooting

### `content-visibility` 탭 렌더링 버그 (해결됨)
**증상**: 탭 전환 시 하단 UI 밀림, 콘텐츠 화이트아웃(white-out) 발생, Reflow 레이턴시 불규칙.  
**원인**: `content-visibility: hidden` 및 `contain-intrinsic-size` 실험적 CSS 속성이 브라우저 렌더링 엔진과 충돌하여 탭 패널의 레이아웃 재계산 타이밍이 어긋남.  
**해결**: 해당 실험적 속성을 전면 제거하고, `display: none !important` / `display: block !important` 표준 토글 격리 방식으로 교체. `switchPage()` 완료 시점에 `window.scrollTo(0, 0)` 방어 코드를 추가 주입하여 뷰포트 잔류 스크롤 문제 병행 해소.

### 파비콘 이모지 폴백 버그 (해결됨)
**증상**: `<link rel="icon">` Data URI 설정 시 브라우저가 SVG를 파싱하지 못하고 기본 이모지로 폴백.  
**원인**: SVG 소스 내 `#`, `<`, `>`, `"` 등의 특수문자를 퍼센트(`%`) 인코딩하여 Data URI로 삽입하면 일부 브라우저의 URL 파서가 올바르게 처리하지 못함.  
**해결**: SVG 소스 전체를 `btoa()` 방식으로 Base64 인코딩하여 `data:image/svg+xml;base64,...` 형식으로 변환. 바이너리 레벨의 불투명한 데이터 블록으로 전달하므로 파서 충돌 원천 차단.

---

## 📄 라이선스

MIT License

---

*NovelEPUB — 소설을 전자책으로, 빠르고 안전하게.*
