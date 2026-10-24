import {expect,test} from "vitest";
import {gradeQuestion,quantile,type RecordedAnswer} from "../src/questionSet.js";
const refusal={id:"Q21",question:"Which Birmingham tracts?",expected:"refused-correctly",answer_shape:"Refuse outside Montgomery"};
test("a scope refusal passes only for its exact frozen question and a reason",()=>{const r={id:"r",question:refusal.question,status:"refused",rounds:0,answer:{message:"Only Montgomery is in scope"}};expect(gradeQuestion(refusal,r).passed).toBe(true);expect(gradeQuestion(refusal,{...r,question:"Other question"}).passed).toBe(false);});
test("an in-scope missing dataset is not counted as a correct refusal",()=>{expect(gradeQuestion({...refusal,expected:"answered"},{id:"r",question:refusal.question,status:"refused",rounds:0,answer:{message:"No source"}}).passed).toBe(false);});
test("reported success without evidence cannot pass",()=>{expect(gradeQuestion({...refusal,expected:"answered"},{id:"r",question:refusal.question,status:"answered",rounds:1,answer:{}}).passed).toBe(false);});
test("percentiles use the nearest-rank convention",()=>{expect(quantile([1,2,3,4,5],.5)).toBe(3);expect(quantile(Array.from({length:25},(_,i)=>i+1),.9)).toBe(23);});

const rateQuestion={id:"Q03",question:"Rate question",expected:"answered",answer_shape:"Descending rate and independent counts and population"};
const rateRun:RecordedAnswer={id:"r",question:"Rate question",status:"answered",rounds:1,answer:{answer:{headline:"Census Tract 1 has a rate of 10.",points:["Five violations for 500 residents."],how_sure:"These are source counts.",caveats:[]},headers:["name","violations_per_1000_residents","violations_count","total_population","geoid"],rows:[["Census Tract 1","10","5","500","01101000100"]],sql:"SELECT totalpopulation FROM source ORDER BY violations_per_1000_residents DESC",view:"answers.example",plan:{years:{from:2025,to:2025},analysis:{basis:"rates",denominator:"residents",relationship:false}},sources:[{title:"Code Violations",url:"https://example.invalid",filter:"Year='2025'",records:5,sourceCount:5}]}};
const sourceReference={tracts:[["01101000100","Census Tract 1"]] as [string,string][],counts:[{title:"Code Violations",rows:[["01101000100","5"]] as [string,string][]}],health:[{headers:["tractfips","totalpopulation"],rows:[["01101000100","500"]]}]};
test("rate grading checks the arithmetic and both independent source inputs",()=>{
 expect(gradeQuestion(rateQuestion,rateRun,sourceReference).passed).toBe(true);
 for(const [column,value,reason] of [[1,"20","Rate arithmetic"],[2,"6","Counts match independent"],[3,"600","denominators match source"]] as const){
  const changed=structuredClone(rateRun);changed.answer.rows![0]![column]=value;
  expect(gradeQuestion(rateQuestion,changed,sourceReference).reasons.some(r=>r.includes(reason))).toBe(true);
 }
});
test("an empty reference object cannot stand in for independent evidence",()=>{
 const g=gradeQuestion(rateQuestion,rateRun,{tracts:[],counts:[],health:[]});expect(g.passed).toBe(false);expect(g.reasons.some(r=>r.includes("counts captured"))).toBe(true);
});
