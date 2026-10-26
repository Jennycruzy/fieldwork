"""Check tracked and pending evidence without printing configured secrets."""
import json,re,subprocess
from pathlib import Path
files=subprocess.check_output(["git","ls-files","--cached","--others","--exclude-standard"],text=True).splitlines()
secrets=[]
for line in Path(".env").read_text().splitlines() if Path(".env").exists() else []:
 if "=" in line and re.search("KEY|PASSWORD|TOKEN|SECRET",line.split("=",1)[0],re.I):
  v=line.split("=",1)[1].strip().strip("\"'")
  if len(v)>7:secrets.append(v)
errors=[];runs=0
def walk(x,path):
 if isinstance(x,dict):
  for k,v in x.items():
   if re.search(r"^(owner_?name|full_?name|street_?address|email|phone|latitude|longitude|first_?name|last_?name)$",k,re.I):errors.append(path+": record-level key "+k)
   walk(v,path)
 elif isinstance(x,list):
  for v in x:walk(v,path)
for f in sorted(set(files)):
 p=Path(f)
 if not p.is_file():continue
 try:s=p.read_text()
 except UnicodeDecodeError:continue
 if any(v in s for v in secrets) or re.search(r"sk-or-v1-[a-f0-9]{20,}",s):errors.append(f+": configured secret")
 if f.startswith("evidence/runs/") and f.endswith((".json",".jsonl")):
  runs+=1
  for line in s.splitlines() if f.endswith("jsonl") else [s]:walk(json.loads(line),f)
print(json.dumps({"files":len(set(files)),"run_files":runs,"problems":errors}))
assert not errors
