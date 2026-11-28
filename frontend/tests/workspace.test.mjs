import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {stripTypeScriptTypes} from 'node:module';
const directory=mkdtempSync(join(tmpdir(),'salonpulse-workspace-'));let workspace;
try {
 for(const name of ['api','customers','services','staff','appointments','catalog','workspace']) {
  let source=stripTypeScriptTypes(readFileSync(new URL('../src/'+name+'.ts',import.meta.url),'utf8'));
  source=source.replaceAll(/from '\.\/([a-zA-Z]+)'/g,"from './$1.mjs'");writeFileSync(join(directory,name+'.mjs'),source);
 }
 workspace=await import(pathToFileURL(join(directory,'workspace.mjs')));
}finally{rmSync(directory,{recursive:true,force:true});}
const business=crypto.randomUUID();
const response=()=>({business_id:business,appointmentTotal:20000,customers:[],staff:[],services:[],appointments:[],total:5000,history:null,dashboard:null});
test('workspace loads one bounded server page rather than following totals into memory',async()=>{
 const calls=[];const api={request:async path=>{calls.push(path);return response();}};
 const result=await workspace.readWorkspace(api,business,'customers',{page:2,q:'Search'},new AbortController().signal,'Asia/Karachi');
 assert.equal(calls.length,1);assert.match(calls[0],/page=2/);assert.equal(result.total,5000);assert.equal(result.customers.length,0);
});
test('workspace rejects another tenant and oversized pages',async()=>{
 for(const changes of [{business_id:crypto.randomUUID()},{customers:Array.from({length:21},()=>({id:crypto.randomUUID(),business_id:business}))},{total:-1}])
  await assert.rejects(workspace.readWorkspace({request:async()=>({...response(),...changes})},business,'customers',{},new AbortController().signal,'Asia/Karachi'));
});
test('booking searches retain backend totals while fetching only the requested page',async()=>{
 let url;const result=await workspace.bookingOptions({request:async path=>{url=path;return {items:[],total:10000,limit:20,offset:100};}},business,'customers','name',100,new AbortController().signal);
 assert.equal(result.total,10000);assert.equal(result.items.length,0);assert.match(url,/offset=100/);
});

test('cancelled workspace and option reads never issue requests or return old data',async()=>{
 const abort=new AbortController();abort.abort();let calls=0;
 const api={request:async()=>{calls++;return response();}};
 await assert.rejects(workspace.readWorkspace(api,business,'customers',{},abort.signal,'Asia/Karachi'));
 await assert.rejects(workspace.bookingOptions(api,business,'customers','',0,abort.signal));assert.equal(calls,0);
 const later=new AbortController();await assert.rejects(workspace.readWorkspace({request:async()=>{later.abort();return response();}},business,'customers',{},later.signal,'Asia/Karachi'));
});
