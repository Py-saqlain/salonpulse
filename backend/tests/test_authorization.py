import asyncio
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from typing import Annotated
import unittest
from unittest.mock import MagicMock
from uuid import UUID, uuid4

from fastapi import Depends, HTTPException
import jwt
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from db_support import LocalPostgresTestCase
from test_auth import auth_config
from test_config_cors import request
from app.api.dependencies import get_tenant_scope, require_owner, require_owner_or_staff
from app.core.security import create_access_token
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.main import create_app
from app.models import (
    Appointment, AppointmentStatus, AppointmentType, Business, Customer, Service, Staff, User, UserRole,
)


class TenantScopeContractTests(unittest.TestCase):
    def test_scope_is_immutable_and_refuses_login_identity_or_business_models(self):
        scope = TenantScope(uuid4())
        with self.assertRaises(FrozenInstanceError):
            scope.business_id = uuid4()
        for model in (User, Business):
            with self.assertRaises(TypeError):
                scope.select(model)

    def test_identity_and_unknown_update_fields_are_rejected_before_sql(self):
        scope, session = TenantScope(uuid4()), MagicMock()
        for values in ({"business_id": uuid4()}, {"id": uuid4()}, {"created_at": datetime.now(timezone.utc)},
                       {"business": Business(name="Untrusted")}, {}):
            with self.assertRaises(HTTPException) as caught:
                scope.update(session, Customer, uuid4(), values)
            self.assertEqual(caught.exception.status_code, 400)
        session.scalar.assert_not_called()


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class AuthorizationDatabaseTests(LocalPostgresTestCase):
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

        # Test-only routes exercise role dependencies; never part of create_app.
        @self.app.get("/test/owner")
        def owner_only(user: Annotated[User, Depends(require_owner)]):
            return {"id": str(user.id)}

        @self.app.get("/test/member")
        def member(user: Annotated[User, Depends(require_owner_or_staff)]):
            return {"id": str(user.id)}

        self.business_a, self.owner_a, self.resources_a = self.salon()
        self.business_b, self.owner_b, self.resources_b = self.salon()
        self.staff_user = User(business_id=self.business_a.id, full_name="Staff identity",
                               email=f"staff-{uuid4().hex}@example.com", password_hash="!unusable-test-hash",
                               role=UserRole.STAFF, is_active=True)
        self.session.add(self.staff_user)
        self.session.flush()

    def salon(self):
        business = Business(name="Authorization fixture " + uuid4().hex)
        self.session.add(business)
        self.session.flush()
        user = User(business_id=business.id, full_name="Owner identity", email=f"owner-{uuid4().hex}@example.com",
                    password_hash="!unusable-test-hash", role=UserRole.OWNER, is_active=True)
        customer = Customer(business_id=business.id, name="Tenant customer")
        staff = Staff(business_id=business.id, name="Tenant employee")
        service = Service(business_id=business.id, name="Tenant service", duration_minutes=30, price=Decimal("900.00"))
        self.session.add_all([user, customer, staff, service])
        self.session.flush()
        start = datetime(2030, 2, 1, 9, tzinfo=timezone.utc)
        appointment = Appointment(business_id=business.id, customer_id=customer.id, staff_id=staff.id,
                                  service_id=service.id, starts_at=start, ends_at=start + timedelta(minutes=30),
                                  status=AppointmentStatus.CONFIRMED, booking_type=AppointmentType.SCHEDULED,
                                  booked_price=Decimal("900.00"), booked_duration_minutes=30)
        self.session.add(appointment)
        self.session.flush()
        return business, user, {Customer: customer, Staff: staff, Service: service, Appointment: appointment}

    def get(self, path, user=None, token=None, query=b"", extra_headers=()):
        if user is not None:
            token = create_access_token(user.id, self.config)
        headers = list(extra_headers)
        if token is not None:
            headers.append(("Authorization", "Bearer " + token))
        status, response_headers, body = asyncio.run(request(self.app, path=path, extra_headers=headers, query_string=query))
        return status, response_headers, json.loads(body)

    def test_each_owner_and_staff_receive_only_own_safe_profiles(self):
        for user, business in ((self.owner_a, self.business_a), (self.owner_b, self.business_b),
                               (self.staff_user, self.business_a)):
            with self.subTest(role=user.role, tenant=business.id):
                status, headers, profile = self.get("/api/auth/me", user=user)
                self.assertEqual(status, 200)
                self.assertEqual(profile["id"], str(user.id))
                self.assertEqual(profile["business_id"], str(business.id))
                self.assertEqual(profile["full_name"], user.full_name)
                self.assertEqual(profile["email"], user.email)
                self.assertEqual(profile["role"], user.role.value)
                self.assertEqual(set(profile), {"id", "business_id", "full_name", "email", "role", "is_active"})
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertNotIn(user.password_hash, json.dumps(profile))
                status, headers, profile = self.get("/api/business/me", user=user)
                self.assertEqual(status, 200)
                self.assertEqual(profile["id"], str(business.id))
                self.assertEqual(profile["name"], business.name)
                self.assertEqual(profile["timezone"], "Asia/Karachi")
                self.assertEqual(profile["currency"], "PKR")
                self.assertEqual(set(profile), {"id", "name", "timezone", "currency", "created_at", "updated_at"})
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertNotIn("password", json.dumps(profile))

    def test_missing_malformed_expired_tampered_and_wrong_algorithm_tokens_return_401(self):
        now = int(datetime.now(timezone.utc).timestamp())
        claims = {"sub": str(self.owner_a.id), "iat": now - 60, "exp": now - 1}
        key = self.config.jwt_secret_key.get_secret_value()
        expired = jwt.encode(claims, key, algorithm="HS256")
        token = create_access_token(self.owner_a.id, self.config)
        parts = token.split(".")
        parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]
        wrong_algorithm = jwt.encode({**claims, "exp": now + 300}, "", algorithm="none")
        for path in ("/api/auth/me", "/api/business/me"):
            for invalid in (None, "", "malformed", expired, ".".join(parts), wrong_algorithm):
                with self.subTest(path=path, kind="missing" if invalid is None else "invalid"):
                    status, headers, _ = self.get(path, token=invalid)
                    self.assertEqual(status, 401)
                    self.assertEqual(headers["www-authenticate"], "Bearer")

    def test_deleted_and_inactive_users_cannot_use_previously_issued_tokens(self):
        inactive_token = create_access_token(self.owner_a.id, self.config)
        deleted_token = create_access_token(self.owner_b.id, self.config)
        self.owner_a.is_active = False
        self.session.delete(self.owner_b)
        self.session.flush()
        for path in ("/api/auth/me", "/api/business/me"):
            for token in (inactive_token, deleted_token):
                self.assertEqual(self.get(path, token=token)[0], 401)

    def test_owner_only_rejects_staff_while_member_access_allows_both(self):
        self.assertEqual(self.get("/test/owner", user=self.owner_a)[0], 200)
        status, headers, body = self.get("/test/owner", user=self.staff_user)
        self.assertEqual(status, 403)
        self.assertEqual(body, {"detail": "Insufficient permissions"})
        self.assertIn("Bearer", headers["www-authenticate"])
        for user in (self.owner_a, self.owner_b, self.staff_user):
            self.assertEqual(self.get("/test/member", user=user)[0], 200)
        self.assertEqual(self.get("/test/owner")[0], 401)

    def test_current_database_role_and_tenant_override_any_token_or_request_claims(self):
        now = int(datetime.now(timezone.utc).timestamp())
        token = jwt.encode({"sub": str(self.owner_a.id), "iat": now, "exp": now + 300,
                            "role": "owner", "business_id": str(self.business_b.id)},
                           self.config.jwt_secret_key.get_secret_value(), algorithm="HS256")
        self.owner_a.role = UserRole.STAFF
        self.session.flush()
        self.assertEqual(self.get("/test/owner", token=token)[0], 403)
        status, _, profile = self.get("/api/auth/me", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(profile["role"], "staff")
        self.assertEqual(profile["business_id"], str(self.business_a.id))
        status, _, business = self.get("/api/business/me", token=token,
                                       query=f"business_id={self.business_b.id}&role=owner".encode(),
                                       extra_headers=[("X-Business-ID", str(self.business_b.id)), ("X-Role", "owner")])
        self.assertEqual(status, 200)
        self.assertEqual(business["id"], str(self.business_a.id))

    def test_scoped_lists_and_lookups_hide_other_business_and_missing_records(self):
        scope = get_tenant_scope(self.owner_a)
        for model in (Customer, Staff, Service, Appointment):
            with self.subTest(model=model.__name__):
                self.assertEqual(scope.get(self.session, model, self.resources_a[model].id).business_id, self.business_a.id)
                records = self.session.scalars(scope.select(model)).all()
                self.assertEqual({record.id for record in records}, {self.resources_a[model].id})
                errors = []
                for resource_id in (self.resources_b[model].id, uuid4()):
                    with self.assertRaises(HTTPException) as caught:
                        scope.get(self.session, model, resource_id)
                    errors.append((caught.exception.status_code, caught.exception.detail))
                self.assertEqual(errors, [(404, "Resource not found"), (404, "Resource not found")])

    def test_scoped_updates_reject_other_business_and_preserve_own_identity(self):
        scope = get_tenant_scope(self.owner_a)
        changes = {Customer: {"notes": "Scoped note"}, Staff: {"specialty": "Scoped specialty"},
                   Service: {"price": Decimal("950.00")}, Appointment: {"status": AppointmentStatus.COMPLETED}}
        for model, values in changes.items():
            with self.subTest(model=model.__name__):
                other = self.resources_b[model]
                previous = {key: getattr(other, key) for key in values}
                with self.assertRaises(HTTPException) as caught:
                    scope.update(self.session, model, other.id, values)
                self.assertEqual(caught.exception.status_code, 404)
                updated = scope.update(self.session, model, self.resources_a[model].id, values)
                self.assertEqual(updated.business_id, self.business_a.id)
                self.assertEqual({key: getattr(updated, key) for key in values}, values)
                self.session.refresh(other)
                self.assertEqual({key: getattr(other, key) for key in values}, previous)
        with self.assertRaises(HTTPException) as caught:
            scope.update(self.session, Customer, self.resources_a[Customer].id, {"business_id": self.business_b.id})
        self.assertEqual(caught.exception.status_code, 400)

    def test_scoped_deletes_reject_other_business_and_only_delete_requested_own_rows(self):
        scope = get_tenant_scope(self.owner_a)
        # Delete the own appointment first so legitimate history FKs stay enforced.
        for model in (Appointment, Customer, Staff, Service):
            with self.subTest(model=model.__name__):
                with self.assertRaises(HTTPException) as caught:
                    scope.delete(self.session, model, self.resources_b[model].id)
                self.assertEqual(caught.exception.status_code, 404)
                own_id, other_id = self.resources_a[model].id, self.resources_b[model].id
                scope.delete(self.session, model, own_id)
                with self.assertRaises(HTTPException) as missing:
                    scope.get(self.session, model, own_id)
                self.assertEqual(missing.exception.status_code, 404)
                self.assertEqual(get_tenant_scope(self.owner_b).get(self.session, model, other_id).business_id, self.business_b.id)


if __name__ == "__main__":
    unittest.main()
