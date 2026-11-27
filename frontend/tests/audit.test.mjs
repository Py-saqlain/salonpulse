import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory=mkdtempSync(join(tmpdir(),'salonpulse-audit-'));let audit;
try {
  writeFileSync(join(directory,'revenueMetrics.mjs'),stripTypeScriptTypes(readFileSync(new URL('../src/revenueMetrics.ts',import.meta.url),'utf8')));
  writeFileSync(join(directory,'audit.mjs'),stripTypeScriptTypes(readFileSync(new URL('../src/audit.ts',import.meta.url),'utf8')).replaceAll("'./revenueMetrics'","'./revenueMetrics.mjs'"));
  audit=await import(pathToFileURL(join(directory,'audit.mjs')));
} finally { rmSync(directory,{recursive:true,force:true}); }
const ids=Array.from({length:4},()=>crypto.randomUUID());
const row=()=>({id:ids[0],business_id:ids[1],operator_id:ids[2],resource_id:ids[3],action:'payment.recorded',created_at:'2026-11-27T10:00:00Z'});
const page=()=>({items:[row()],total:1,limit:20,offset:0});
const report=()=>({business_id:ids[1],currency:'PKR',timezone:'Asia/Karachi',as_of:'2026-11-27T10:00:00Z',collected_total:'30.03',active_booked_total:'100.00',active_paid_total:'0.03',cancelled_collected_total:'30.00',outstanding_total:'99.97',totals_match:true,consistent:true,issues:Object.fromEntries(Object.keys(audit.reconciliationIssues).map(key=>[key,0]))});
test('audit pages preserve scoped UUID identity and validate action filters',()=>{
 assert.deepEqual(audit.checkAudit(page(),ids[1],20,0,'payment.recorded'),page());
 for(const fields of [{business_id:ids[0]},{operator_id:'bad'},{resource_id:'bad'},{action:'forged'},{created_at:'bad'}])assert.throws(()=>audit.checkAudit({...page(),items:[{...row(),...fields}]},ids[1],20,0));
 assert.throws(()=>audit.checkAudit(page(),ids[1],20,0,'service.updated'));
});
test('audit pagination rejects gaps and duplicate events without losing empty states',()=>{
 for(const fields of [{total:-1},{offset:20},{limit:0},{items:[]},{items:[row(),row()],total:2}])assert.throws(()=>audit.checkAudit({...page(),...fields},ids[1],20,0));
 assert.equal(audit.checkAudit({items:[],total:0,limit:20,offset:0},ids[1],20,0).total,0);
});
test('reconciliation checks exact decimal equations including cancelled collections',()=>{
 assert.deepEqual(audit.checkReconciliation(report(),ids[1],'Asia/Karachi'),report());
 assert.throws(()=>audit.checkReconciliation({...report(),outstanding_total:'99.96'},ids[1],'Asia/Karachi'));
 const large={...report(),collected_total:'900719925474099.33',active_booked_total:'900719925474199.30',active_paid_total:'900719925474099.33',cancelled_collected_total:'0.00'};
 assert.equal(audit.checkReconciliation(large,ids[1],'Asia/Karachi').consistent,true);
});
test('inconsistencies remain visible and cannot be falsely labelled clean',()=>{
 const value=report();value.issues.payments_without_matching_audit=1;value.consistent=false;
 assert.equal(audit.checkReconciliation(value,ids[1],'Asia/Karachi').consistent,false);
 assert.throws(()=>audit.checkReconciliation({...value,consistent:true},ids[1],'Asia/Karachi'));
});
test('cross-tenant, unsupported currency and malformed reconciliation results are rejected',()=>{
 for(const fields of [{business_id:ids[0]},{currency:'USD'},{timezone:'UTC'},{as_of:'bad'},{collected_total:'NaN'},{issues:{}},{issues:{...report().issues,overpaid_appointments:-1}}])assert.throws(()=>audit.checkReconciliation({...report(),...fields},ids[1],'Asia/Karachi'));
});
