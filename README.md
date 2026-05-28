# NovelEPUB — TXT → EPUB3 변환기

> 소설 TXT 파일을 EPUB3 전자책으로 변환하는 **순수 프론트엔드** 웹 애플리케이션.  
> 서버 업로드 없이 브라우저 안에서 모든 처리가 완료됩니다.

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

## 🏗 아키텍처

```
index.html          — 단일 페이지 HTML (1,049줄)
├── style.css       — CSS 변수 76개, 키프레임 11개 (595줄)
├── parser.js       — 텍스트 파싱 엔진 (1,793줄)
├── epub-gen.js     — EPUB3 생성 엔진, Blob Worker 격리 (410줄)
├── main.js         — UI 제어, 이벤트, 상태 관리 (7,244줄)
├── worker.js       — 인코딩 감지·디코딩·챕터 파싱 전담 Web Worker (355줄)
└── sw.js           — Service Worker, 오프라인/PWA 지원 (51줄)
```

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

**지원 패턴 그룹** (총 48종)

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
16.jpg      → 16화 앞에 삽입
16_1.jpg    → 16화 1번째 삽화 (file_idx 정렬로 순서 보장)
cover.jpg   → 표지로 자동 인식
prologue.jpg → 프롤로그 챕터에 자동 매핑
epilogue.jpg → 에필로그 챕터에 자동 매핑
side.jpg    → 외전 챕터에 자동 매핑
```

### 이미지 처리 파이프라인
1. `resizeCoverIfNeeded()` — 표지 1200px 이하로 리사이징
2. `processImagesParallel()` — `IMG_CONCURRENCY = 4` 배치 병렬 변환
3. PNG/GIF/WebP → JPEG 자동 변환 (옵션)
4. Transferable ArrayBuffer로 Blob Worker에 zero-copy 전달

---

## 🔧 파일명 메타 인식 (B 시리즈 개선)

TXT 파일 업로드 시 제목·작가명을 자동 추출합니다.

### 지원 구분자 (8종)
```
[작가] 제목          → 작가: 작가, 제목: 제목
제목@작가            → 제목: 제목, 작가: 작가
제목 - 작가          → 하이픈 with 공백
제목(작가)           → 괄호
제목[작가]           → 대괄호
제목 by 작가         → 영문 소설
작가의 제목          → '의' 키워드
제목_작가            → 언더스코어 (작가명이 인명 형식일 때만)
```

### 추가 인식 전략
- **본문 첫 10줄 스캔**: `제목: `, `작가: `, `저자: ` 레이블 자동 파싱
- **다중 파일 LCP**: 여러 파일의 최장 공통 접두사를 제목으로 추론
- **제목 후처리**: 날짜 접두사, `완결`, `N권`, `N부`, 범위 표시 자동 제거
- **신뢰도 배지**: 높음/보통/낮음 표시 + 낮음이면 입력창 테두리 강조

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
| 메모리 관리 | StateManager reset() 시 null 참조 해제 → GC 유도 |
| 정규식 | 루프 외부 사전 컴파일 (`RX_AUTO_PAGE`, `RX_CHAPTER_N` 등) |

---

## 🎨 UI/UX

### 테마
- 라이트: `radial-gradient` 배경 미세 그라데이션
- 다크: `#121212` 기반, warm-slate 텍스트 계열
- CSS 변수 76개 + 11개 키프레임 애니메이션
- JS `initTheme()` 우선, OS `prefers-color-scheme` 폴백

### 인터랙션
- 버튼 엠보싱/디보싱 (`translateY(-1px)` hover, `scale(.98)` active)
- 드롭존 dragover 시 점선→실선 + `scale(1.02)` + 브랜드 컬러
- 업로드 완료 체크 애니메이션 (`checkPop` keyframe)
- 테마 스위처 360° 회전 (`themeFlip` keyframe)
- 스테퍼 글로우 (`stepBlink` keyframe — 현재 단계)
- 복사 버튼 "복사됨!" 툴팁 (`tooltipFade` 1초)

