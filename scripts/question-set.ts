import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from "node:fs";
import {config,loadEnvFile} from "../apps/api/src/config.js";
import {openDb} from "../apps/api/src/db.js";
import {ask} from "../apps/api/src/run.js";
import {serializeRun} from "../apps/api/src/evidence.js";
import {gradeQuestion,type QuestionCase,type RecordedAnswer,type Reference} from "../packages/core/src/questionSet.js";
import {ZetarisClient} from "../packages/zetaris/src/index.js";
loadEnvFile();const cfg=config(),db=openDb(cfg.pgUrl);const raw=readFileSync("evidence/questions.json");const frozen=createHash("sha256").update(raw).digest("hex");const qs=JSON.parse(raw.toString()).questions as QuestionCase[];
const dir="evidence/question-set";mkdirSync(dir,{recursive:true});mkdirSync("evidence/runs",{recursive:true});
const path=`${dir}/latest.json`;const resume=process.argv.includes("--resume");const validate=process.argv.includes("--validate");
const committedQuestions=execFileSync("git",["show","58d7d7c:evidence/questions.json"]);
if(!raw.equals(committedQuestions))throw new Error("The frozen question set differs from its original commit; owner approval is required.");
if(qs.length!==25||new Set(qs.map(q=>q.id)).size!==25)throw new Error("Expected all 25 distinct questions");
const codeCommit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const codeFiles=execFileSync("git",["ls-files","--cached","--others","--exclude-standard","apps","packages","scripts"],{encoding:"utf8"}).trim().split("\n").sort();
const codeHash=createHash("sha256");for(const file of codeFiles){codeHash.update(file+"\0");codeHash.update(readFileSync(file));}
const fingerprint=codeHash.digest("hex");
if(validate){console.log(JSON.stringify({questions:qs.length,question_sha256:frozen,code_commit:codeCommit,code_sha256:fingerprint}));await db.end();process.exit(0);}
if(!resume&&existsSync(path)){const prior=JSON.parse(readFileSync(path,"utf8"));writeFileSync(`${dir}/run-${prior.started_at.replace(/[:.]/g,"-")}.json`,JSON.stringify(prior,null,2)+"\n");}
const report: {code_commit?:string;code_sha256?:string;started_at:string;finished_at?:string;question_sha256:string;complete:boolean;passed:number;total:number;rate:number;results:({question_id:string;question:string;expected:string;answer_shape:string;run_id:string;status:string;elapsed_ms:number;passed:boolean;reasons:string[];checks:{name:string;ok:boolean}[]})[]} = resume&&existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{code_commit:codeCommit,code_sha256:fingerprint,started_at:new Date().toISOString(),question_sha256:frozen,complete:false,passed:0,total:qs.length,rate:0,results:[]};
if(report.question_sha256!==frozen)throw new Error("Question file changed; the owner must approve question changes before continuing.");
if(resume&&(report.complete||report.code_sha256!==fingerprint))throw new Error("Resume requires an incomplete run made with the same code. Start a fresh full run instead.");
const archive=`${dir}/run-${report.started_at.replace(/[:.]/g,"-")}.json`;
const save=()=>{report.passed=report.results.filter(r=>r.passed).length;report.rate=report.passed/report.total;report.complete=report.results.length===qs.length;if(report.complete)report.finished_at=new Date().toISOString();writeFileSync(path+".tmp",JSON.stringify(report,null,2)+"\n");renameSync(path+".tmp",path);writeFileSync(archive+".tmp",JSON.stringify(report,null,2)+"\n");renameSync(archive+".tmp",archive);};
try {
 for(const q of qs) {
  if(report.results.some(r=>r.question_id===q.id))continue;
  if(createHash("sha256").update(readFileSync("evidence/questions.json")).digest("hex")!==frozen)throw new Error("Question file changed during evaluation");
  const active=await db.query("SELECT id FROM runs WHERE status='running' LIMIT 1");if(active.rows.length)throw new Error("Another Fieldwork question is running; resume after it finishes.");
  console.log(`${q.id}: ${q.question}`);const start=Date.now();const out=await ask(cfg,db,q.question);const elapsed=Date.now()-start;
  const row=(await db.query("SELECT * FROM runs WHERE id=$1",[out.runId])).rows[0] as RecordedAnswer;const events=(await db.query("SELECT * FROM events WHERE run_id=$1 ORDER BY seq",[out.runId])).rows;
  writeFileSync(`evidence/runs/${out.runId}.run.json`,serializeRun(row as unknown as Record<string,unknown>));writeFileSync(`evidence/runs/${out.runId}.events.jsonl`,events.map(e=>JSON.stringify(e)).join("\n")+"\n");
  const reference:Reference={tracts:[],counts:[],health:[]};
  let referenceError:string|undefined;
  try {if(out.joined) {
    const z=new ZetarisClient(cfg.zetaris);const tracts=await z.query("SELECT geoid, name FROM fw_pg.tracts",500);reference.tracts=tracts.rows as [string,string][];
    for(const b of out.bridged) {const source=out.wired.find(w=>w.label===b.label)!;const values=await z.query(`SELECT geoid, n FROM fw_pg.tract_counts WHERE run_id='${out.runId}' AND source='${b.label}' AND grp='all'`,500);reference.counts.push({title:source.title,rows:values.rows as [string,string][]});}
    for(const w of out.wired.filter(w=>w.shape==="socrata_list"&&w.fields.includes("tractfips"))) {const columns=["tractfips",...w.fields.filter(f=>/^(totalpopulation|totalpop18plus)$|_crudeprev$/.test(f))];const data=await z.query(`SELECT ${columns.join(",")} FROM session.${w.tables[0]}`,500);reference.health.push({headers:data.headers,rows:data.rows});}
    reference.observations=[];
    for(const w of out.wired.filter(w=>w.normalized)) {
      const from=`fw_pg.tract_observations WHERE run_id='${out.runId}' AND source='${w.label}'`;
      const years=await z.query(`SELECT geoid,year,COUNT(*) FROM ${from} GROUP BY geoid,year`,1000);
      const months=await z.query(`SELECT year,month,COUNT(*),SUM(value) FROM ${from} GROUP BY year,month ORDER BY year,month`,1000);
      const categories=await z.query(`SELECT category,COUNT(*) FROM ${from} GROUP BY category`,1000);
      let latest:(string|null)[][]=[],below:(string|null)[][]=[];
      if(w.valueKind==="score") {
        const base=`WITH ordered AS (SELECT geoid,value,event_date,ROW_NUMBER() OVER(PARTITION BY entity_key ORDER BY event_date DESC,record_id) AS rn FROM ${from}) `;
        latest=(await z.query(base+"SELECT geoid,AVG(value),COUNT(*),MIN(event_date),MAX(event_date) FROM ordered WHERE rn=1 AND value IS NOT NULL AND geoid IS NOT NULL GROUP BY geoid",1000)).rows;
        below=(await z.query(base+"SELECT geoid,COUNT(*) FROM ordered WHERE rn=1 AND value<85 AND geoid IS NOT NULL GROUP BY geoid",1000)).rows;
      }
      reference.observations.push({title:w.title,years:years.rows,months:months.rows,categories:categories.rows,latest,below});
    }
    writeFileSync(`evidence/runs/${out.runId}.reference.json`,JSON.stringify(reference,null,2)+"\n");
  }
  } catch(error) {referenceError=`Independent evidence collection failed: ${(error as Error).message.slice(0,500)}`;}
  const grade=gradeQuestion(q,row,reference);if(referenceError){grade.passed=false;grade.reasons.push(referenceError);grade.checks.push({name:"Independent evidence collected successfully",ok:false});}report.results.push({question_id:q.id,question:q.question,expected:q.expected,answer_shape:q.answer_shape,run_id:out.runId,status:out.status,elapsed_ms:elapsed,...grade});save();console.log(`${q.id}: ${grade.passed?"PASS":"FAIL"} ${out.status} ${(elapsed/1000).toFixed(1)}s; ${grade.reasons.join("; ")}`);
 }
 save();console.log(`${report.passed}/${report.total} = ${(report.rate*100).toFixed(1)}%`);
} finally {await db.end();}
