import {expect,test} from "vitest";
import {gradeQuestion,quantile,type RecordedAnswer} from "../src/questionSet.js";
const refusal={id:"Q21",question:"Which Birmingham tracts?",expected:"refused-correctly",answer_shape:"Refuse outside Montgomery"};
test("a scope refusal passes only for its exact frozen question and a reason",()=>{const r={id:"r",question:refusal.question,status:"refused",rounds:0,answer:{message:"Only Montgomery is in scope"}};expect(gradeQuestion(refusal,r).passed).toBe(true);expect(gradeQuestion(refusal,{...r,question:"Other question"}).passed).toBe(false);});
test("an in-scope missing dataset is not counted as a correct refusal",()=>{expect(gradeQuestion({...refusal,expected:"answered"},{id:"r",question:refusal.question,status:"refused",rounds:0,answer:{message:"No source"}}).passed).toBe(false);});
test("reported success without evidence cannot pass",()=>{expect(gradeQuestion({...refusal,expected:"answered"},{id:"r",question:refusal.question,status:"answered",rounds:1,answer:{}}).passed).toBe(false);});
test("percentiles use the nearest-rank convention",()=>{expect(quantile([1,2,3,4,5],.5)).toBe(3);expect(quantile(Array.from({length:25},(_,i)=>i+1),.9)).toBe(23);});
