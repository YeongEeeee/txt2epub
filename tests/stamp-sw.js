#!/usr/bin/env node
/**
 * sw.js CACHE_VERSION 자동 기록 — 앱 자산 내용 해시
 *
 *   npm run stamp          → sw.js의 CACHE_VERSION을 현재 자산 해시로 갱신
 *   (회귀 테스트가 sw.js 값과 계산값이 같은지 검사 — 다르면 CI 실패)
 *
 * 해시 대상: sw.js CORE_ASSETS의 로컬 파일 ('./'는 index.html과 같아 제외)
 * 줄바꿈은 LF로 정규화 — Windows(CRLF) 체크아웃과 CI(LF)에서 같은 값
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SW = path.join(ROOT, 'sw.js');

function coreAssets(swSrc){
  const block = (swSrc.match(/const CORE_ASSETS = \[([\s\S]*?)\];/) || [])[1] || '';
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1])
    .filter(u => !/^https?:/.test(u) && u !== './')
    .map(u => u.replace(/^\.\//, ''));
}

function assetHash(swSrc = fs.readFileSync(SW, 'utf8')){
  const h = crypto.createHash('sha256');
  for(const rel of coreAssets(swSrc)){
    const buf = fs.readFileSync(path.join(ROOT, rel));
    // 텍스트 자산만 CRLF → LF (lib/jszip.min.js 포함 전부 텍스트)
    h.update(rel + '\0');
    h.update(buf.toString('utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return 'h-' + h.digest('hex').slice(0, 16);
}

function currentVersion(swSrc = fs.readFileSync(SW, 'utf8')){
  return (swSrc.match(/const CACHE_VERSION = '([^']+)';/) || [])[1] || '';
}

module.exports = { assetHash, currentVersion, coreAssets };

if(require.main === module){
  const src = fs.readFileSync(SW, 'utf8');
  const next = assetHash(src);
  const prev = currentVersion(src);
  if(prev === next){ console.log('sw.js CACHE_VERSION 최신: ' + next); process.exit(0); }
  fs.writeFileSync(SW, src.replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${next}';`));
  console.log(`sw.js CACHE_VERSION 갱신: ${prev} → ${next}`);
}
