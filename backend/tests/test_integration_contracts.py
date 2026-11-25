"""Frontend field contracts and atomic booking/catalog integration."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
from threading import Barrier
import unittest

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_mock_engine, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from test_appointments import AppointmentFixture, AppointmentConcurrencyFixture
from test_auth import auth_config
from test_config_cors import request
from app.core.security import create_access_token
from app.main import create_app
from app.models import Staff, Service
from app.schemas.resources import StaffCreate, StaffPatch, StaffResponse, ServiceCreate, ServicePatch, ServiceResponse
from app.services.appointments import create_appointment
from app.services.resources import patch_resource


HOURS = [{"day": day, "start": "09:00", "end": "18:00"} for day in range(7)]


class ContractTests(unittest.TestCase):
    def test_hours_validate_days_times_and_null_configuration(self):
        self.assertIsNone(StaffCreate(name="Barber").hours)
        self.assertEqual(StaffCreate(name="Barber", hours=HOURS).hours[0].day, 0)
        for hours in ([], HOURS + [HOURS[0]], [HOURS[0], HOURS[0]],
                      [{"day": True, "start": "09:00", "end": "18:00"}],
                      [{"day": 7, "start": "09:00", "end": "18:00"}],
                      [{"day": 0, "start": "9:00", "end": "18:00"}],
                      [{"day": 0, "start": "18:00", "end": "09:00"}],
                      [{"day": 0, "start": "09:00", "end": "09:00"}],
                      [{"day": 0, "start": "09:00", "end": "24:00"}]):
            with self.subTest(hours=hours), self.assertRaises(ValidationError):
                StaffCreate(name="Barber", hours=hours)
            with self.assertRaises(ValidationError):
                StaffPatch(hours=hours)

    def test_description_and_confirmation_inputs(self):
        self.assertEqual(ServiceCreate(name="Cut", duration_minutes=30, price=0, description="  A trim  ").description, "A trim")
        for data in ({"description": None}, {"description": "x" * 2001}, {"confirm_upcoming": True},
                     {"active": False, "confirm_upcoming": "true"}):
            with self.assertRaises(ValidationError):
                ServicePatch(**data)
        self.assertIsNone(StaffPatch(hours=None).hours)

    def test_openapi_documents_safe_errors_and_nonnull_patch_contract(self):
        document = create_app(auth_config()).openapi()
        schemas = document["components"]["schemas"]
        for name, field in (("StaffPatch", "active"), ("ServicePatch", "description"),
                            ("CustomerPatch", "name"), ("AppointmentPatch", "starts_at")):
            schema = schemas[name]
            self.assertEqual(schema["minProperties"], 1)
            self.assertNotIn('"type": "null"', json.dumps(schema["properties"][field]))
            self.assertNotIn(field, schema.get("required", []))
        self.assertIn("oneOf", schemas["AppointmentCreate"])
        for resource in ("customers", "staff", "services", "appointments"):
            responses = document["paths"]["/api/" + resource]["post"]["responses"]
            self.assertTrue({"401", "403", "404", "409", "422", "503"}.issubset(responses))
            self.assertIn("WWW-Authenticate", responses["401"]["headers"])
        self.assertEqual(set(schemas["ValidationIssue"]["properties"]), {"loc", "msg", "type"})

    def test_migration_is_only_two_additive_columns_and_checks(self):
        scripts = ScriptDirectory.from_config(Config("alembic.ini"))
        revision = scripts.get_revision("4eaceb800869")
        self.assertEqual(revision.down_revision, "6d7519d70bb2")
        statements = []
        engine = create_mock_engine("postgresql+psycopg://", lambda sql, *a, **k: statements.append(sql))
        with Operations.context(MigrationContext.configure(connection=engine)):
            revision.module.upgrade()
        sql = [str(item.compile(dialect=engine.dialect)) for item in statements]
        self.assertEqual(len(sql), 4)
        self.assertTrue(all("ALTER TABLE" in item and "ADD" in item and "DROP" not in item for item in sql))
        self.assertIn("description", sql[0])
        self.assertIn("hours", sql[2])


class WorkingHoursDatabaseTests(AppointmentFixture):
    def resource_patch(self, resource, record_id, data, user=None):
        headers = [("Authorization", "Bearer " + create_access_token((user or self.owner_a).id, self.config)),
                   ("Content-Type", "application/json")]
        status, _, body = asyncio.run(request(self.app, method="PATCH", path=f"/api/{resource}/{record_id}",
            extra_headers=headers, body=json.dumps(data).encode()))
        return status, json.loads(body)

    def test_unconfigured_hours_reject_booking_without_silent_availability(self):
        self.staff_a.hours = None
        self.session.flush()
        self.assertEqual(self.call("POST", data=self.payload())[0], 422)

    def test_business_timezone_days_and_full_duration_are_enforced(self):
        day = (self.future.weekday() + 1) % 7
        # future is 05:00 UTC = 10:00 in Lahore, so a 30-minute visit ends at 10:30.
        self.staff_a.hours = [{"day": day, "start": "10:00", "end": "10:30"}]
        self.session.flush()
        item = self.create()
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"starts_at": (self.future + timedelta(minutes=1)).isoformat()})[0], 422)
        self.assertEqual(self.call("POST", data=self.payload(starts_at=(self.future - timedelta(minutes=1)).isoformat()))[0], 422)
        self.assertEqual(self.call("POST", data=self.payload(starts_at=(self.future + timedelta(days=1)).isoformat()))[0], 422)

    def test_sunday_numbering_and_non_pakistan_business_timezone(self):
        self.business_a.timezone = "UTC"
        self.future += timedelta(days=(6 - self.future.weekday()) % 7)
        self.assertEqual(self.future.weekday(), 6)
        self.staff_a.hours = [{"day": (self.future.weekday() + 1) % 7, "start": "05:00", "end": "05:30"}]
        self.session.flush()
        self.create()

    def test_recalculation_cannot_overrun_shift_and_old_snapshot_is_preserved(self):
        self.staff_a.hours = [{"day": day, "start": "10:00", "end": "10:30"} for day in range(7)]
        self.session.flush()
        item = self.create()
        self.service_a.duration_minutes = 60
        self.session.flush()
        self.assertEqual(self.call("PATCH", "/" + item["id"], {"recalculate_service": True})[0], 422)
        self.assertEqual(self.call(suffix="/" + item["id"])[2]["booked_duration_minutes"], 30)

    def test_hours_change_cannot_invalidate_active_bookings(self):
        item = self.create()
        for hours in (None, [{"day": day, "start": "11:00", "end": "18:00"} for day in range(7)]):
            self.assertEqual(self.resource_patch("staff", self.staff_a.id, {"hours": hours})[0], 409)
        self.assertEqual(self.resource_patch("staff", self.staff_a.id, {"hours": HOURS})[0], 200)
        self.assertEqual(self.call("DELETE", "/" + item["id"])[0], 204)
        self.assertEqual(self.resource_patch("staff", self.staff_a.id, {"hours": None})[0], 200)

    def test_deactivation_requires_confirmation_preserves_booking_and_blocks_new(self):
        item = self.create()
        for resource, record in (("staff", self.staff_a), ("services", self.service_a)):
            self.assertEqual(self.resource_patch(resource, record.id, {"active": False})[0], 409)
            self.assertEqual(self.resource_patch(resource, record.id, {"active": False, "confirm_upcoming": True})[0], 200)
            self.assertEqual(self.call("POST", data=self.payload(starts_at=(self.future + timedelta(hours=1)).isoformat()))[0], 422)
            self.assertEqual(self.call(suffix="/" + item["id"])[2]["status"], "confirmed")

    def test_database_rejects_malformed_hours_container_and_oversized_description(self):
        for model, values in ((Staff, {"hours": []}), (Staff, {"hours": {"day": 0}}),
                              (Service, {"description": "x" * 2001})):
            record = self.staff_a if model is Staff else self.service_a
            with self.assertRaises(IntegrityError) as caught:
                with self.session.begin_nested():
                    self.session.execute(update(model).where(model.id == record.id).values(**values))
            self.assertEqual(caught.exception.orig.sqlstate, "23514")

    def test_invalid_timezone_fails_closed(self):
        self.business_a.timezone = "Invalid/Timezone"
        self.session.flush()
        self.assertEqual(self.call("POST", data=self.payload())[0], 422)

    def test_catalog_fields_preserve_tenant_and_owner_permissions(self):
        for resource, record, changes in (("staff", self.staff_b, {"hours": HOURS}),
                                           ("services", self.service_b, {"description": "A professional trim"})):
            self.assertEqual(self.resource_patch(resource, record.id, changes)[0], 404)
        self.assertEqual(self.resource_patch("staff", self.staff_a.id, {"hours": HOURS}, user=self.staff_user)[0], 403)
        status, body = self.resource_patch("services", self.service_a.id, {"description": " A professional trim "})
        self.assertEqual(status, 200)
        self.assertEqual(body["description"], "A professional trim")


class CatalogConcurrencyTests(AppointmentConcurrencyFixture):
    def run_race(self, resource, values):
        scope, payload = self.seed_committed_fixture()
        barrier = Barrier(2)

        def booking():
            with Session(self.engine, expire_on_commit=False) as session:
                barrier.wait(timeout=10)
                try:
                    create_appointment(session, scope, payload)
                    return 201
                except HTTPException as error:
                    return error.status_code

        def catalog():
            with Session(self.engine, expire_on_commit=False) as session:
                model, schema, response, record_id = (
                    (Staff, StaffPatch, StaffResponse, payload.staff_id) if resource == "staff" else
                    (Service, ServicePatch, ServiceResponse, payload.service_id))
                # Deliberately preload to verify a stale identity is refreshed after the lock.
                scope.get(session, model, record_id)
                barrier.wait(timeout=10)
                try:
                    patch_resource(session, scope, model, record_id, schema(**values), response)
                    return 200
                except HTTPException as error:
                    return error.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            first, second = executor.submit(booking), executor.submit(catalog)
            outcome = first.result(timeout=20), second.result(timeout=20)
        self.assertIn(outcome, {(201, 409), (422, 200)})

    def test_hours_update_and_booking_are_serialized(self):
        self.run_race("staff", {"hours": None})

    def test_staff_deactivation_and_booking_are_serialized(self):
        self.run_race("staff", {"active": False})

    def test_service_deactivation_and_booking_are_serialized(self):
        self.run_race("services", {"active": False})
