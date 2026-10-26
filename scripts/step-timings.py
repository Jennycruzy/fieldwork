"""Reproduce step timings from saved per-request trace intervals; merge hedged overlaps."""
import json,datetime,math
from pathlib import Path
def quantile(a,q):
 if not a:return 0
 a=sorted(a);return a[max(0,math.ceil(q*len(a))-1)]

def union(intervals):
 total=0;end=0
 for a,b in sorted(intervals):
  total+=max(0,b-max(a,end));end=max(end,b)
 return total
def timings(batch):
 by={s:[] for s in ["planner","finder","wirer","joiner","writer","evaluator","checks"]}
 models={s:set() for s in by}
 wall={s:[] for s in by}
 for r in batch["results"]:
  path=Path("evidence/runs")/(r["run_id"]+".events.jsonl")
  if not path.exists():continue
  es=[json.loads(l)for l in path.read_text().splitlines()]
  for step in by:
   intervals=[]
   if step=="checks":
    recorded=[e for e in es if e["action"]=="code_checks" and e.get("latency_ms") is not None]
    if recorded:intervals=[(ts(e)-e["latency_ms"]/1000,ts(e))for e in recorded]
    else:
     # Only contiguous check events: never charge Writer/model waits to code.
     for a,b in zip(es,es[1:]):
      if all(e["agent"]=="evaluator" and e["action"].startswith("check:")for e in [a,b]):intervals.append((ts(a),ts(b)))
   else:
    for e in es:
     if e["agent"]==step and e["action"]=="model_call":
      end=ts(e);intervals.append((end-(e.get("latency_ms") or 0)/1000,end))
      if e.get("model_served"):models[step].add(e["model_served"])
   by[step].append(union(intervals))
   measured=[e for e in es if (e["agent"]==step and e["action"]=="step_finish")or(step=="checks" and e["action"]=="code_checks")]
   if measured:wall[step].append(sum((e.get("latency_ms")or 0)/1000 for e in measured))

 return [{"step":s,"median_seconds":round(quantile(v,.5),3),"p90_seconds":round(quantile(v,.9),3),"models":sorted(models[s]),"runs":len(v),"wall_median_seconds":round(quantile(wall[s],.5),3) if wall[s] else None,"wall_p90_seconds":round(quantile(wall[s],.9),3) if wall[s] else None}for s,v in by.items()]
def ts(e):return datetime.datetime.fromisoformat(e["ts"].replace("Z","+00:00")).timestamp()
if __name__=="__main__":
 batches=[json.loads(p.read_text())for p in sorted(Path("evidence/question-set").glob("run-*.json"))]
 out={"method":"Per-run union of model request intervals, including retries; hedged overlaps counted once. Median/p90 include zero-call steps. Code checks use explicit duration where present; legacy contiguous check-event spans are lower bounds. Separate wall-time columns include source work and are available only after explicit instrumentation.","batches":[{"started_at":b["started_at"],"code_commit":b.get("code_commit","not recorded"),"complete":b["complete"],"steps":timings(b)}for b in batches]}
 Path("evidence/step-timings.json").write_text(json.dumps(out,indent=2)+"\n")
 for b in out["batches"][-2:]:
  print(b["started_at"],b.get("code_commit","not recorded"))
  for s in b["steps"]:print(s["step"],s["median_seconds"],s["p90_seconds"],",".join(s["models"]))
