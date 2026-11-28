// Multi-viewport checks use the normal schema-isolated browser harness.
export async function verifyMobile({accounts,command,evaluate,wait,route,submit,logout,check}) {
 await route('register');await submit(accounts[0]);
 await wait('!!document.querySelector(".app-shell[data-workspace-ready=true]")','mobile authenticated workspace');
 const login=await fetch('http://127.0.0.1:8010/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:accounts[0].email,password:accounts[0].password})});
 const token=(await login.json()).access_token;
 async function create(path,body){const r=await fetch('http://127.0.0.1:8010/api/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});check(r.status===201,'Mobile fixture '+path);return r.json();}
 const customer=await create('customers',{name:'Mobile customer '+ 'N'.repeat(120)});
 const staff=await create('staff',{name:'Mobile employee '+ 'S'.repeat(120),hours:Array.from({length:7},(_,day)=>({day,start:'00:00',end:'23:59'}))});
 const service=await create('services',{name:'Mobile service '+ 'V'.repeat(120),duration_minutes:30,price:'1000.00',description:'Description '.repeat(100)});
 const date=new Date(Date.now()+86400000);date.setUTCHours(8,0,0,0);
 await create('appointments',{customer_id:customer.id,staff_id:staff.id,service_id:service.id,starts_at:date.toISOString()});
 async function click(label,scope='document'){await wait(`!!Array.from(${scope}.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.matches(':disabled'))`,'mobile action '+label);await evaluate(`Array.from(${scope}.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);}
 const selectors={dashboard:'.dashboard-status-summary',appointments:'.appointments-page',customers:'.customer-layout',staff:'.staff-grid',services:'.service-filters',analytics:'[data-revenue-ready=true]',audit:'[data-audit-ready=true]'};
 async function navigate(page){await evaluate(`location.hash=${JSON.stringify(page)}`);await wait(`!!document.querySelector(${JSON.stringify(selectors[page])})&&!!document.querySelector('.app-shell[data-workspace-ready=true]')`,'mobile '+page);}
 async function fits(label){check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),label+' document overflow');check(await evaluate(`Array.from(document.querySelectorAll('dialog[open]')).every(d=>d.scrollWidth<=d.clientWidth+1 && d.getBoundingClientRect().left>=-1 && d.getBoundingClientRect().right<=innerWidth+1)`),label+' dialog overflow');}
 for(const width of [320,390,768,1280]) {
  await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<768});
  if(width<768){await evaluate('document.querySelector(".mobile-menu").click()');await wait('document.querySelector(".sidebar").classList.contains("sidebar-open")','mobile navigation open');check(await evaluate('!document.querySelector(".sidebar").inert'),'Mobile navigation usable');await evaluate('document.querySelector(".mobile-menu").click()');}
  for(const page of Object.keys(selectors)){await navigate(page);await fits(page+' '+width);}
  for(const [page,label] of [['customers','Add customer'],['staff','Add employee'],['services','Add service']]){await navigate(page);await click(label);await wait('!!document.querySelector("[data-catalog-editor]")','mobile editor');await fits(page+' form '+width);await click('Cancel','document.querySelector("[data-catalog-editor]")');}
  await click('New appointment');await wait('!!document.querySelector("dialog[open]")','mobile booking');await fits('booking '+width);await click('+ Add customer');await wait('!!document.querySelector("dialog .customer-editor")','quick customer');await fits('quick customer '+width);await evaluate("document.querySelector('dialog[open] .booking-heading button').click()");
  await navigate('appointments');await click('Record payment');await wait('!!document.querySelector("[data-payment-dialog][open]") && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")','mobile payment');await fits('payments '+width);await evaluate("document.querySelector('dialog[open] .booking-heading button').click()");
 }
 await logout();
}
