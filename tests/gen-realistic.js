/**
 * 실전형 웹소설 TXT 생성기 (결정적 — 같은 시드면 같은 결과)
 *
 * 실제 연재 TXT에서 자주 보이는 형식 혼재·잡음을 재현하고, 정답 목차(제목 줄 번호·화수)를 함께 반환한다.
 * 파일명 규칙은 사용자 예시를 그대로 사용: "<소설명> <시작>-<끝> <완결|연재중|@작가>"
 *
 * 재현하는 잡음
 *   - 구간마다 다른 제목 형식 (N화 / 제N화 제목 / <N화> / 【N화】 / N. 제목 / 소설명 N화 / [N화] / 숫자만 / EP.N)
 *   - 숫자로 시작하는 본문 줄('3년이 지났다.'), 본문 속 번호 목록('1. 검'), 대사 속 카운트다운('3', '2', '1')
 *   - 본문 대사 속 단독 'N화' 언급, 장면 구분자(***), 제목 뒤 구분선(=====)
 *   - 두 줄 제목(번호 다음 줄에 부제), 30자 넘는 긴 제목, 매 화 위 반복되는 작품명 머리줄
 *   - 빈 줄 없이 압축된 TXT, 같은 화 분할('120화 (1)/(2)'), 삭제된 화(번호 누락)
 *   - 프롤로그·에필로그·외전·작가의 말·공지
 */
'use strict';

