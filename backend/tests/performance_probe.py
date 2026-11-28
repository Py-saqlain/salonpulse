"""Guarded, reproducible HTTP load probe. Only disposable schemas receive test data."""
import sys,os,json,time,socket,subprocess,statistics,secrets
from pathlib import Path
from datetime import datetime,timedelta,timezone
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from urllib.request import Request,urlopen
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from isolated_db import DisposableSchema
from app.models import Business,User,Customer,Staff,Service,Appointment,Payment,AuditLog
from app.core.config import Settings
from app.core.security import create_access_token


def main():
    assert os.environ.get('SALONPULSE_RUN_DB_TESTS')=='1'
    with DisposableSchema() as fixture:
        b,u=uuid4(),uuid4();now=datetime.now(timezone.utc)
        typical='--typical' in sys.argv
        nc,ns,nv,na,np=(1000,10,30,5000,3000) if typical else (5000,100,100,20000,12000)
        customers=[uuid4() for _ in range(nc)];staff=[uuid4() for _ in range(ns)];services=[uuid4() for _ in range(nv)];appointments=[uuid4() for _ in range(na)]
        with fixture.engine.begin() as c:
            c.execute(Business.__table__.insert(),[dict(id=b,name='__performance__')]);c.execute(User.__table__.insert(),[dict(id=u,business_id=b,full_name='Synthetic operator',email='perf-'+uuid4().hex+'@example.com',password_hash='!unusable')])
            c.execute(Customer.__table__.insert(),[dict(id=id,business_id=b,name='Customer '+str(i)) for i,id in enumerate(customers)])
            c.execute(Staff.__table__.insert(),[dict(id=id,business_id=b,name='Staff '+str(i),hours=[dict(day=d,start='09:00' if typical else '00:00',end='18:00' if typical else '23:59') for d in range(7)]) for i,id in enumerate(staff)])
            c.execute(Service.__table__.insert(),[dict(id=id,business_id=b,name='Service '+str(i),duration_minutes=30,price=1000) for i,id in enumerate(services)])
            values=[]
            for i,id in enumerate(appointments):
                start=(now-timedelta(days=60) if i<na//2 else now+timedelta(days=1))+timedelta(minutes=(i%(na//2)//ns)*30)
                if typical:
                    slot=(i%(na//2))//ns
                    start=(now-timedelta(days=60) if i<na//2 else now+timedelta(days=1)).replace(hour=4,minute=0,second=0,microsecond=0)+timedelta(days=slot//16,minutes=(slot%16)*30)
                values.append(dict(id=id,business_id=b,customer_id=customers[i%nc],staff_id=staff[i%ns],service_id=services[i%nv],starts_at=start,ends_at=start+timedelta(minutes=30),status='completed' if i<na//2 else 'confirmed',booking_type='scheduled',booked_price=1000,booked_duration_minutes=30))
            c.execute(Appointment.__table__.insert(),values)
            payments=[dict(id=uuid4(),business_id=b,appointment_id=id,recorded_by_id=u,amount=500,method='cash',paid_at=now-timedelta(days=i%30)) for i,id in enumerate(appointments[:np])]
            c.execute(Payment.__table__.insert(),payments)
            c.execute(AuditLog.__table__.insert(),[dict(id=uuid4(),business_id=b,operator_id=u,action='payment.recorded',resource_id=p['id']) for p in payments])
            for table in ('appointments','customers','staff','services','payments','audit_logs'):c.exec_driver_sql('ANALYZE '+table)
        token=create_access_token(u,Settings())
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        process=subprocess.Popen([sys.executable,'-B','tests/serve_isolated.py',str(port)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={**os.environ,'SALONPULSE_TEST_SCHEMA':fixture.name},cwd=Path(__file__).resolve().parents[1])
        def request(path):
            start=time.perf_counter()
            with urlopen(Request(f'http://127.0.0.1:{port}'+path,headers={'Authorization':'Bearer '+token}),timeout=30) as r:
                blob=r.read();assert r.status==200
            return json.loads(blob),len(blob),(time.perf_counter()-start)*1000
        try:
            for _ in range(100):
                try:request('/health');break
                except Exception:time.sleep(.1)
            optimized='--optimized' in sys.argv
            paths=(['/api/workspace?view=dashboard','/api/workspace?view=appointments'] if optimized else ['/api/customers?limit=20&offset=0','/api/appointments?limit=20&offset=0'])+['/api/analytics/revenue','/api/finance/reconciliation']
            timings={}
            for path in paths:
                samples=[request(path)[2] for _ in range(5)]
                timings[path]={'median_ms':round(statistics.median(samples),2),'max_ms':round(max(samples),2)}
            start=time.perf_counter();size=0;calls=0;rows=0
            if optimized:
                value,size,_=request('/api/workspace?view=dashboard');calls=1;rows=len(value['dashboard']['upcoming'])+len(value['dashboard']['workload'])
            else:
                for resource in ('customers','staff','services','appointments'):
                    offset=0
                    while True:
                        page,n,_=request('/api/'+resource+'?limit=100&offset='+str(offset));size+=n;calls+=1;offset+=len(page['items']);rows+=len(page['items'])
                        if offset>=page['total']:break
            catalog=dict(requests=calls,records=rows,bytes=size,elapsed_ms=round((time.perf_counter()-start)*1000,2))
            start=time.perf_counter()
            with ThreadPoolExecutor(max_workers=10) as workers:results=list(workers.map(lambda i:request(paths[i%len(paths)])[2],range(100)))
            result=dict(seed=dict(customers=nc,staff=ns,services=nv,appointments=na,payments=np),endpoint_timings=timings,
                    catalog_loading=catalog,load=dict(concurrency=10,requests=100,errors=0,p50_ms=round(statistics.median(results),2),p95_ms=round(sorted(results)[94],2),elapsed_ms=round((time.perf_counter()-start)*1000,2)))
            with fixture.engine.connect() as c:
                plan=c.execute(__import__('sqlalchemy').text('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM customers WHERE business_id=:bid ORDER BY created_at DESC,id LIMIT 20'),{'bid':b}).scalar_one()[0]
                result['directory_plan']={'node':plan['Plan']['Node Type'],'child':plan['Plan'].get('Plans',[{}])[0].get('Node Type'),'execution_ms':plan['Execution Time']}
            checked=request('/api/finance/reconciliation')[0]
            assert checked['consistent'] and checked['collected_total']==f'{np*500}.00' and checked['outstanding_total']==f'{na*1000-np*500}.00'
            retry_key=str(uuid4())
            def pay(_):
                body=json.dumps({'amount':'1.00','method':'cash','idempotency_key':retry_key}).encode()
                with urlopen(Request(f'http://127.0.0.1:{port}/api/appointments/{appointments[-1]}/payments',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}),timeout=30) as response:
                    value=json.load(response);return response.status,value['id']
            with ThreadPoolExecutor(max_workers=10) as workers:retries=list(workers.map(pay,range(20)))
            assert sum(status==201 for status,_ in retries)==1 and len({id for _,id in retries})==1
            checked=request('/api/finance/reconciliation')[0]
            assert checked['consistent'] and checked['collected_total']==f'{np*500+1}.00'
            result['concurrent_payment_retries']={'requests':20,'receipts_created':1,'reconciliation_consistent':True}
            def partial(_):
                body=json.dumps({'amount':'0.01','method':'cash','idempotency_key':str(uuid4())}).encode()
                with urlopen(Request(f'http://127.0.0.1:{port}/api/appointments/{appointments[-2]}/payments',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}),timeout=30) as response:
                    value=json.load(response);return response.status,value['id']
            with ThreadPoolExecutor(max_workers=10) as workers:partials=list(workers.map(partial,range(20)))
            assert all(status==201 for status,_ in partials) and len({id for _,id in partials})==20
            checked=request('/api/finance/reconciliation')[0]
            from decimal import Decimal
            assert checked['consistent'] and Decimal(checked['collected_total'])==Decimal(np*500)+Decimal('1.20')
            result['concurrent_partial_payments']={'requests':20,'receipts_created':20,'reconciliation_consistent':True}
            print(json.dumps(result))
            if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
        finally:
            if process.poll() is None:process.stdin.write(b'q');process.stdin.close()
            process.wait(timeout=15)
if __name__=='__main__':main()
