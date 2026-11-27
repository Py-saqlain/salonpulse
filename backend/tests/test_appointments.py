import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from threading import Barrier
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from db_support import LocalPostgresTestCase
from test_auth import auth_config
from test_config_cors import request
from app.core.security import create_access_token
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.main import create_app
from app.models import Appointment, Business, Customer, Service, Staff, User, UserRole
from app.schemas.appointments import AppointmentCreate, AppointmentPatch
from app.services.appointments import create_appointment, patch_appointment


ALL_HOURS = [{"day": day, "start": "00:00", "end": "23:59"} for day in range(7)]


class AppointmentValidationTests(unittest.TestCase):
    def test_schedule_requires_aware_time_and_server_owned_fields_are_rejected(self):
        data = dict(customer_id=uuid4(), staff_id=uuid4(), service_id=uuid4())
        for changes in ({}, {"starts_at": "2030-01-01T09:00:00"},
                        {"starts_at": "2030-01-01T09:00:00Z", "booked_price": "1.00"},
                        {"starts_at": "2030-01-01T09:00:00Z", "status": "completed"},
                        {"starts_at": "2030-01-01T09:00:00Z", "business_id": uuid4()}):
            with self.assertRaises(ValidationError):
                AppointmentCreate(**data, **changes)
        self.assertIsNone(AppointmentCreate(**data, booking_type="walk_in").starts_at)
        with self.assertRaises(ValidationError):
            AppointmentCreate(**data, booking_type="walk_in", starts_at="2030-01-01T09:00:00Z")

    def test_patch_only_accepts_nonnull_supported_fields_and_effective_changes(self):
        for data in ({}, {"status": None}, {"status": "unknown"}, {"staff_id": None},
                     {"starts_at": None}, {"ends_at": "2030-01-01T10:00:00Z"},
                     {"booked_duration_minutes": 1}, {"booking_type": "walk_in"},
                     {"recalculate_service": False}, {"recalculate_service": "true"}):
            with self.assertRaises(ValidationError):
                AppointmentPatch(**data)
        self.assertTrue(AppointmentPatch(recalculate_service=True).recalculate_service)


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class AppointmentFixture(LocalPostgresTestCase):
    def setUp(self):
        super().setUp()
        self.config = auth_config()
        self.app = create_app(self.config)

        def override():
            try:
                with Session(bind=self.connection, join_transaction_mode="create_savepoint", expire_on_commit=False) as session:
                    yield session
            except SQLAlchemyError:
                raise HTTPException(503, "Database unavailable") from None
        self.app.dependency_overrides[get_db] = override
        self.business_a, self.owner_a, self.customer_a, self.staff_a, self.service_a = self.salon()
        self.business_b, self.owner_b, self.customer_b, self.staff_b, self.service_b = self.salon()
        self.staff_user = User(business_id=self.business_a.id, full_name="Receptionist", email=f"staff-{uuid4().hex}@example.com",
                               password_hash="!unusable-test-hash", role=UserRole.STAFF, is_active=True)
        self.second_staff = Staff(business_id=self.business_a.id, name="Second barber", hours=ALL_HOURS)
        self.long_service = Service(business_id=self.business_a.id, name="Long service", duration_minutes=60, price=Decimal("2000.00"))
        self.session.add_all([self.staff_user, self.second_staff, self.long_service])
        self.session.flush()
        self.future = (datetime.now(timezone.utc) + timedelta(days=2)).replace(hour=5, minute=0, second=0, microsecond=0)

    def salon(self):
        business = Business(name="Appointment fixture " + uuid4().hex)
        self.session.add(business)
        self.session.flush()
        user = User(business_id=business.id, full_name="Owner", email=f"owner-{uuid4().hex}@example.com",
                    password_hash="!unusable-test-hash", role=UserRole.OWNER, is_active=True)
        customer = Customer(business_id=business.id, name="Customer")
        staff = Staff(business_id=business.id, name="Barber", hours=ALL_HOURS)
        service = Service(business_id=business.id, name="Haircut", duration_minutes=30, price=Decimal("1000.00"))
        self.session.add_all([user, customer, staff, service])
        self.session.flush()
        return business, user, customer, staff, service

    def payload(self, **changes):
        values = dict(customer_id=str(self.customer_a.id), staff_id=str(self.staff_a.id),
                      service_id=str(self.service_a.id), starts_at=self.future.isoformat())
        values.update(changes)
        return values

    def call(self, method="GET", suffix="", data=None, user=None, anonymous=False, query=b""):
        headers = []
        if not anonymous:
            headers.append(("Authorization", "Bearer " + create_access_token((user or self.owner_a).id, self.config)))
        if data is not None:
            headers.append(("Content-Type", "application/json"))
        status, response_headers, body = asyncio.run(request(self.app, method=method, path="/api/appointments" + suffix,
            extra_headers=headers, body=json.dumps(data).encode() if data is not None else b"", query_string=query))
        return status, response_headers, json.loads(body) if body else None

    def create(self, user=None, **changes):
        status, _, item = self.call("POST", data=self.payload(**changes), user=user)
        self.assertEqual(status, 201)
        return item


