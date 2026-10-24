// Postal labels do not determine membership in census tracts.
export function withoutPostalFilters(input:string):string {
 const splitAnd=(text:string):string[]=>{
  let depth=0,quoted=false,start=0;const parts:string[]=[];
  for(let i=0;i<text.length;i++) {
   const c=text[i];if(c==="'"&&quoted&&text[i+1]==="'"){i++;continue;}
   if(c==="'"){quoted=!quoted;continue;}if(quoted)continue;
   if(c==="(")depth++;if(c===")")depth--;
   if(depth===0&&/^\s+AND\s+/i.test(text.slice(i))){const length=text.slice(i).match(/^\s+AND\s+/i)![0].length;parts.push(text.slice(start,i));i+=length-1;start=i+1;}
  }
  parts.push(text.slice(start));return parts;
 };
 const outer=(text:string):boolean=>{
  if(!text.startsWith("(")||!text.endsWith(")"))return false;
  let depth=0,quoted=false;
  for(let i=0;i<text.length;i++){if(text[i]==="'"&&quoted&&text[i+1]==="'"){i++;continue;}if(text[i]==="'")quoted=!quoted;if(quoted)continue;if(text[i]==="(")depth++;if(text[i]===")"&&--depth===0)return i===text.length-1;}
  return false;
 };
 const prune=(raw:string):string=>{
  const text=raw.trim();
  if(outer(text)){const next=prune(text.slice(1,-1));return next?`(${next})`:"";}
  const parts=splitAnd(text);if(parts.length>1)return parts.map(prune).filter(Boolean).join(" AND ");
  return /^(?:City|STATE|stateabbr)\s*=\s*'(?:[^']|'')*'$/i.test(text)?"":text;
 };
 return prune(input)||"1=1";
}
