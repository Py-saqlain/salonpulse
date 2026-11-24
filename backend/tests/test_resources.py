import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
import unittest
from uuid import UUID, uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from db_support import LocalPostgresTestCase
from test_auth import auth_config
from test_config_cors import request
from app.core.security import create_access_token
from app.db.session import get_db
from app.main import create_app
from app.models import Appointment, AppointmentStatus, AppointmentType, Business, User, UserRole
from app.schemas.resources import CustomerCreate, CustomerPatch, ServiceCreate, ServicePatch, StaffCreate, StaffPatch


class ResourceValidationTests(unittest.TestCase):
    def test_phone_normalization_matches_pakistani_mobile_formats(self):
        for value in ("0300 1234567", "+92 (300) 1234567", "923001234567", "00923001234567"):
            self.assertEqual(CustomerCreate(name=" Test ", phone=value).phone, "+923001234567")
            self.assertEqual(StaffCreate(name=" Test ", phone=value).phone, "+923001234567")
        for value in (None, "", "  "):
            self.assertIsNone(CustomerCreate(name="Test", phone=value).phone)
        for value in ("123", "+44201234567", "0300abc4567", 3001234567, False):
            with self.assertRaises(ValidationError):
                CustomerCreate(name="Test", phone=value)

    def test_patch_omission_null_and_unknown_fields_are_distinct(self):
        self.assertEqual(CustomerPatch(phone=None).model_dump(exclude_unset=True), {"phone": None})
        self.assertEqual(StaffPatch(specialty=None).model_dump(exclude_unset=True), {"specialty": None})
        self.assertEqual(ServicePatch(category=None).model_dump(exclude_unset=True), {"category": None})
        for schema in (CustomerPatch, StaffPatch, ServicePatch):
            for values in ({}, {"name": None}, {"business_id": str(uuid4())}):
                with self.assertRaises(ValidationError):
                    schema(**values)
        for schema, field in ((StaffPatch, "active"), (ServicePatch, "price"), (ServicePatch, "duration_minutes")):
            with self.assertRaises(ValidationError):
                schema(**{field: None})

    def test_service_price_duration_and_names_validate_before_database_access(self):
        valid = {"name": " Haircut ", "duration_minutes": 30, "price": "0.00"}
        self.assertEqual(ServiceCreate(**valid).name, "Haircut")
        self.assertEqual(ServiceCreate(**valid).price, Decimal("0.00"))
        for changes in ({"price": "-0.01"}, {"price": "100.001"}, {"price": "NaN"}, {"price": "Infinity"},
                        {"price": "10000000000.00"}, {"duration_minutes": 0}, {"duration_minutes": -1},
                        {"duration_minutes": 1441}, {"duration_minutes": True}, {"duration_minutes": "30"},
                        {"name": " "}, {"active": "false"}):
            with self.assertRaises(ValidationError):
                ServiceCreate(**{**valid, **changes})


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class ResourceDatabaseTests(LocalPostgresTestCase):
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
        self.business_a, self.owner_a = self.owner()
        self.business_b, self.owner_b = self.owner()
        self.staff_user = User(business_id=self.business_a.id, full_name="Staff user",
                               email=f"staff-{uuid4().hex}@example.com", password_hash="!unusable-test-hash",
                               role=UserRole.STAFF, is_active=True)
        self.session.add(self.staff_user)
        self.session.flush()

    def owner(self):
        business = Business(name="CRUD fixture " + uuid4().hex)
        self.session.add(business)
        self.session.flush()
        user = User(business_id=business.id, full_name="CRUD owner", email=f"crud-{uuid4().hex}@example.com",
                    password_hash="!unusable-test-hash", role=UserRole.OWNER, is_active=True)
        self.session.add(user)
        self.session.flush()
        return business, user

    def call(self, method, path, data=None, user=None, anonymous=False, query=b""):
        headers = []
        if not anonymous:
            headers.append(("Authorization", "Bearer " + create_access_token((user or self.owner_a).id, self.config)))
        if data is not None:
            headers.append(("Content-Type", "application/json"))
        status, response_headers, body = asyncio.run(request(
            self.app, method=method, path=path, extra_headers=headers, query_string=query,
            body=json.dumps(data).encode() if data is not None else b"",
        ))
        return status, response_headers, json.loads(body) if body else None

    def payload(self, resource, **changes):
        values = {"name": " Test record "}
        if resource == "services":
            values.update(duration_minutes=30, price="750.00")
        values.update(changes)
        return values

    def create(self, resource, user=None, **changes):
        status, _, body = self.call("POST", "/api/" + resource, self.payload(resource, **changes), user=user)
        self.assertEqual(status, 201)
        return body

    def exercise_crud(self, resource, changes):
        item = self.create(resource)
        self.assertEqual(item["name"], "Test record")
        self.assertEqual(item["business_id"], str(self.business_a.id))
        self.assertIn("created_at", item)
        self.assertNotIn("password_hash", item)
        path = f"/api/{resource}/{item['id']}"
        self.assertEqual(self.call("GET", path)[2], item)
        status, _, page = self.call("GET", f"/api/{resource}")
        self.assertEqual(status, 200)
        self.assertEqual(page, {"items": [item], "total": 1, "limit": 20, "offset": 0})
        status, _, updated = self.call("PATCH", path, changes)
        self.assertEqual(status, 200)
        for key, value in changes.items():
            self.assertEqual(updated[key], value)
        self.assertEqual(updated["id"], item["id"])
        self.assertEqual(updated["business_id"], item["business_id"])
        self.assertEqual(self.call("DELETE", path)[0::2], (204, None))
        self.assertEqual(self.call("GET", path)[0], 404)
        self.assertEqual(self.call("GET", f"/api/{resource}")[2]["total"], 0)

    def test_customer_crud(self):
        self.exercise_crud("customers", {"name": "Edited customer", "notes": "Useful notes"})

    def test_staff_crud(self):
        self.exercise_crud("staff", {"specialty": "Hair styling", "active": False})

    def test_service_crud(self):
        self.exercise_crud("services", {"duration_minutes": 45, "price": "950.00", "category": "Hair"})

    def test_all_fifteen_endpoints_require_authentication(self):
        for resource in ("customers", "staff", "services"):
            for method, suffix, body in (("POST", "", self.payload(resource)), ("GET", "", None),
                                         ("GET", "/" + str(uuid4()), None), ("PATCH", "/" + str(uuid4()), {"name": "Changed"}),
                                         ("DELETE", "/" + str(uuid4()), None)):
                status, headers, _ = self.call(method, "/api/" + resource + suffix, body, anonymous=True)
                self.assertEqual(status, 401)
                self.assertEqual(headers["www-authenticate"], "Bearer")

    def test_staff_may_manage_customers_but_only_read_staff_and_services(self):
        customer = self.create("customers", user=self.staff_user)
        path = "/api/customers/" + customer["id"]
        for method, suffix, body in (("GET", "", None), ("GET", "/" + customer["id"], None),
                                     ("PATCH", "/" + customer["id"], {"notes": "Staff edit"}),
                                     ("DELETE", "/" + customer["id"], None)):
            self.assertIn(self.call(method, "/api/customers" + suffix, body, user=self.staff_user)[0], (200, 204))
        for resource in ("staff", "services"):
            item = self.create(resource)
            path = f"/api/{resource}/{item['id']}"
            self.assertEqual(self.call("GET", f"/api/{resource}", user=self.staff_user)[0], 200)
            self.assertEqual(self.call("GET", path, user=self.staff_user)[0], 200)
            for method, target, body in (("POST", f"/api/{resource}", self.payload(resource)),
                                         ("PATCH", path, {"name": "Forbidden"}), ("DELETE", path, None)):
                status, _, _ = self.call(method, target, body, user=self.staff_user)
                self.assertEqual(status, 403)
            self.assertEqual(self.call("GET", path)[2]["name"], item["name"])

    def test_cross_tenant_get_patch_delete_are_hidden_for_every_resource(self):
        for resource in ("customers", "staff", "services"):
            own = self.create(resource)
            other = self.create(resource, user=self.owner_b)
            self.assertEqual(self.call("GET", f"/api/{resource}")[2]["total"], 1)
            path = f"/api/{resource}/{other['id']}"
            for method, body in (("GET", None), ("PATCH", {"name": "Forbidden"}), ("DELETE", None)):
                status, _, error = self.call(method, path, body)
                self.assertEqual(status, 404)
                self.assertEqual(error, {"detail": "Resource not found"})
            self.assertEqual(self.call("GET", path, user=self.owner_b)[2], other)
            self.assertEqual(self.call("GET", f"/api/{resource}/{own['id']}")[0], 200)

    def test_business_and_identity_input_override_is_rejected_on_create_and_patch(self):
        for resource in ("customers", "staff", "services"):
            item = self.create(resource)
            for extra in ({"business_id": str(self.business_b.id)}, {"id": str(uuid4())}, {"role": "owner"}):
                self.assertEqual(self.call("POST", f"/api/{resource}", self.payload(resource, **extra))[0], 422)
                self.assertEqual(self.call("PATCH", f"/api/{resource}/{item['id']}", extra)[0], 422)
            status, _, page = self.call("GET", f"/api/{resource}", query=f"business_id={self.business_b.id}".encode())
            self.assertEqual(status, 200)
            self.assertEqual({row["business_id"] for row in page["items"]}, {str(self.business_a.id)})

    def test_pagination_and_bounds_for_every_resource(self):
        for resource in ("customers", "staff", "services"):
            for index in range(3):
                self.create(resource, name=f"Record {index}")
            self.create(resource, user=self.owner_b, name="Other business")
            all_items = self.call("GET", f"/api/{resource}")[2]["items"]
            status, _, page = self.call("GET", f"/api/{resource}", query=b"limit=1&offset=1")
            self.assertEqual(status, 200)
            self.assertEqual(page, {"items": [all_items[1]], "total": 3, "limit": 1, "offset": 1})
            self.assertEqual(self.call("GET", f"/api/{resource}", query=b"offset=100")[2]["items"], [])
            for query in (b"limit=0", b"limit=101", b"limit=-1", b"offset=-1", b"limit=1.5"):
                self.assertEqual(self.call("GET", f"/api/{resource}", query=query)[0], 422)

    def test_phone_duplicates_are_normalized_tenant_scoped_and_nullable(self):
        for resource in ("customers", "staff"):
            first = self.create(resource, phone="0300 1234567")
            self.assertEqual(first["phone"], "+923001234567")
            status, _, response = self.call("POST", f"/api/{resource}", self.payload(resource, phone="00923001234567"))
            self.assertEqual(status, 409)
            self.assertNotIn("uq_", json.dumps(response))
            self.create(resource, user=self.owner_b, phone="+923001234567")
            second = self.create(resource)
            self.create(resource)
            path = f"/api/{resource}/{second['id']}"
            self.assertEqual(self.call("PATCH", path, {"phone": "923001234567"})[0], 409)
            self.assertIsNone(self.call("GET", path)[2]["phone"])
            first_path = f"/api/{resource}/{first['id']}"
            self.assertEqual(self.call("PATCH", first_path, {"phone": "+923001234567"})[0], 200)
            self.assertIsNone(self.call("PATCH", first_path, {"phone": None})[2]["phone"])

    def test_service_duplicate_active_names_and_reactivation_conflicts(self):
        self.create("services", name=" Haircut ")
        status, _, _ = self.call("POST", "/api/services", self.payload("services", name="  hAiRcUt  "))
        self.assertEqual(status, 409)
        self.create("services", user=self.owner_b, name="Haircut")
        inactive = self.create("services", name="haircut", active=False)
        path = "/api/services/" + inactive["id"]
        self.assertEqual(self.call("PATCH", path, {"active": True})[0], 409)
        self.assertFalse(self.call("GET", path)[2]["active"])
        other = self.create("services", name="Other")
        self.assertEqual(self.call("PATCH", "/api/services/" + other["id"], {"name": "haircut"})[0], 409)

    def test_invalid_inputs_empty_patches_and_required_nulls_are_rejected(self):
        for resource in ("customers", "staff", "services"):
            item = self.create(resource)
            path = f"/api/{resource}/{item['id']}"
            for changes in ({"name": " "}, {"name": None}, {"name": "n" * 201}):
                self.assertEqual(self.call("POST", f"/api/{resource}", self.payload(resource, **changes))[0], 422)
                self.assertEqual(self.call("PATCH", path, changes)[0], 422)
            self.assertEqual(self.call("PATCH", path, {})[0], 422)
            self.assertEqual(self.call("GET", f"/api/{resource}/not-a-uuid")[0], 422)
            self.assertEqual(self.call("GET", f"/api/{resource}/{uuid4()}")[0], 404)
        for resource in ("customers", "staff"):
            self.assertEqual(self.call("POST", f"/api/{resource}", self.payload(resource, phone="invalid"))[0], 422)
        for changes in ({"duration_minutes": 0}, {"price": "-1.00"}, {"price": "NaN"}, {"price": "1.001"}):
            self.assertEqual(self.call("POST", "/api/services", self.payload("services", **changes))[0], 422)

    def test_history_blocks_deletes_but_edits_and_deactivation_preserve_snapshots(self):
        customer, staff, service = (self.create(resource) for resource in ("customers", "staff", "services"))
        start = datetime(2030, 3, 1, 9, tzinfo=timezone.utc)
        appointment = Appointment(business_id=self.business_a.id, customer_id=UUID(customer["id"]), staff_id=UUID(staff["id"]),
                                  service_id=UUID(service["id"]), starts_at=start, ends_at=start + timedelta(minutes=30),
                                  status=AppointmentStatus.COMPLETED, booking_type=AppointmentType.SCHEDULED,
                                  booked_price=Decimal("750.00"), booked_duration_minutes=30)
        self.session.add(appointment)
        self.session.flush()
        for resource, item in (("customers", customer), ("staff", staff), ("services", service)):
            status, _, error = self.call("DELETE", f"/api/{resource}/{item['id']}")
            self.assertEqual(status, 409)
            self.assertNotIn("fk_", json.dumps(error))
            self.assertEqual(self.call("GET", f"/api/{resource}/{item['id']}")[0], 200)
        self.assertEqual(self.call("PATCH", "/api/customers/" + customer["id"], {"name": "Renamed customer"})[0], 200)
        self.assertEqual(self.call("PATCH", "/api/staff/" + staff["id"], {"active": False})[0], 200)
        self.assertEqual(self.call("PATCH", "/api/services/" + service["id"], {"duration_minutes": 45, "price": "1000.00", "active": False})[0], 200)
        self.session.refresh(appointment)
        self.assertEqual(appointment.customer_id, UUID(customer["id"]))
        self.assertEqual(appointment.booked_duration_minutes, 30)
        self.assertEqual(appointment.booked_price, Decimal("750.00"))
        self.assertEqual(appointment.ends_at, start + timedelta(minutes=30))
        self.assertEqual(appointment.status, AppointmentStatus.COMPLETED)


if __name__ == "__main__":
    unittest.main()