class AppointmentDatabaseTests(AppointmentFixture):
    def test_create_read_patch_list_and_delete_cancels_without_losing_history(self):
        item = self.create()
        self.assertEqual(item["business_id"], str(self.business_a.id))
        self.assertEqual(item["status"], "confirmed")
        self.assertEqual(item["booked_price"], "1000.00")
        self.assertEqual(item["booked_duration_minutes"], 30)
        start = datetime.fromisoformat(item["starts_at"])
        self.assertEqual(datetime.fromisoformat(item["ends_at"]), start + timedelta(minutes=30))
        suffix = "/" + item["id"]
        self.assertEqual(self.call(suffix=suffix)[2], item)
        self.assertEqual(self.call()[2]["items"], [item])
        status, _, changed = self.call("PATCH", suffix, {"starts_at": (self.future + timedelta(hours=1)).isoformat()})
        self.assertEqual(status, 200)
        self.assertEqual(changed["id"], item["id"])
        self.assertEqual(self.call("DELETE", suffix)[0], 204)
        self.assertEqual(self.call(suffix=suffix)[2]["status"], "cancelled")
        self.assertEqual(self.call("DELETE", suffix)[0], 204)
        self.assertEqual(self.call()[2]["total"], 1)

    def test_all_endpoints_require_auth_and_staff_can_manage_bookings(self):
        for method, suffix, data in (("POST", "", self.payload()), ("GET", "", None),
                                     ("GET", "/" + str(uuid4()), None), ("PATCH", "/" + str(uuid4()), {"status": "cancelled"}),
                                     ("DELETE", "/" + str(uuid4()), None)):
            status, headers, _ = self.call(method, suffix, data, anonymous=True)
            self.assertEqual(status, 401)
            self.assertEqual(headers["www-authenticate"], "Bearer")
        item = self.create(user=self.staff_user)
        suffix = "/" + item["id"]
        self.assertEqual(self.call(suffix=suffix, user=self.staff_user)[0], 200)
        self.assertEqual(self.call("PATCH", suffix, {"starts_at": (self.future + timedelta(hours=1)).isoformat()}, user=self.staff_user)[0], 200)
        self.assertEqual(self.call("DELETE", suffix, user=self.staff_user)[0], 204)

    def test_foreign_customer_staff_service_and_booking_ids_never_cross_tenants(self):
        for field, record in (("customer_id", self.customer_b), ("staff_id", self.staff_b), ("service_id", self.service_b)):
            self.assertEqual(self.call("POST", data=self.payload(**{field: str(record.id)}))[0], 404)
        other = self.create(user=self.owner_b, customer_id=str(self.customer_b.id), staff_id=str(self.staff_b.id), service_id=str(self.service_b.id))
        for method, body in (("GET", None), ("PATCH", {"status": "cancelled"}), ("DELETE", None)):
            self.assertEqual(self.call(method, "/" + other["id"], body)[0], 404)
        self.assertEqual(self.call()[2]["total"], 0)
        own = self.create()
        for field, record in (("customer_id", self.customer_b), ("staff_id", self.staff_b), ("service_id", self.service_b)):
            self.assertEqual(self.call("PATCH", "/" + own["id"], {field: str(record.id)})[0], 404)
        self.assertEqual(self.call("PATCH", "/" + own["id"], {"business_id": str(self.business_b.id)})[0], 422)

    def test_past_naive_inactive_and_invalid_bookings_are_rejected(self):
        for changes in ({"starts_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
                        {"starts_at": "2030-01-01T09:00:00"}, {"status": "completed"}, {"booked_price": "1.00"},
                        {"ends_at": self.future.isoformat()}, {"booking_type": "invalid"}):
            self.assertEqual(self.call("POST", data=self.payload(**changes))[0], 422)
        self.staff_a.active = False
        self.session.flush()
        self.assertEqual(self.call("POST", data=self.payload())[0], 422)
        self.staff_a.active = True
        self.service_a.active = False
        self.session.flush()
        self.assertEqual(self.call("POST", data=self.payload())[0], 422)
        self.assertEqual(self.call()[2]["total"], 0)

    def test_overlap_rules_adjacency_other_staff_and_cancelled_slots(self):
        item = self.create()
        for changes in ({}, {"starts_at": (self.future + timedelta(minutes=15)).isoformat()},
                        {"starts_at": (self.future - timedelta(minutes=15)).isoformat(), "service_id": str(self.long_service.id)}):
            self.assertEqual(self.call("POST", data=self.payload(**changes))[0], 409)
        self.create(starts_at=(self.future + timedelta(minutes=30)).isoformat())
        self.create(starts_at=(self.future - timedelta(minutes=30)).isoformat())
        self.create(staff_id=str(self.second_staff.id))
        self.assertEqual(self.call("DELETE", "/" + item["id"])[0], 204)
        self.assertEqual(self.call("POST", data=self.payload())[0], 201)

    def test_edit_excludes_itself_but_rejects_conflicts_and_preserves_old_slot(self):
        item = self.create()
        self.create(starts_at=(self.future + timedelta(minutes=30)).isoformat())
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"starts_at": self.future.isoformat()})[0], 200)
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"starts_at": (self.future + timedelta(minutes=15)).isoformat()})[0], 409)
        self.assertEqual(self.call(suffix="/" + item["id"])[2]["starts_at"], item["starts_at"])

    def test_snapshot_preservation_explicit_recalculation_and_service_change(self):
        item = self.create()
        self.service_a.price, self.service_a.duration_minutes = Decimal("1800.00"), 45
        self.session.flush()
        suffix = "/" + item["id"]
        status, _, edited = self.call("PATCH", suffix, {"starts_at": (self.future + timedelta(hours=1)).isoformat()})
        self.assertEqual(status, 200)
        self.assertEqual((edited["booked_price"], edited["booked_duration_minutes"]), ("1000.00", 30))
        status, _, recalculated = self.call("PATCH", suffix, {"recalculate_service": True})
        self.assertEqual(status, 200)
        self.assertEqual((recalculated["booked_price"], recalculated["booked_duration_minutes"]), ("1800.00", 45))
        status, _, changed = self.call("PATCH", suffix, {"service_id": str(self.long_service.id)})
        self.assertEqual(status, 200)
        self.assertEqual((changed["booked_price"], changed["booked_duration_minutes"]), ("2000.00", 60))

    def test_longer_catalog_recalculation_cannot_overrun_another_booking(self):
        item = self.create()
        self.create(starts_at=(self.future + timedelta(minutes=30)).isoformat())
        self.service_a.duration_minutes = 60
        self.session.flush()
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"recalculate_service": True})[0], 409)
        self.assertEqual(self.call(suffix="/" + item["id"])[2]["booked_duration_minutes"], 30)

    def test_status_transitions_and_completed_history_are_protected(self):
        item = self.create()
        suffix = "/" + item["id"]
        self.assertEqual(self.call("PATCH", suffix, {"status": "completed"})[0], 409)
        self.assertEqual(self.call("PATCH", suffix, {"status": "in_progress"})[0], 409)
        with patch("app.services.appointments.utcnow", return_value=self.future + timedelta(seconds=1)):
            self.assertEqual(self.call("PATCH", suffix, {"status": "in_progress"})[0], 200)
            self.assertEqual(self.call("PATCH", suffix, {"status": "confirmed"})[0], 409)
            self.assertEqual(self.call("PATCH", suffix, {"customer_id": str(self.customer_a.id)})[0], 409)
            self.assertEqual(self.call("PATCH", suffix, {"status": "completed"})[0], 200)
        self.assertEqual(self.call("DELETE", suffix)[0], 409)
        self.assertEqual(self.call("PATCH", suffix, {"status": "cancelled"})[0], 409)
        self.assertEqual(self.call("PATCH", suffix, {"starts_at": self.future.isoformat()})[0], 409)
        self.assertEqual(self.call(suffix=suffix)[2]["status"], "completed")
        # Completed/cancelled rows stay in history, but no longer reserve a slot.
        replacement = self.create()
        self.assertEqual(self.call("PATCH", "/" + replacement["id"], {"status": "cancelled"})[0], 200)
        self.assertEqual(self.call("PATCH", "/" + replacement["id"], {"status": "confirmed"})[0], 409)

    def test_walk_in_assigns_server_start_and_begins_in_progress(self):
        payload = self.payload(booking_type="walk_in")
        payload.pop("starts_at")
        before = datetime.now(timezone.utc)
        status, _, item = self.call("POST", data=payload)
        self.assertEqual(status, 201)
        self.assertEqual(item["status"], "in_progress")
        self.assertGreaterEqual(datetime.fromisoformat(item["starts_at"]), before)
        self.assertEqual(self.call("POST", data=payload)[0], 409)
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"status": "completed"})[0], 200)

    def test_date_staff_status_filters_and_pagination_are_tenant_scoped(self):
        boundary = (datetime.now(timezone.utc) + timedelta(days=10)).replace(hour=19, minute=0, second=0, microsecond=0)
        previous = self.create(starts_at=(boundary - timedelta(hours=1)).isoformat())
        current = self.create(starts_at=boundary.isoformat())
        self.create(starts_at=(boundary + timedelta(hours=1)).isoformat(), staff_id=str(self.second_staff.id))
        self.call("DELETE", "/" + previous["id"])
        day = boundary.astimezone(ZoneInfo("Asia/Karachi")).date().isoformat()
        page = self.call(query=f"date={day}&staff_id={self.staff_a.id}&status=confirmed&limit=1&offset=0".encode())[2]
        self.assertEqual(page["items"], [current])
        self.assertEqual(page["total"], 1)
        self.assertEqual(self.call(query=b"status=cancelled")[2]["total"], 1)
        self.assertEqual(self.call(query=f"staff_id={self.staff_b.id}".encode())[0], 404)
        self.assertEqual(self.call(query=b"limit=1&offset=10")[2]["items"], [])
        for query in (b"limit=0", b"limit=101", b"offset=-1", b"status=unknown", b"date=invalid"):
            self.assertEqual(self.call(query=query)[0], 422)


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class AppointmentConcurrencyFixture(LocalPostgresTestCase):
    def seed_committed_fixture(self):
        # Committed races run outside public; cleanup drops only this marked disposable schema.
        from isolated_db import DisposableSchema
        isolated=DisposableSchema();self.addCleanup(isolated.close);self.engine=isolated.engine
        business_id, customer_id, staff_id, service_id, operator_id = (uuid4() for _ in range(5))
        name = "__appointment_concurrency__" + uuid4().hex
        with Session(self.engine, expire_on_commit=False) as session, session.begin():
            session.add(Business(id=business_id, name=name))
            session.flush()
            session.add_all([User(id=operator_id,business_id=business_id,full_name="Concurrency operator",email="race-"+uuid4().hex+"@example.com",password_hash="!unusable"),
                             Customer(id=customer_id, business_id=business_id, name="Concurrency customer"),
                             Staff(id=staff_id, business_id=business_id, name="Concurrency staff", hours=ALL_HOURS),
                             Service(id=service_id, business_id=business_id, name="Concurrency service", duration_minutes=30, price=Decimal("1000.00"))])
        payload = AppointmentCreate(customer_id=customer_id, staff_id=staff_id, service_id=service_id,
                                    starts_at=(datetime.now(timezone.utc) + timedelta(days=3)).replace(hour=5, minute=0, second=0, microsecond=0))
        return TenantScope(business_id,operator_id), payload


