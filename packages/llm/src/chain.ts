// One place every agent's model call goes through: providers in priority order, retries with backoff,
// a fallback model per role, a daily call budget, and a record of which model actually answered.

import { z } from "zod";
import { ProviderError, type ChatMessage, type ChatResult, type Provider } from "./types.js";

export interface Route {
  provider: Provider;
  model: string;
}

export interface CallRecord extends ChatResult {
  attempt: number;
  ok: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface Budget {
  // Returns false when the day's calls are used up.
  take(): Promise<boolean>;
}

export const unlimited: Budget = { take: async () => true };

export class BudgetExceeded extends Error {
  constructor() {
    super("Today's model calls are used up");
    this.name = "BudgetExceeded";
  }
}

export interface ChainOptions {
  budget?: Budget;
  sequentialJsonRepair?: boolean;
  reasoning?: "on" | "off";
  backoffMs?: number[];
  onSlow?: (seconds: number) => void;
  onCall?: (rec: CallRecord) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  hedgeAfterMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Measured on free Nemotron routes: successful Joiner median 42.9 s, max 135.3 s. A 35 s limit failed 15 of 25
// questions, so one request may take up to 150 s, and a second route is only asked after 30 s.
export const REQUEST_LIMIT_MS = 150000;
export const HEDGE_AFTER_MS = 30000;


type Parsed<T>={ok:true;value:T}|{ok:false;error:string};
export class ModelChain {
 private readonly backoff:number[];
 private readonly sleep:(ms:number)=>Promise<void>;
 constructor(private readonly routes:Route[],private readonly opts:ChainOptions={}) {
  if(!routes.length)throw new Error("no model routes configured");
  this.backoff=opts.backoffMs??[2000,6000,18000];this.sleep=opts.sleep??defaultSleep;
 }
 async chat(messages:ChatMessage[],maxTokens=2000,startAt=0,once=false):Promise<ChatResult> {
  const counter={value:0};
  return this.race((index,signal)=>this.strategy(index,messages,maxTokens,r=>({ok:true,value:r}),false,signal,[],counter),startAt,once);
 }
 async json<T>(messages:ChatMessage[],schema:z.ZodType<T, z.ZodTypeDef, unknown>,maxTokens=2000):Promise<{value:T;calls:ChatResult[]}> {
  const calls:ChatResult[]=[],counter={value:0};
  let value:T;
  if(this.opts.sequentialJsonRepair){
   let found=false,last:unknown;
   for(let index=0;index<this.routes.length;index++){
    try{value=await this.strategy(index,messages,maxTokens,r=>parseJson(r.text,schema),index===0,new AbortController().signal,calls,counter);found=true;break;}
    catch(e){if(this.fatal(e))throw e;last=e;}
   }
   if(!found)throw last instanceof Error?last:new Error("all schema-valid routes failed");
  }else value=await this.race((index,signal,repair)=>this.strategy(index,messages,maxTokens,r=>parseJson(r.text,schema),repair,signal,calls,counter));

  return {value:value!,calls};
 }
 private async strategy<T>(index:number,messages:ChatMessage[],maxTokens:number,parse:(r:ChatResult)=>Parsed<T>,repair:boolean,signal:AbortSignal,calls:ChatResult[],counter:{value:number}):Promise<T> {
  let input=messages;
  for(let generation=0;generation<(repair?2:1);generation++) {
   const {result,parsed}=await this.request(this.routes[index]!,input,maxTokens,parse,signal,counter);
   calls.push(result);
   if(parsed.ok)return parsed.value;
   if(generation+1>=(repair?2:1))throw new ProviderError(`model did not return valid JSON: ${parsed.error}`,result.provider,422,false);
   input=[...messages,{role:"assistant",content:result.text},{role:"user",content:`That was not valid JSON for the required shape (${parsed.error}). Reply with the JSON only.`}];
  }
  throw new Error("no valid model reply");
 }
 private async request<T>(route:Route,messages:ChatMessage[],maxTokens:number,parse:(r:ChatResult)=>Parsed<T>,parent:AbortSignal,counter:{value:number}):Promise<{result:ChatResult;parsed:Parsed<T>}> {
  for(let retry=0;;retry++) {
   parent.throwIfAborted();
   if(!(await(this.opts.budget??unlimited).take()))throw new BudgetExceeded();
   parent.throwIfAborted();
   const attempt=++counter.value,started=Date.now(),controller=new AbortController();
   let timedOut=false;
   const timeout=setTimeout(()=>{timedOut=true;controller.abort(new Error("model request time limit reached"));},this.opts.requestTimeoutMs??REQUEST_LIMIT_MS);
   const signal=AbortSignal.any([parent,controller.signal]);
   const progress=setInterval(()=>this.opts.onSlow?.(Math.round((Date.now()-started)/1000)),30000);
   let abort!:()=>void;
   try {
    const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new Error("model request stopped"));signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
    const result=await Promise.race([route.provider.chat({model:route.model,messages,maxTokens,reasoning:this.opts.reasoning,signal}),stopped]);
    const parsed=parse(result);
    await this.opts.onCall?.({...result,attempt,ok:parsed.ok,error:parsed.ok?undefined:`Invalid JSON: ${parsed.error}`});
    return {result,parsed};
   } catch(e) {
    const cancelled=parent.aborted;
    const error=timedOut?new ProviderError("model request time limit reached",route.provider.id,408,false):e;
    await this.opts.onCall?.({text:"",provider:route.provider.id,modelRequested:route.model,modelServed:"",tokensIn:0,tokensOut:0,ms:Date.now()-started,attempt,ok:false,cancelled,error:cancelled?"Stopped after another route returned a valid reply":(error as Error).message.slice(0,300)});
    if(cancelled)throw error;
    const providerError=error instanceof ProviderError?error:undefined;
    if(providerError&&!providerError.fallback)throw error;
    if(!providerError?.retryable||((providerError.status===204||providerError.status===502)&&retry>=1)||this.backoff[retry]===undefined)throw error;
   } finally {
    clearTimeout(timeout);clearInterval(progress);signal.removeEventListener("abort",abort);
   }
   // An aborted losing request never retries or waits through a backoff.
   let stop!:()=>void;
   const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(parent.reason);parent.addEventListener("abort",stop,{once:true});if(parent.aborted)stop();});
   try {await Promise.race([this.sleep(this.backoff[retry]!),aborted]);}
   finally {parent.removeEventListener("abort",stop);}
  }
 }
 private fatal(error:unknown):boolean {
  return error instanceof BudgetExceeded||(error instanceof ProviderError&&!error.fallback);
 }
 private async race<T>(run:(index:number,signal:AbortSignal,repair:boolean)=>Promise<T>,startAt=0,once=false):Promise<T> {
  let last:unknown;
  for(let index=startAt;index<this.routes.length;) {
   const secondary=once||this.routes[index]!.provider.id==="meterless"?-1:this.routes.findIndex((r,i)=>i>index&&r.model.endsWith(":free"));
   if(secondary<0) {
    try{return await run(index,new AbortController().signal,index===startAt);}
    catch(e){if(this.fatal(e))throw e;last=e;}
    if(once)break;index++;continue;
   }
   const controllers=[new AbortController(),new AbortController()],tasks:Promise<void>[]=[];
   let timer:ReturnType<typeof setTimeout>|undefined;
   try {
    return await new Promise<T>((resolve,reject)=>{
     let launched=false,finished=0,settled=false;
     const launch=(slot:number,route:number)=>{
      const task=Promise.resolve().then(()=>run(route,controllers[slot]!.signal,slot===0&&index===startAt)).then(value=>{
       if(!settled){settled=true;resolve(value);}
      },error=>{
       last=error;finished++;
       if(this.fatal(error)){if(!settled){settled=true;reject(error);}return;}
       if(slot===0&&!launched)startSecond();
       if(finished===2&&!settled){settled=true;reject(error);}
      });
      tasks.push(task);
     };
     const startSecond=()=>{if(launched||settled)return;launched=true;if(timer)clearTimeout(timer);launch(1,secondary);};
     launch(0,index);
     timer=setTimeout(startSecond,this.opts.hedgeAfterMs??HEDGE_AFTER_MS);
    });
   } catch(e) {if(this.fatal(e))throw e;last=e;}
   finally {
    if(timer)clearTimeout(timer);
    for(const c of controllers)c.abort(new Error("another route completed"));
    await Promise.allSettled(tasks);
   }
   index=secondary+1;
  }
  throw last instanceof Error?last:new Error("all model routes failed");
 }
}

