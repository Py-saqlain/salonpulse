// Real owner UI and API verification in the harness-owned disposable schema.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function verifyAudit({accounts,command,evaluate,wait,route,submit,logout,login,check}) {
 const tokens=[];
 async function api(index,path,method='GET',body) {
  if(!tokens[index]){const r=await fetch('http://127.0.0.1:8010/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:accounts[index].email,password:accounts[index].password})});check(r.status===200,'Audit fixture login');tokens[index]=(await r.json()).access_token;}
  const r=await fetch('http://127.0.0.1:8010/api/'+path,{method,headers:{Authorization:'Bearer '+tokens[index],'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:r.status===204?null:await r.json()};
 }
 async function post(i,path,body){const r=await api(i,path,'POST',body);check(r.status===201,'Audit fixture create: '+path);return r.data;}
 async function ready(){await wait('!!document.querySelector(".app-shell[data-workspace-ready=true]") && document.querySelector(".directory-toolbar button")?.disabled===false','audit workspace');}
 async function open(){await evaluate('location.hash="audit"');await wait('document.querySelector("[data-audit-ready=true]") && document.querySelector("[data-reconciliation-ready=true]")','audit data');}
 async function click(text,scope='document'){await evaluate(`([...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)} && !b.disabled)).click()`);}
 async function select(action){await evaluate(`(()=>{const e=document.querySelector('[aria-label="Audit action"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(action)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait('!!document.querySelector("[data-audit-ready=true]")','filtered audit');}
 const start=new Date(Date.now()+4*86400000);start.setUTCHours(5,0,0,0);
 await route('register');await submit(accounts[0]);await ready();await open();
 check(await evaluate('document.querySelector(".audit-history").textContent.includes("No audit records")'),'Audit empty state');
 const customer=await post(0,'customers',{name:'Audit synthetic customer'});
 const staff=await post(0,'staff',{name:'Audit barber',hours:Array.from({length:7},(_,day)=>({day,start:'00:00',end:'23:59'}))});
 const service=await post(0,'services',{name:'Audit haircut',duration_minutes:30,price:'1000.00'});
 const booking=await post(0,'appointments',{customer_id:customer.id,staff_id:staff.id,service_id:service.id,starts_at:start.toISOString()});
 const payment={amount:'0.03',method:'cash',reference:'Synthetic reference must not appear in audit',idempotency_key:randomUUID()};
 await post(0,'appointments/'+booking.id+'/payments',payment);
 check((await api(0,'appointments/'+booking.id+'/payments','POST',payment)).status===200,'Audit idempotent replay');
 let report=(await api(0,'finance/reconciliation')).data;check(report.consistent && report.collected_total==='0.03' && report.outstanding_total==='999.97','Exact partial reconciliation');
 check((await api(0,'appointments/'+booking.id,'DELETE')).status===204,'Audited cancellation');
 check((await api(0,'services/'+service.id,'PATCH',{price:'1200'})).status===200,'Audited price edit');
 for(let i=0;i<21;i++)check((await api(0,'services/'+service.id,'PATCH',{price:String(1300+i)})).status===200,'Audit pagination fixture');
 await click('Refresh audit');await wait('!!document.querySelector("[data-audit-ready=true]")','fresh audits');
 check(await evaluate('document.querySelectorAll(".audit-record").length===20'),'Audit first page size');
 await click('Next',`document.querySelector('[aria-label="Audit history pagination"]')`);await wait('document.querySelectorAll(".audit-record").length>0 && document.querySelectorAll(".audit-record").length<20 && !!document.querySelector("[data-audit-ready=true]")','audit next page');
 await select('payment.recorded');await wait('document.querySelectorAll(".audit-record").length===1','single payment audit');
 check(await evaluate('!document.querySelector(".audit-history").textContent.includes("Synthetic reference must not appear in audit") && !document.querySelector(".audit-history").textContent.includes("Audit synthetic customer")'),'Sensitive data leaked into audit UI');
 check(await evaluate('document.querySelector("[data-reconcile-total=outstanding_total]").textContent==="PKR 0.00" && document.querySelector(".audit-checks").textContent.includes("No inconsistencies detected.")'),'Cancelled reconciliation UI');
 await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await click('Refresh audit');await wait('!!document.querySelector(".audit-page [role=alert]")','audit network failure');
 await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await click('Refresh audit');await wait('!!document.querySelector("[data-audit-ready=true]")','audit retry');
 await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Mobile audit overflow');
 await command('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false});
 const event=(await api(0,'audit-logs?action=payment.recorded')).data.items[0];
 check((await api(0,'audit-logs/'+event.id,'DELETE')).status===404,'Mutable audit endpoint exposed');
 await logout();await login(accounts[0]);await ready();await open();check((await api(0,'audit-logs?action=payment.recorded')).data.total===1,'Audit persistence/retry uniqueness');
 await logout();await route('register');await submit(accounts[1]);await ready();await open();
 check((await api(1,'audit-logs?resource_id='+booking.id)).data.total===0,'Cross-tenant audit leaked');
 report=(await api(1,'finance/reconciliation')).data;check(report.consistent && report.collected_total==='0.00' && report.outstanding_total==='0.00','Cross-tenant reconciliation leaked');
 check((await api(1,'audit-logs?business_id='+event.business_id)).status===422,'Client tenant override accepted');
 await logout();
 const backend=fileURLToPath(new URL('../../backend/',import.meta.url));
 const code=`
import json,sys,os
sys.path.insert(0,'tests')
from isolated_db import test_engine
from sqlalchemy import select,update
from app.models import User,Business
x=json.loads(sys.argv[1]);e=test_engine(os.environ['SALONPULSE_TEST_SCHEMA'])
try:
 with e.begin() as c:
  b=c.scalar(select(Business.id).where(Business.name==x['business_name']));assert b and x['business_name'].startswith('__day7_browser__')
  c.execute(update(User).where(User.business_id==b,User.email==x['email']).values(role='staff'))
finally:e.dispose()
`;
 const r=spawnSync(resolve(backend,'.venv/Scripts/python.exe'),['-B','-c',code,JSON.stringify({business_name:accounts[0].business_name,email:accounts[0].email})],{cwd:backend,env:{...process.env,DEBUG:'false',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8'});check(r.status===0,'Isolated staff fixture');
 await login(accounts[0]);await ready();
 check(await evaluate('!Array.from(document.links).some(a=>a.hash==="#audit")'),'Staff audit navigation exposed');
 check((await api(0,'audit-logs')).status===403 && (await api(0,'finance/reconciliation')).status===403,'Staff financial API access');
 await evaluate('location.hash="audit"');await wait('document.body.textContent.includes("Owner access required")','Staff direct audit route');await logout();
}
