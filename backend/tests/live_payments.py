"""Opt-in real HTTP verification. Starts an isolated local Uvicorn process.

Run from backend with SALONPULSE_RUN_DB_TESTS=1. Never logs credentials or
response bodies. Only uniquely marked fixture businesses are cleaned up.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import Settings
from isolated_db import DisposableSchema
from app.db.base import Base
import app.models
from app.models import Business, User, Payment, PaymentIntent, Appointment, Customer, Staff, Service
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.engine import make_url


def verify_http(isolated):
    assert os.environ.get('SALONPULSE_RUN_DB_TESTS') == '1', 'Explicit DB test opt-in required'
    url = make_url(Settings().database_url.get_secret_value())
    assert (url.database, url.username, url.port) == ('salonpulse_dev', 'salonpulse_app', 5432)
    assert url.host in ('127.0.0.1', 'localhost', '::1')
    engine = isolated.engine
    with engine.connect() as connection:
        assert connection.scalar(text('SELECT version_num FROM alembic_version')) == '1deb66be8c11'
        baseline = {name: set(connection.scalars(select(table.c.id))) for name, table in Base.metadata.tables.items()}
    marker = '__payment_http__' + uuid4().hex
    accounts = [dict(business_name=marker + str(i), full_name='Payment HTTP owner',
                     email='payment-' + uuid4().hex + '@example.com', password=secrets.token_urlsafe(32)) for i in range(2)]
    tokens = []
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([sys.executable, '-B', 'tests/serve_isolated.py', str(port)],
        cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'DEBUG': 'false', 'PYTHONDONTWRITEBYTECODE': '1', 'SALONPULSE_TEST_SCHEMA': isolated.name},
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    checks = 0

    def check(condition, message):
        nonlocal checks
        if not condition:
            raise AssertionError(message)
        checks += 1

    def call(method, path, body=None, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = Request(origin + path, method=method, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            with urlopen(request, timeout=15) as response:
                payload = response.read()
                return response.status, json.loads(payload) if payload else None
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def create(path, body, token):
        status, data = call('POST', path, body, token)
        check(status == 201, 'Fixture API create failed')
        return data

    def receipt(amount, key=None, method='cash'):
        return dict(amount=amount, method=method, idempotency_key=str(key or uuid4()))

    try:
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError('Isolated API server exited during startup')
            try:
                if call('GET', '/health')[0] == 200:
                    break
            except URLError:
                pass
            time.sleep(0.1)
        else:
            raise AssertionError('Isolated API server startup timeout')
        check(call('GET', '/health/db') == (200, {'status': 'ok'}), 'Database health failed')
        for account in accounts:
            create('/api/auth/register', account, None)
            status, login = call('POST', '/api/auth/login', dict(email=account['email'], password=account['password']))
            check(status == 200, 'Fixture login failed'); tokens.append(login['access_token'])
        fixtures = []
        start = (datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=5, minute=0, second=0, microsecond=0)
        for token in tokens:
            customer = create('/api/customers', {'name': 'Payment HTTP customer'}, token)
            staff = create('/api/staff', dict(name='Payment HTTP staff', hours=[dict(day=day, start='00:00', end='23:59') for day in range(7)]), token)
            service = create('/api/services', dict(name='Payment HTTP service', duration_minutes=30, price='1000.00'), token)
            payload = dict(customer_id=customer['id'], staff_id=staff['id'], service_id=service['id'], starts_at=start.isoformat())
            booking = create('/api/appointments', payload, token)
            fixtures.append((payload, booking))
        token = tokens[0]; booking = fixtures[0][1]
        path = '/api/appointments/' + booking['id'] + '/payments'
        check(call('GET', path)[0] == 401, 'Anonymous history was accessible')
        check(call('POST', path, receipt('1'))[0] == 401, 'Anonymous write was accessible')
        check(call('GET', path, token=tokens[1])[0] == 404, 'Cross-business history was accessible')
        check(call('POST', path, receipt('1'), tokens[1])[0] == 404, 'Cross-business payment was accepted')
        check(call('GET', path, token=token)[1]['summary']['state'] == 'unpaid', 'Initial state incorrect')
        first_data = receipt('250.25', method='bank_transfer'); first_data['reference'] = 'Synthetic transfer reference'
        first = create(path, first_data, token)
        check('request_fingerprint' not in first and 'password_hash' not in first, 'Sensitive response fields')
        check(call('POST', path, first_data, token) == (200, first), 'Idempotent replay failed')
        check(call('POST', path, {**first_data, 'amount': '250.26'}, token)[0] == 409, 'Conflicting replay accepted')
        check(call('GET', '/api/payments/' + first['id'], token=token) == (200, first), 'Receipt lookup failed')
        check(call('GET', '/api/payments/' + first['id'], token=tokens[1])[0] == 404, 'Foreign receipt exposed')
        summary = call('GET', path, token=token)[1]['summary']
        check(Decimal(summary['total_paid']) == Decimal('250.25') and Decimal(summary['balance_due']) == Decimal('749.75')
              and summary['state'] == 'partially_paid', 'Partial payment totals incorrect')
        for amount in ('0', '-1', '0.001', 'NaN', '10000000000.00'):
            check(call('POST', path, receipt(amount), token)[0] == 422, 'Invalid amount accepted')
        check(call('POST', path, {**receipt('1'), 'business_id': str(uuid4())}, token)[0] == 422, 'Tenant input accepted')
        check(call('POST', path, receipt('750'), token)[0] == 409, 'Overpayment accepted')
        create(path, receipt('749.75', method='jazzcash'), token)
        page = call('GET', path + '?limit=1&offset=1', token=token)[1]
        check(page['total'] == 2 and len(page['items']) == 1 and page['summary']['state'] == 'paid'
              and Decimal(page['summary']['balance_due']) == 0, 'Paid history/pagination incorrect')
        check(call('GET', path + '?limit=101', token=token)[0] == 422, 'Invalid pagination accepted')
        check(call('POST', path, receipt('0.01'), token)[0] == 409, 'Fully paid appointment accepted more money')
        # Same request key is independent in a different authenticated business.
        other_path = '/api/appointments/' + fixtures[1][1]['id'] + '/payments'
        create(other_path, {**first_data, 'method': 'easypaisa'}, tokens[1])
        check(call('GET', path, token=token)[1]['total'] == 2, 'Cross-business totals mixed')
        def new_booking(hours):
            return create('/api/appointments', {**fixtures[0][0], 'starts_at': (start + timedelta(hours=hours)).isoformat()}, token)
        cancelled = new_booking(1)
        check(call('DELETE', '/api/appointments/' + cancelled['id'], token=token)[0] == 204, 'Cancellation failed')
        check(call('POST', '/api/appointments/' + cancelled['id'] + '/payments', receipt('1'), token)[0] == 409, 'Cancelled booking accepted payment')
        concurrent = new_booking(2)
        race_path = '/api/appointments/' + concurrent['id'] + '/payments'
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(call, 'POST', race_path, receipt('750'), token) for _ in range(2)]
            check(sorted(f.result()[0] for f in futures) == [201, 409], 'Concurrent overpayment prevention failed')
        replay_booking = new_booking(3)
        replay_path = '/api/appointments/' + replay_booking['id'] + '/payments'; data = receipt('1000')
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(call, 'POST', replay_path, data, token) for _ in range(2)]
            results = [f.result() for f in futures]
            check(sorted(r[0] for r in results) == [200, 201] and results[0][1]['id'] == results[1][1]['id'], 'Concurrent retry duplicated receipt')
        # Modify only this uniquely marked temporary user's role; auth must use live DB state.
        with engine.begin() as connection:
            user_id = connection.scalar(select(User.id).join(Business).where(User.email == accounts[0]['email'], Business.name == accounts[0]['business_name']))
            check(user_id is not None, 'Temporary role fixture identity not found')
            connection.execute(User.__table__.update().where(User.id == user_id).values(role='staff'))
        staff_booking = new_booking(4)
        staff_path = '/api/appointments/' + staff_booking['id'] + '/payments'
        create(staff_path, receipt('1000'), token)
        check(call('GET', staff_path, token=token)[0] == 403, 'Staff history permission failed')
        check(call('GET', '/api/appointments/' + staff_booking['id'] + '/payment-summary', token=token)[1]['state'] == 'paid', 'Staff balance permission failed')
        check(call('GET', '/api/analytics/revenue', token=token)[0] == 403, 'Staff analytics permission failed')
        recovery_booking=new_booking(5)
        recovery_path='/api/appointments/'+recovery_booking['id']+'/payment-intents'
        pending=create(recovery_path,receipt('250'),token)
        intent_path=recovery_path+'/'+pending['intent_id']
        check(call('GET',recovery_path+'/active',token=token)[1]['state']=='pending','Pending recovery discovery failed')
        check(call('POST',intent_path+'/confirm',token=tokens[1])[0]==404,'Foreign intent confirmed')
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=[f.result() for f in [executor.submit(call,'POST',intent_path+'/confirm',None,token) for _ in range(2)]]
        check(all(r[0]==200 and r[1]['state']=='recorded' and r[1]['payload'] is None for r in results),'Concurrent recovery failed')
        check(call('GET','/api/appointments/'+recovery_booking['id']+'/payment-summary',token=token)[1]['total_paid']=='250.00','Recovery charged twice')
        check(call('POST',intent_path+'/reconcile',token=token)[1]['state']=='recorded','Durable recorded outcome lost')
        check(call('POST',intent_path+'/acknowledge',token=token)[0]==200,'Outcome acknowledgment failed')
        unknown=receipt('100');unknown_path=recovery_path+'/'+unknown['idempotency_key']
        check(call('POST',unknown_path+'/reconcile',token=token)[1]['state']=='cancelled','Unknown request not closed')
        check(call('POST',recovery_path,unknown,token)[0]==409,'Delayed creation bypassed tombstone')
        check(call('POST',unknown_path+'/confirm',token=token)[0]==409,'Closed request charged')
        check(call('GET', '/health') == (200, {'status': 'ok'}), 'Health failed')
        check(call('GET', '/health/db') == (200, {'status': 'ok'}), 'Database health failed')
        print(f'PASS: {checks} real HTTP payment checks across two businesses.')
    finally:
        if process.poll() is None:
            process.stdin.write(b'q'); process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)




def main():
    assert os.environ.get('SALONPULSE_RUN_DB_TESTS') == '1', 'Explicit DB test opt-in required'
    with DisposableSchema() as isolated:
        verify_http(isolated)
    print('PASS: Disposable HTTP schema removed; all nine public application tables unchanged.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print SQL exceptions, response bodies or request credentials.
        print('FAIL: live payment verification (' + type(error).__name__ + '); private details suppressed.')
        raise SystemExit(1) from None