class AppointmentConcurrencyTests(AppointmentConcurrencyFixture):
    def test_simultaneous_creates_produce_one_booking_and_one_conflict(self):
        scope, payload = self.seed_committed_fixture()
        barrier = Barrier(2)

        def worker():
            with Session(self.engine, expire_on_commit=False) as session:
                barrier.wait(timeout=10)
                try:
                    create_appointment(session, scope, payload)
                    return 201
                except HTTPException as error:
                    return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(worker) for _ in range(2)]
            self.assertEqual(sorted(future.result(timeout=20) for future in futures), [201, 409])

    def test_simultaneous_reschedules_cannot_claim_the_same_slot(self):
        scope, payload = self.seed_committed_fixture()
        with Session(self.engine, expire_on_commit=False) as session:
            first = create_appointment(session, scope, payload)
            second = create_appointment(session, scope, payload.model_copy(update={"starts_at": payload.starts_at + timedelta(hours=1)}))
        target = AppointmentPatch(starts_at=payload.starts_at + timedelta(hours=2))
        barrier = Barrier(2)

        def worker(appointment_id):
            with Session(self.engine, expire_on_commit=False) as session:
                barrier.wait(timeout=10)
                try:
                    patch_appointment(session, scope, appointment_id, target)
                    return 200
                except HTTPException as error:
                    return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(worker, identifier) for identifier in (first.id, second.id)]
            self.assertEqual(sorted(future.result(timeout=20) for future in futures), [200, 409])


if __name__ == "__main__":
    unittest.main()