function rng(seed){ let a=seed>>>0; return ()=>{ a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }

const SENT=[
  '그는 천천히 고개를 들었다.','바람이 불어와 머리카락을 흩트렸다.','그녀가 조용히 물었다.','멀리서 종소리가 울려 퍼졌다.',
  '하늘은 잿빛으로 물들어 있었다.','그 순간 모든 것이 멈춘 듯했다.','그는 짧게 대답하고 걸음을 옮겼다.','도시의 불빛이 하나둘 꺼지고 있었다.',
  '심장이 미친 듯이 뛰었다.','손끝에서 푸른 마나가 피어올랐다.','통장 잔고를 확인한 순간 숨이 멎었다.','문이 열리고 낯선 남자가 들어왔다.',
  '창밖으로 눈이 내리기 시작했다.','그는 쓴웃음을 지으며 고개를 저었다.','시스템 창이 눈앞에 떠올랐다.','주변이 순식간에 조용해졌다.',
];
const DIALOG=['"정말 괜찮은 거야?"','"이제 시작이야."','"말도 안 돼."','"그게 무슨 소리야?"','"됐어, 가자."','"…알겠습니다."'];
const DIGIT=['3년이 지났다.','100미터 앞에서 그가 멈춰 섰다.','2층 창문이 덜컥 열렸다.','10분 뒤, 전화가 울렸다.','5억이 입금되었습니다.','1층 로비는 텅 비어 있었다.'];
const TITLES=['시작','각성','첫 번째 의뢰','드래곤의 둥지','계약','대가','귀환','재회','폭풍 전야','결전','새로운 길','비밀','함정','반격','휴식','축제','배신','진실','여행','선택'];

function body(r, opts={}){
  const n=opts.lines||(18+Math.floor(r()*16)); const out=[];
  for(let i=0;i<n;i++){
    const x=r();
    if(x<0.55) out.push(SENT[Math.floor(r()*SENT.length)]);
    else if(x<0.80) out.push(DIALOG[Math.floor(r()*DIALOG.length)]);
    else if(x<0.88) out.push(DIGIT[Math.floor(r()*DIGIT.length)]);
    else if(x<0.91 && opts.list){ out.push('준비물은 다음과 같았다.','','1. 마나 포션','2. 강철 검','3. 지도',''); }
    else if(x<0.93 && opts.countdown){ out.push('"셋."','','3','','2','','1',''); }
    else if(x<0.95 && opts.mention){ out.push('그는 공책을 펼쳤다. 첫 장에는 이렇게 적혀 있었다.','','1화',''); }
    else if(x<0.97) out.push('***');
    else out.push('쾅!');
    if(!opts.compact && r()<0.55) out.push('');
  }
  return out;
}

/** spec: {name, range:[s,e], status, seed, segments:[{from,to,fmt}], ...noise flags} */
function generate(spec){
  const r=rng(spec.seed); const L=[]; const truth=[]; const sep=spec.compact?[]:[''];
  const pushHead=(lines,num,kind,title)=>{ truth.push({line:L.length+1,num,kind,title:lines[0]}); L.push(...lines); };
  const fmtOf=n=>spec.segments.find(s=>n>=s.from&&n<=s.to).fmt;
  if(spec.prologue){ pushHead(['프롤로그'],null,'kw'); L.push(...sep,...body(r,spec),...sep); }
  for(let n=spec.range[0]; n<=spec.range[1]; n++){
    if(spec.missing&&spec.missing.includes(n)) continue;
    if(spec.notice&&spec.notice.includes(n)){ pushHead(['공지) 연재 주기 안내'],null,'kw'); L.push(...sep,'앞으로는 주 5회 연재합니다.','감사합니다.',...sep); }
    const t=TITLES[Math.floor(r()*TITLES.length)]+(spec.longTitles&&r()<0.3?' — 끝나지 않는 밤에 홀로 남은 그가 마침내 깨달은 것':'');
    const parts=(spec.splitParts&&spec.splitParts.includes(n))?2:1;
    for(let p=1;p<=parts;p++){
      if(spec.header){ L.push(spec.header,''); }
      const sfx=parts>1?` (${p})`:'';
      const f=fmtOf(n); let head;
      switch(f){
        case 'N화': head=[`${n}화${sfx}`]; break;
        case 'N화+부제': head=[`${n}화${sfx}`, t]; break;
        case '제N화': head=[`제${n}화 ${t}${sfx}`]; break;
        case '제N화.': head=[`제${n}화. ${t}${sfx}`]; break;
        case '<N화>': head=[`<${n}화> ${t}${sfx}`]; break;
        case '【N화】': head=[`【${n}화】 ${t}${sfx}`]; break;
        case 'N.': head=[`${n}. ${t}${sfx}`]; break;
        case '소설명N화': head=[`${spec.title} ${n}화${sfx}`]; break;
        case '[N화]': head=[`[${n}화] ${t}${sfx}`]; break;
        case '숫자만': head=[`${n}`]; break;
        case 'EP.N': head=[`EP.${n} ${t}${sfx}`]; break;
        default: throw new Error('fmt '+f);
      }
      pushHead(head,n,'ch');
      if(spec.underline) L.push('==========');
      L.push(...sep,...body(r,spec),...sep);
    }
    if(spec.volumes&&spec.volumes.includes(n)){ pushHead([`${spec.volumes.indexOf(n)+2}권`],null,'vol'); L.push(...sep); }
  }
  if(spec.epilogue){ pushHead(['에필로그'],null,'kw'); L.push(...sep,...body(r,spec),...sep); }
  for(let s=1;s<=(spec.side||0);s++){ pushHead([`외전 ${s}화`],s,'side'); L.push(...sep,...body(r,spec),...sep); }
  if(spec.afterword){ pushHead(['작가의 말'],null,'kw'); L.push(...sep,'끝까지 읽어주셔서 감사합니다.',...sep); }
  return { fileName: spec.name+'.txt', text: L.join('\n')+'\n', truth };
}

const SPECS=[
  { name:'재활만 했는데 드래곤의 힘을 얻었다 1-201 완결', title:'재활만 했는데 드래곤의 힘을 얻었다', seed:11, range:[1,201],
    segments:[{from:1,to:80,fmt:'N화+부제'},{from:81,to:150,fmt:'제N화'},{from:151,to:201,fmt:'<N화>'}],
    prologue:true, epilogue:true, side:3, afterword:true, splitParts:[120], mention:true },
  { name:'퇴사 후 미국 여행 갔다가 벼락 부자됨 1-325 완결', title:'퇴사 후 미국 여행 갔다가 벼락 부자됨', seed:22, range:[1,325],
    segments:[{from:1,to:100,fmt:'【N화】'},{from:101,to:325,fmt:'N.'}],
    header:'퇴사 후 미국 여행 갔다가 벼락 부자됨', missing:[47,210], list:true, epilogue:true },
  { name:'청년 가장이 재물을 부르는 신의 손이 됨 1-200 연재중', title:'청년 가장이 재물을 부르는 신의 손이 됨', seed:33, range:[1,200],
    segments:[{from:1,to:200,fmt:'제N화.'}], compact:true, longTitles:true, notice:[50,150] },
  { name:'최강_신이라 불리는 사나이 1-868 연재중', title:'최강 신이라 불리는 사나이', seed:44, range:[1,868],
    segments:[{from:1,to:399,fmt:'소설명N화'},{from:400,to:600,fmt:'[N화]'},{from:601,to:868,fmt:'N화'}],
    underline:true, mention:true, volumes:[300,600], splitParts:[500,700] },
  { name:'작은 시골 마을에는 즐길 것이 없다 0-853 @오븐치킨', title:'작은 시골 마을에는 즐길 것이 없다', seed:55, range:[0,853],
    segments:[{from:0,to:300,fmt:'숫자만'},{from:301,to:853,fmt:'EP.N'}], countdown:true, list:true },
];

module.exports={ generate, SPECS };
if(require.main===module){
  const fs=require('fs'),path=require('path'); const out=path.join(__dirname,'out','realistic'); fs.mkdirSync(out,{recursive:true});
  for(const s of SPECS){ const g=generate(s); fs.writeFileSync(path.join(out,g.fileName),g.text); console.log(g.fileName, g.text.split('\n').length+'줄', '정답 제목', g.truth.length); }
}
