// Verify a failed route chunk leaves navigation usable and refresh requires login.
export async function verifyLoading({accounts,command,evaluate,wait,route,submit,login,logout,check,setInterceptor}) {
 await route('register');await submit(accounts[0]);
 await wait('!!document.querySelector(".app-shell[data-workspace-ready=true]") && !!document.querySelector(".kpi")','loaded dashboard');
 let failed=false;
 setInterceptor(async event=>{if(event.request.url.includes('/src/AuditPage.tsx')){failed=true;await command('Fetch.failRequest',{requestId:event.requestId,errorReason:'ConnectionClosed'});}else await command('Fetch.continueRequest',{requestId:event.requestId});});
 await command('Fetch.enable',{patterns:[{urlPattern:'*5174/src/AuditPage.tsx*',requestStage:'Request'}]});
 await evaluate('location.hash="audit"');
 await wait('document.body.textContent.includes("This screen could not load")','route load error boundary');
 check(failed,'Route request was intercepted');check(await evaluate('!!document.querySelector(".app-shell") && !!document.querySelector(".account-logout")'),'Shell remained usable after chunk failure');
 await evaluate('location.hash="dashboard"');await wait('!!document.querySelector(".kpi")','navigate after chunk failure');
 await command('Fetch.disable');setInterceptor(null);
 await command('Page.navigate',{url:'http://127.0.0.1:5174/?chunk-recovery=verified#login'});
 await wait('!!document.querySelector(".auth-form")','chunk recovery requires login');
 check(await evaluate('!document.querySelector(".app-shell")'),'Reload did not retain authentication');
 await login(accounts[0]);await wait('!!document.querySelector(".app-shell[data-workspace-ready=true]")','recovered login');
 await evaluate('location.hash="audit"');await wait('!!document.querySelector("[data-audit-ready=true]")','chunk reloaded successfully');
 check(await evaluate('!document.body.textContent.includes("This screen could not load")'),'Recovered route rendered');await logout();
}
