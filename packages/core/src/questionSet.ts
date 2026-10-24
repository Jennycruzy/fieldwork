import {checkDraft} from "./checks.js";
export interface QuestionCase {id:string;question:string;expected:string;answer_shape:string}
export interface RecordedAnswer {id:string;question:string;status:string;rounds:number;answer:{answer?:{headline:string;points:string[];how_sure:string;caveats:string[]};headers?:string[];rows?:(string|null)[][];sql?:string;view?:string;plan?:{years?:{from?:number;to?:number};analysis?:{basis:string;denominator:string;relationship:boolean}};sources?:{title:string;url:string;filter:string;records:number;sourceCount:number}[];checks?:{id:string;ok:boolean;detail:string}[];message?:string}}
export interface Reference {tracts:[string,string][];counts:{title:string;rows:[string,string][]}[];health:{headers:string[];rows:(string|null)[][]}[]}
export interface Grade {passed:boolean;reasons:string[];checks:{name:string;ok:boolean}[]}
export function gradeQuestion(q:QuestionCase,run:RecordedAnswer,reference?:Reference):Grade {
 const checks:{name:string;ok:boolean}[]=[];const reasons:string[]=[];
 const check=(name:string,ok:boolean)=>{checks.push({name,ok});if(!ok)reasons.push(name);};
 check("Exact frozen question",run.question===q.question);
 const a=run.answer??{};const draft=a.answer;const rows=a.rows??[],h=a.headers??[],sql=a.sql??"";const sources=a.sources??[];
 const col=(re:RegExp)=>h.findIndex((v)=>re.test(v));const vals=(j:number)=>rows.map(r=>r[j]==null?NaN:Number(r[j]));
 const has=(name:string,re:RegExp)=>{const j=col(re);check(name,j>=0);return j;};
 const sorted=(j:number,asc=false)=>{const ns=vals(j).filter(Number.isFinite);return j>=0&&ns.length>0&&ns.every((n,i)=>!i||(asc?n>=ns[i-1]!:n<=ns[i-1]!));};
 const countCol=(re:RegExp)=>h.findIndex(v=>re.test(v)&&!/per_|rate|percent|pct/i.test(v));
 const sourceText=sources.map(s=>`${s.title} ${s.url}`).join(" ");
 if(q.expected==="refused-correctly") {
  check("Correct refusal status",run.status==="refused");check("No invented answer or result rows",!draft&&!rows.length);
  const expected:Record<string,RegExp>={Q21:/Montgomery|Birmingham|scope|place/i,Q22:/predict|forecast|price|future|financial/i,Q23:/person|individual|private|medical|named|aggregate/i,Q24:/private|bank|financial|account/i,Q25:/medical|health|diagnos|prescri|care|personal/i};
  check("Refusal explains this scope limit",(expected[q.id]??/scope/i).test(a.message??""));return {passed:reasons.length===0,reasons,checks};
 }
 check("Answered successfully",run.status==="answered");check("Nonempty reproducible result",rows.length>0&&!!sql&&!!a.view);check("Sources cited",sources.length>0);
 if(!rows.length||!draft){reasons.push(a.message??"No supported answer was produced");return {passed:false,reasons,checks};}
 const facts=[...(a.checks??[]).map(c=>c.detail),...sources.map(s=>s.filter),`Evaluator rounds: ${run.rounds}`];
 check("Full draft passes numeric and rank checks",checkDraft([draft.headline,...draft.points,draft.how_sure,...draft.caveats],h,rows,facts).ok);
 check("No failed accuracy checks",!(a.checks??[]).some(c=>!c.ok&&!/bridge_match|sample_size/.test(c.id)));
 const text=[draft.headline,...draft.points,draft.how_sure,...draft.caveats].join(" ");
 if(!["Q07","Q09","Q12"].includes(q.id)) check("Tract identifiers included",col(/geoid|tractfips|tract.*id/i)>=0);
 if(["Q01","Q04","Q05","Q19","Q20"].includes(q.id)) {check("CDC health source",/cdc.gov|PLACES/i.test(sourceText));check("Health estimates labeled",/estimat|model.based/i.test(text));}
 const sourceRequired:Record<string,RegExp>={Q01:/code.?violat/i,Q02:/code.?violat/i,Q03:/code.?violat/i,Q04:/code.?violat/i,Q05:/code.?violat/i,Q06:/code.?violat/i,Q07:/code.?violat/i,Q08:/311|service.?request/i,Q09:/311|service.?request/i,Q10:/311|service.?request/i,Q11:/911/i,Q12:/911/i,Q13:/food|inspection/i,Q14:/food|inspection/i,Q15:/pharma/i,Q16:/pharma/i,Q17:/shelter/i,Q18:/permit/i,Q20:/EPA|echodata/i};
 if(sourceRequired[q.id])check("Requested source discovered",sourceRequired[q.id]!.test(sourceText));
 const fullYear=["Q01","Q02","Q03","Q05","Q08","Q09","Q10","Q11","Q12","Q18"].includes(q.id);
 if(fullYear)check("Requested 2025 source period",sources.some(s=>/2025/.test(s.filter))&&a.plan?.years?.from===2025);
 if(q.id==="Q01") {check("Asthma ranking descending",sorted(has("Asthma column",/asthma|casthma/i)));has("Violation counts",/violat|code_count/i);}
 if(["Q02","Q08","Q11","Q18"].includes(q.id))check("Requested counts descending",sorted(has("Count column",/violat|request|call|permit|count/i)));
 if(["Q03","Q16"].includes(q.id)) {const j=has("Population-adjusted rate",/per_?(?:1_?000|10_?000)|rate/i);check("Rate ranking order",sorted(j,q.id==="Q16"));has("Resident denominator",/population|residents|denominator/i);has("Raw count",/count|violat|pharmac/i);check("Resident population used",/totalpopulation/i.test(sql));}
 if(["Q04","Q05","Q10","Q20"].includes(q.id)) {check("Rates chosen on purpose",a.plan?.analysis?.basis==="rates"&&a.plan.analysis.relationship);check("Resident denominator",a.plan?.analysis?.denominator==="residents"&&/totalpopulation/i.test(sql));check("Raw source count",countCol(/count|violat|request|facilit/i)>=0);has("Rate per resident",/per_?1_?000.*resident|per_?1000.*resident/i);const j=has("Correlation statistic",/corr/i);const n=has("Full paired sample size",/paired_tracts|paired_count/i);check("Paired size agrees with full result",n>=0&&vals(n).every(v=>v===rows.length));check("Valid correlation range",j>=0&&vals(j).every(v=>Number.isFinite(v)&&Math.abs(v)<=1));}
 if(q.id==="Q06") {const a=has("2024 count",/2024/),b=has("2025 count",/2025/),d=has("Absolute change",/change|increase|difference/i);check("Correct differences",a>=0&&b>=0&&d>=0&&rows.every(r=>Math.abs(Number(r[b])-Number(r[a])-Number(r[d]))<1e-6));check("Changes descending",sorted(d));}
 if(["Q07","Q12"].includes(q.id)) {const j=has("Month column",/month|period/i);has("Monthly count",/count|violat|calls/i);const months=rows.map(r=>{const s=r[j]??"";return /^\d{4}-/.test(s)?s.slice(0,7):s.match(/^\d{1,2}/)?.[0]?.padStart(2,"0")??s;});check("Months chronological",j>=0&&months.every((v,i)=>!i||v>=months[i-1]!));if(q.id==="Q07")check("Current period marked incomplete",/so far|partial|in progress/i.test(text));}
 if(q.id==="Q09") {has("Request type",/type|category|kind|grp/i);has("Type counts",/count|requests|^n$/i);has("Shares with denominator",/share|percent|pct/i);check("Source dates stated",/2025/.test(text));}
 if(q.id==="Q13") {const j=has("Average inspection score",/avg|average|mean/i);has("Establishment sample count",/count|establishments|sample|^n$/i);check("Low scores first",sorted(j,true));check("Latest inspection selection",/row_number|latest|max\s*\([^)]*date/i.test(sql));check("Inspection score not geocoder confidence",/Score_1/i.test(sql)||/inspection_score/i.test(sql));}
 if(q.id==="Q14") {has("Establishment count",/count|establishments|below/i);check("Threshold is 85",/85/.test(sql));check("Latest inspection selection",/row_number|latest|max\s*\([^)]*date/i.test(sql));check("Inspection score not geocoder confidence",/Score_1|inspection_score/i.test(sql));}
 if(q.id==="Q15") {const j=has("Pharmacy count",/pharma|count|^n$/i);check("Only verified zero counts",j>=0&&vals(j).every(v=>v===0));check("Listed-source coverage limit stated",/list|coverage|source/i.test(text));}
 if(q.id==="Q19") check("Diabetes rates descending",sorted(has("Diabetes column",/diabet/i)));
 if(q.id==="Q20")check("Registry is not exposure",/not.*(?:emission|exposure)|(?:emission|exposure).*not/i.test(text));
 if(reference) {
  const byName=new Map(reference.tracts.map(([id,name])=>[name,id]));const geo=col(/^(geoid|tractfips)$/i);const id=(row:(string|null)[])=>geo>=0?row[geo]:byName.get(row[0]??"");
  const kinds:[RegExp,RegExp][]=[[/code.?violat/i,/violat|code_count/i],[/311|service.?request/i,/311|request/i],[/pharma/i,/pharma/i],[/shelter/i,/shelter/i],[/permit/i,/permit/i],[/EPA|ECHO/i,/facilit|epa/i]];
  if(!["Q06","Q07","Q09","Q12","Q13","Q14"].includes(q.id)) for(const [sourcePattern,headerPattern] of kinds) {
    const source=reference.counts.find(s=>sourcePattern.test(s.title));const j=countCol(headerPattern);if(!source||j<0)continue;
    const counts=new Map(source.rows.map(([geoid,n])=>[geoid,Number(n)]));check(`Counts match independent ${source.title} tract totals`,rows.every(r=>id(r)!=null&&Number(r[j])===(counts.get(id(r)!)??0)));
  }
  for(const health of reference.health) for(const [sourceField,resultPattern] of [["casthma_crudeprev",/asthma/i],["bphigh_crudeprev",/blood|bp|hypertens/i],["diabetes_crudeprev",/diabet/i]] as const) {
    const a=health.headers.indexOf(sourceField),b=col(resultPattern);if(a<0||b<0)continue;const values=new Map(health.rows.map(r=>[r[0],r[a]]));check(`Health values match independent ${sourceField}`,rows.every(r=>values.get(id(r)!)!=null&&Math.abs(Number(r[b])-Number(values.get(id(r)!)))<1e-6));
  }
  const pop=col(/^(?:totalpopulation|population|resident_population|residents|denominator)$/i);const health=reference.health.find(v=>v.headers.includes("totalpopulation"));
  if(pop>=0&&health) {const j=health.headers.indexOf("totalpopulation"),values=new Map(health.rows.map(r=>[r[0],Number(r[j])]));check("Resident denominators match source",rows.every(r=>Number(r[pop])===values.get(id(r)!)));}
  const rateCols=h.map((v,i)=>({v,i})).filter(({v})=>/per_?(?:1_?000|10_?000).*resident/i.test(v));
  for(const {v,i} of rateCols) {
    const pattern=/pharma/i.test(v)?/pharma/i:/facilit|epa/i.test(v)?/facilit|epa/i:/311|request/i.test(v)?/311|request/i:/violat|code/i;
    const numerator=countCol(pattern);const divisor=/10_?000/.test(v)?10000:1000;
    check(`Rate arithmetic ${v}`,numerator>=0&&pop>=0&&rows.every(r=>Number(r[pop])>0&&Math.abs(Number(r[i])-Number(r[numerator])/Number(r[pop])*divisor)<1e-5));
  }
  if(["Q04","Q05","Q10","Q20"].includes(q.id)) {
    const x=rateCols[0]?.i??-1;const y=q.id==="Q10"?(rateCols[1]?.i??-1):col(q.id==="Q20"?/asthma/i:/blood|bp|hypertens/i);const c=col(/corr/i);
    const xs=vals(x),ys=vals(y),n=rows.length,sx=xs.reduce((a,b)=>a+b,0),sy=ys.reduce((a,b)=>a+b,0);const num=n*xs.reduce((a,b,i)=>a+b*ys[i]!,0)-sx*sy;const den=Math.sqrt((n*xs.reduce((a,b)=>a+b*b,0)-sx*sx)*(n*ys.reduce((a,b)=>a+b*b,0)-sy*sy));const expected=num/den;
    check("Correlation recomputes from displayed paired rates",x>=0&&y>=0&&c>=0&&Number.isFinite(expected)&&vals(c).every(v=>Math.abs(v-expected)<1e-6));
  }
 } else check("Independent source evidence captured",false);
 return {passed:reasons.length===0,reasons,checks};
}
export function quantile(values:number[],p:number):number {if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b);return s[Math.max(0,Math.ceil(p*s.length)-1)]!;}
