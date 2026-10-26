export interface ComputedFigure {
 id:string; value:number; formula:string; column?:string;
 rows:number[]; labels:string[]; kind:"count"|"total"|"difference"|"percent_change"|"minimum"|"maximum";
}
export function computeFigureLedger(headers:string[],rows:(string|null)[][],namedGroups:number[][]=[]):ComputedFigure[] {
 const out:ComputedFigure[]=[];
 const name=Math.max(0,headers.findIndex(h=>/^(name|tract_name|tract|category|area_name)$/i.test(h)));
 const month=headers.findIndex(h=>/^month$/i.test(h)),year=headers.findIndex(h=>/^year$/i.test(h));
 const labels=rows.map(r=>month>=0?([["January","February","March","April","May","June","July","August","September","October","November","December"][Number(r[month])-1],year>=0?r[year]:""].join(" ").trim()):String(r[name]??""));
 const add=(id:string,value:number,formula:string,indices:number[],kind:ComputedFigure["kind"],column?:string)=>{
  if(Number.isFinite(value))out.push({id,value,formula,rows:indices,labels:indices.map(i=>labels[i]!),kind,...(column?{column}:{})});
 };
 const all=rows.map((_,i)=>i);
 add("row_count",rows.length,"COUNT(result rows)",all,"count");
 if(month>=0){const periods=new Set(rows.map(r=>(year>=0?r[year]+"/":"")+r[month]));add("distinct_periods",periods.size,"COUNT(DISTINCT (year,month))",all,"count");}
 add("calendar_months",12,"MONTHS_PER_CALENDAR_YEAR (calendar definition; not an observed-data count)",[],"count");
 for(const [j,h] of headers.entries()){
  if(/^(year|month|period)$/i.test(h)){
   add("distinct_"+h,new Set(rows.map(r=>r[j]).filter(v=>v!=null)).size,"COUNT(DISTINCT "+h+")",all,"count",h);continue;
  }
  if(j===name||/geoid|fips|identifier|(?:^|_)(id|name|rank|paired)(?:_|$)/i.test(h))continue;
  const cells=rows.map((r,i)=>({i,v:r[j]!=null&&r[j]!==""?Number(r[j]):NaN})).filter(c=>Number.isFinite(c.v));
  if(!cells.length)continue;
  const rate=/rate|per_|prevalence|percent|pct|corr|score|avg|average|mean/i.test(h);
  const sum=(indices:number[])=>cells.filter(c=>indices.includes(c.i)).reduce((a,c)=>a+c.v,0);
  const groups=new Map<number,number[]>();for(const c of cells)groups.set(c.v,[...(groups.get(c.v)??[]),c.i]);
  if(!rate)add(h+"_total",sum(all),"SUM("+h+")",cells.map(c=>c.i),"total",h);
  for(const [suffix,group] of [["zero",cells.filter(c=>c.v===0)],["positive",cells.filter(c=>c.v>0)]] as const){
   const indices=group.map(c=>c.i),condition=h+(suffix==="zero"?" = 0":" > 0");
   add(h+"_"+suffix+"_count",indices.length,"COUNT(rows WHERE "+condition+")",indices,"count",h);
   if(j===headers.findIndex((v,k)=>k!==name&&!/^(year|month|geoid|tractfips)$/i.test(v)))for(const [k,col]of headers.entries()){
    if(k===j||k===name||/geoid|fips|(?:^|_)id(?:_|$)|year|month|rate|per_|prevalence|corr/i.test(col))continue;
    const values=indices.map(i=>rows[i]![k]);
    if(values.every(v=>v!=null&&v!==""&&Number.isFinite(Number(v))))add(h+"_"+suffix+"_"+col+"_total",values.reduce<number>((a,v)=>a+Number(v),0),"SUM("+col+" WHERE "+condition+")",indices,"total",col);
   }
  }
  for(const [value,indices]of groups)if(indices.length>1||groups.size<=12)add(h+"_group_"+value,indices.length,"COUNT(rows WHERE "+h+" = "+value+")",indices,"count",h);
  const max=cells.reduce((a,b)=>b.v>a.v?b:a),min=cells.reduce((a,b)=>b.v<a.v?b:a);
  add(h+"_min",min.v,"MIN("+h+")",[min.i],"minimum",h);add(h+"_max",max.v,"MAX("+h+")",[max.i],"maximum",h);
  if(!rate)for(const n of [3,5,10])if(cells.length>=n)add(h+"_first_"+n+"_total",sum(cells.slice(0,n).map(c=>c.i)),"SUM("+h+" in first "+n+" result rows)",cells.slice(0,n).map(c=>c.i),"total",h);
  const pairs=new Map<string,[typeof max,typeof max]>();
  const pair=(a:typeof max,b:typeof max)=>{if(a.i!==b.i)pairs.set(a.i+":"+b.i,[a,b]);};
  pair(min,max);pair(cells[0]!,cells.at(-1)!);pair(cells[1]??max,cells[0]!);
  for(let i=1;i<cells.length;i++)pair(cells[i-1]!,cells[i]!);
  for(const group of namedGroups){
   const selected=cells.filter(c=>group.includes(c.i)),indices=selected.map(c=>c.i);
   if(!rate&&indices.length>1)add(h+"_named_total_"+indices.join("_"),sum(indices),"SUM("+h+" in rows "+indices.map(i=>i+1).join(",")+")",indices,"total",h);
   for(const a of selected)for(const b of selected)pair(a,b);
  }
  for(const [key,[a,b]]of pairs){
   const expr=h+"[row "+(b.i+1)+"] - "+h+"[row "+(a.i+1)+"]";
   add(h+"_difference_"+key,b.v-a.v,expr,[a.i,b.i],"difference",h);
   if(a.v!==0)add(h+"_percent_"+key,(b.v-a.v)/a.v*100,"100 * ("+expr+") / "+h+"[row "+(a.i+1)+"]",[a.i,b.i],"percent_change",h);
  }
 }
 return out;
}
