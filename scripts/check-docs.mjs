import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
const root=process.cwd();const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/).filter(f=>f.endsWith('.md')))];
let links=0,diagrams=0;const external=[];const errors=[];
for(const file of files){
  const text=await readFile(file,'utf8');let fence=false,language='',lines=[];
  for(const line of text.split(/\r?\n/)){
    if(/^```/.test(line)){if(!fence){fence=true;language=line.slice(3).trim();lines=[];}else{if(language==='mermaid'){diagrams++;if(!/^(flowchart|sequenceDiagram|graph)\b/.test(lines.join('\n').trim()))errors.push(`${file}: invalid Mermaid fence header`);}fence=false;}continue;}
    if(fence){lines.push(line);continue;}
    for(const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
      const href=match[1].replace(/^<|>$/g,'').split('#')[0];if(!href||/^[a-z]+:/i.test(href))continue;
      const path=resolve(dirname(file),decodeURIComponent(href)),child=relative(root,path);
      if(child.startsWith('..')||isAbsolute(child)){external.push(`${file}: ${href}`);continue;}
      try{await access(path);links++;}catch{errors.push(`${file}: missing ${href}`);}
    }
  }
  if(fence)errors.push(`${file}: unclosed code fence`);
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log(JSON.stringify({markdownFiles:files.length,localLinks:links,mermaidFences:diagrams,outsideRepositoryReferences:external,check:'Local targets, balanced fences and Mermaid diagram headers; no native rendering.'},null,2));