export function parseJson<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): { ok: true; value: T } | { ok: false; error: string } {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  let error:string|undefined;
  for(let start=0;start<cleaned.length;start++) {
    if(cleaned[start]!=="{")continue;
    let depth=0,quoted=false,escaped=false;
    for(let end=start;end<cleaned.length;end++) {
      const c=cleaned[end];
      if(quoted) {
        if(escaped)escaped=false;
        else if(c==="\\")escaped=true;
        else if(c==='"')quoted=false;
        continue;
      }
      if(c==='"'){quoted=true;continue;}
      if(c==="{")depth++;
      if(c!=="}"||--depth!==0)continue;
      try {
        const value=JSON.parse(cleaned.slice(start,end+1));
        let result=schema.safeParse(value);
        if(!result.success&&coerceShape(value,result.error.issues))result=schema.safeParse(value);
        if(result.success)return {ok:true,value:result.data};
        error??=result.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; ");
      } catch(e){error??=`JSON parse error: ${(e as Error).message}`;}
      start=end; // skip the objects nested inside this one
      break;
    }
  }
  return {ok:false,error:error??"no schema-matching JSON object found"};
}

// Two shape slips free models make often: a list sent as one string, and one item too many.
function coerceShape(value:unknown,issues:z.ZodIssue[]):boolean {
  let changed=false;
  for(const issue of issues){
    const key=issue.path.at(-1),parent=issue.path.slice(0,-1).reduce<unknown>((o,k)=>o&&typeof o==="object"?(o as Record<string|number,unknown>)[k]:undefined,value);
    if(key===undefined||!parent||typeof parent!=="object")continue;
    const holder=parent as Record<string|number,unknown>,current=holder[key];
    if(issue.code==="invalid_type"&&issue.expected==="array"&&typeof current==="string"&&current.trim()){holder[key]=[current];changed=true;}
    else if(issue.code==="too_big"&&issue.type==="array"&&Array.isArray(current)){holder[key]=current.slice(0,Number(issue.maximum));changed=true;}
  }
  return changed;
}
