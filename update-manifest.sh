#!/bin/sh
# Refresh the version pins in pi-packages.txt from what is actually installed.
# Run this after `pi install`/`pi update` to capture the new pins, then commit.
#
# Edits the file in place: comments, ordering, @remove/@darwin/@no-extensions
# markers and blank lines are preserved verbatim. Only the @version on existing
# npm: lines changes; newly installed packages are appended at the end.
set -eu
REPO=$(cd "$(dirname "$0")" && pwd)

node -e '
const fs=require("fs"),os=require("os");
const home=os.homedir();
const file=process.argv[1]+"/pi-packages.txt";
const settings=require(home+"/.pi/agent/settings.json");
const lock=require(home+"/.pi/agent/npm/package-lock.json");
const ver=n=>{const e=lock.packages["node_modules/"+n];return e&&e.version;};
// scoped names contain their own @ ("@scope/pkg"), so split on the LAST @ that is not index 0
const splitName=s=>{const i=s.lastIndexOf("@");return i>0?s.slice(0,i):s;};
const srcOf=p=>typeof p==="string"?p:(p&&p.source)||"";
// an entry with an empty extensions array is installed with its extensions disabled
const noExtOf=p=>typeof p==="object"&&p!==null&&Array.isArray(p.extensions)&&p.extensions.length===0;

const installed=new Map();   // name/source -> {prefix, source}
const forks=[];
for(const entry of settings.packages){
  const p=srcOf(entry);
  const prefix=noExtOf(entry)?"@no-extensions ":"";
  if(p.startsWith("npm:")) installed.set(splitName(p.slice(4)),{prefix,source:p});
  else if(p.startsWith("git:")||p.startsWith("http")) installed.set(p,{prefix,source:p});
  else forks.push(p);
}

const lines=fs.readFileSync(file,"utf8").split("\n");
const listed=new Set(), stale=[];
const out=lines.map(line=>{
  const m=line.match(/^((?:@\S+\s+)*)(npm:|git:|http)(\S+)$/);
  if(!m) return line;                                  // comment, blank, prose: untouched
  const [,markers,kind,rest]=m;
  const key=kind==="npm:"?splitName(rest):kind+rest;
  listed.add(key);
  if(markers.includes("@remove")) return line;         // uninstall directives are not pins
  if(!installed.has(key)) { if(!markers.includes("@darwin")) stale.push(key); return line; }
  if(kind!=="npm:") return line;                       // git/http sources carry no version
  const v=ver(key);
  if(!v){ console.error("WARN: no locked version for "+key+" -- left as-is"); return line; }
  return markers+"npm:"+key+"@"+v;
});

const added=[];
for(const [key,{prefix,source}] of installed){
  if(listed.has(key)) continue;
  const v=source.startsWith("npm:")?ver(key):null;
  added.push(prefix+(v?"npm:"+key+"@"+v:source));
}
if(added.length){
  while(out.length && out[out.length-1].trim()==="") out.pop();
  out.push("","# added by update-manifest.sh -- move it next to its neighbours and explain it",...added);
}
fs.writeFileSync(file,out.join("\n").replace(/\n*$/,"\n"));
console.log("refreshed pins in pi-packages.txt");
if(added.length) console.log("added: "+added.join(", "));
if(stale.length) console.log("listed but NOT installed (left in place, check by hand): "+stale.join(", "));
if(forks.length) console.log("local forks (installed from extensions/, not listed): "+forks.join(", "));
' "$REPO"

echo
echo "--- diff ---"
git -C "$REPO" diff --stat -- pi-packages.txt 2>/dev/null || true
