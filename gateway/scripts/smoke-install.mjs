// Offline acceptance check for the built install; only local fixture servers are used.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const home=mkdtempSync(join(tmpdir(),'jev-smoke-'));
const mock=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const r=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',answers:Object.fromEntries(Object.entries(r.questions).map(([id,q])=>[id,{type:'choice',choice:Object.keys(q.criteria)[0],confidence:.99,probabilities:{[Object.keys(q.criteria)[0]]:.99}}])),usage:{input_tokens:10,output_tokens:2}}));});
mock.listen(0,'127.0.0.1');await once(mock,'listening');
const env={PATH:process.env.PATH,HOME:home,TYPESAFE_API_KEY:'fixture-not-a-secret',HOST:'127.0.0.1',PORT:'0',JEV_URL:`http://127.0.0.1:${mock.address().port}/v1/systemone`,JEV_CONTEXT_ROUTING:'true',JEV_DIRECT_CALLS:'false'};
let output='';const child=spawn(process.execPath,[root+'/dist/index.js'],{cwd:env.HOME,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
let mcp;
const deadline=setTimeout(()=>{mcp?.kill();child.kill();},25000);deadline.unref();
try {
 for(let n=0;!output.includes('dashboard:')&&n<100;n++)await new Promise(r=>setTimeout(r,50));
 const base=output.match(/dashboard: (http:\/\/localhost:\d+)/)?.[1]?.replace('localhost','127.0.0.1');assert.ok(base,output);
 assert.equal((await(await fetch(base+'/health')).json()).status,'ok');assert.equal((await fetch(base+'/dashboard')).status,200);
 mcp=spawn(process.execPath,[root+'/bin/master-jev-mcp.mjs'],{cwd:env.HOME,env:{PATH:process.env.PATH,HOME:env.HOME,MASTER_JEV_GATEWAY_URL:base},stdio:['pipe','pipe','pipe']});let data='';mcp.stdout.on('data',b=>data+=b);
 const args={objective:'Offline fixture',context:{kind:'comparison',criterion:'offline',candidates:[{id:'offline',text:'offline calculator'},{id:'online',text:'website'}]}};
 mcp.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'request_decision',arguments:args}}].map(JSON.stringify).join('\n')+'\n');
 const [code]=await once(mcp,'exit');assert.equal(code,0);const rows=data.trim().split('\n').map(JSON.parse);assert.equal(rows[1].result.tools[0].name,'request_decision');assert.equal(JSON.parse(rows[2].result.content[0].text).assessments.selection.choice,'offline');
 const events=await(await fetch(base+'/dashboard/events')).json();assert.equal(events.events.at(-1).context.assessments.selection.choice,'offline');
 console.log('Clean installation smoke: 6 checks passed; fixture JEV, no credentials copied.');
}finally{clearTimeout(deadline);mcp?.kill();if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit');}mock.close();rmSync(home,{recursive:true,force:true});}