### 빠른 선택 칩 (A 시리즈 개선)
- **3그룹 접이식**: 화/장번호·챕터/파트·특수형식
- **실시간 카운터**: 클릭 즉시 현재 파일에서 매칭 수 배지 표시
- **hover 팝오버**: 400ms 딜레이 후 매칭 예시 5줄 미리보기
- **충돌 감지**: 2개 이상 선택 시 교집합 50% 초과 → 경고 표시
- **사용자 정의 칩**: 직접 입력 패턴 저장·재사용 (IndexedDB)

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
├── index.html       # 메인 HTML (SPA)
├── main.js          # UI 제어, StateManager, 이벤트 위임
├── parser.js        # 텍스트 파싱, 목차 추출, 가상 스크롤
├── epub-gen.js      # EPUB3 생성, Blob Worker, 이미지 병렬 처리
├── worker.js        # Web Worker: 인코딩 감지·디코딩·챕터 파싱
├── sw.js            # Service Worker: 오프라인 캐시, PWA
├── style.css        # 테마·컴포넌트·애니메이션
└── README.md
```

### 외부 의존성 (CDN — 오프라인 캐시됨)
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
- **XSS 방지**: Toast, confirm, prompt 모두 `innerHTML` → DOM API (`textContent`)
- **입력 이스케이프**: `escHtml()`, `escAttr()`, `sanitizeLine()` 적용
- **Content Security Policy** 호환: 인라인 스크립트 없음

---

## 📋 브라우저 지원

| 기능 | 최소 버전 |
|------|----------|
| Web Worker | Chrome 4+, Firefox 3.5+ |
| Service Worker | Chrome 40+, Firefox 44+ |
| IndexedDB | Chrome 24+, Firefox 16+ |
| Transferable ArrayBuffer | Chrome 17+, Firefox 18+ |
| `navigator.hardwareConcurrency` | Chrome 37+, Firefox 48+ |

> 권장: Chrome 90+ / Firefox 90+ / Safari 15+ / Edge 90+

---

## 📝 개발 세션 요약 (SUMMARY)

### 아키텍처 진화

**초기 → 현재**
```
단순 FileReader + 동기 ZIP 생성
   ↓
Web Worker 격리 + Transferable ArrayBuffer
   ↓  
StateManager(Proxy) + EventBus + 탭별 상태 격리
   ↓
Service Worker 캐시 + IndexedDB 영속화 + 병렬 처리
```

### 주요 변경 이력

#### 안정성
- `SettingsDB.open()` 경합 조건 → `_dbPromise` 싱글톤 패턴
- `fileToText` 30초 타임아웃 + 이중 폴백 (ArrayBuffer → readAsText → 빈 문자열)
- `splitChaptersAsync` 2분 타임아웃 + 동기 폴백
- Two-Pass 압축: DEFLATE 실패 시 STORE 단 1회 재시도 → 최종 실패 throw
- StateManager `reset()` 시 null 참조 해제 → GC 유도

#### 성능
- EPUB 생성 로직 → Blob Worker 완전 격리 (yieldToMain 제거)
- 이미지 처리 → `IMG_CONCURRENCY=4` Promise.all 병렬화
- 일괄 변환 → `hardwareConcurrency` 기반 병렬 슬롯 (최대 4개)
- 5MB 이상 파일 → `worker.js` Transferable 위임
- JSZip `streamFiles:true` — 대용량 파일 메모리 최소화

#### 보안
- `Toast._show`, `confirm`, `prompt` innerHTML → DOM API 완전 교체
- `buildCombinedPat` 정규식 `^/$/ |` 우선순위 안전 그룹화
- PAT_PRESETS 백트래킹 최적화: `.*` → `[^\r\n]*`, lookahead 제거

#### 기능
- 빠른 선택 칩: 3그룹 접이식 + 카운터 + 팝오버 + 충돌감지 + 사용자 저장
- 파일명 인식: 8종 구분자 + 본문 스캔 + LCP + 정규화 + 신뢰도 배지
- 챕터 통계: 총 글자수, 평균, 짧은/긴 챕터 경고
- 리더 시뮬: 미리보기 화이트/세피아/다크 테마 전환
- 설정 프리셋: 전체 설정 저장·불러오기 (IndexedDB)
- 오류 리포트: 변환 완료 후 경고 항목 요약 카드
- 키보드 단축키: Ctrl+P, Ctrl+Shift+P, Ctrl+Z 추가

---

## 📄 라이선스

MIT License

---

*NovelEPUB — 소설을 전자책으로, 빠르고 안전하게.*
