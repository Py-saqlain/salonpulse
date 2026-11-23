"""Opt-in PostgreSQL tests: no DDL, commits, or persistent test records.

Set SALONPULSE_RUN_DB_TESTS=1 to run against the guarded local development DB.
Each test has an outer transaction that is always rolled back. Savepoints
isolate expected constraint violations without losing the surrounding fixtures.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
import unittest
from uuid import uuid4

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.base import Base
from app.models import Appointment, AppointmentStatus, AppointmentType, Business, Customer, Service, Staff


@unittest.skipUnless(os.environ.get("SALONPULSE_RUN_DB_TESTS") == "1", "local PostgreSQL tests require explicit opt-in")
class DatabaseIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from app.core.config import Settings
        try:
            settings = Settings()
            if settings.database_url is None:
                raise ValueError
            url = make_url(settings.database_url.get_secret_value())
            if (url.drivername, url.username, url.database, url.port) != (
                "postgresql+psycopg", "salonpulse_app", "salonpulse_dev", 5432,
            ) or url.host not in {"localhost", "127.0.0.1", "::1"}:
                raise ValueError
            cls.engine = create_engine(url, poolclass=NullPool, echo=False, hide_parameters=True,
                                       connect_args={"connect_timeout": 5, "options": "-c statement_timeout=5000 -c lock_timeout=3000"})
            cls.addClassCleanup(cls.engine.dispose)
            with cls.engine.connect() as connection:
                connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                if tuple(connection.execute(text("SELECT current_database(),current_user,inet_server_port()")).one()) != (
                    "salonpulse_dev", "salonpulse_app", 5432,
                ):
                    raise ValueError
                cls.baseline = cls.record_ids(connection)
                cls.index_oid = connection.execute(text(
                    "SELECT 'public.uq_services_business_active_name'::regclass::oid"
                )).scalar_one()
        except Exception:
            raise RuntimeError("Local database safety/connectivity check failed; private details suppressed") from None

    @classmethod
    def record_ids(cls, connection):
        return {name: set(connection.execute(table.select().with_only_columns(table.c.id)).scalars())
                for name, table in Base.metadata.tables.items()}

    @classmethod
    def tearDownClass(cls):
        with cls.engine.connect() as connection:
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            if cls.record_ids(connection) != cls.baseline:
                raise AssertionError("Database record IDs changed after rollback-only integrity tests")
            oid = connection.execute(text("SELECT 'public.uq_services_business_active_name'::regclass::oid")).scalar_one()
            if oid != cls.index_oid:
                raise AssertionError("Existing service index identity changed")

    def setUp(self):
        self.connection = self.engine.connect()
        self.addCleanup(self.connection.close)
        self.transaction = self.connection.begin()
        self.addCleanup(self.transaction.rollback)
        self.session = Session(bind=self.connection, join_transaction_mode="create_savepoint", expire_on_commit=False)
        self.addCleanup(self.session.close)
        self.business, self.customer, self.staff, self.service = self.salon()

    def salon(self):
        business = Business(name="Integrity test " + uuid4().hex)
        self.session.add(business)
        self.session.flush()
        customer = Customer(business_id=business.id, name="Test customer")
        staff = Staff(business_id=business.id, name="Test staff")
        service = Service(business_id=business.id, name="Haircut", duration_minutes=30, price=Decimal("1500.00"))
        self.session.add_all([customer, staff, service])
        self.session.flush()
        return business, customer, staff, service

    def booking_values(self, **overrides):
        start = datetime(2030, 1, 15, 9, tzinfo=timezone.utc)
        values = dict(business_id=self.business.id, customer_id=self.customer.id, staff_id=self.staff.id,
                      service_id=self.service.id, starts_at=start, ends_at=start + timedelta(minutes=30),
                      status=AppointmentStatus.CONFIRMED, booking_type=AppointmentType.SCHEDULED,
                      booked_price=Decimal("1500.00"), booked_duration_minutes=30)
        values.update(overrides)
        return values

    def rejects(self, statement, state, constraint=None):
        # Core execution avoids ORM pre-validation so PostgreSQL enforces rules.
        with self.assertRaises(IntegrityError) as caught:
            with self.connection.begin_nested():
                self.connection.execute(statement)
        self.assertEqual(caught.exception.orig.sqlstate, state)
        if constraint:
            self.assertEqual(caught.exception.orig.diag.constraint_name, constraint)

    def test_relationships_and_stable_historical_references(self):
        appointment = Appointment(**self.booking_values())
        self.session.add(appointment)
        self.session.flush()
        appointment_id = appointment.id
        self.session.expire_all()
        restored = self.session.get(Appointment, appointment_id)
        self.assertIs(restored.business, self.business)
        for name, record in [("customer", self.customer), ("staff", self.staff), ("service", self.service)]:
            self.assertIs(getattr(restored, name), record)
            self.assertIn(restored, record.appointments)
        self.assertIn(restored, self.business.appointments)
        self.assertIn(self.customer, self.business.customers)
        self.assertIn(self.staff, self.business.staff)
        self.assertIn(self.service, self.business.services)
        self.customer.name = "Renamed customer"
        self.session.flush()
        self.session.expire_all()
        self.assertEqual(restored.customer_id, self.customer.id)
        self.assertEqual(restored.customer.name, "Renamed customer")

    def test_required_fields_on_each_table(self):
        cases = [
            (Business, dict(name=None)),
            (Customer, dict(business_id=self.business.id, name=None)),
            (Staff, dict(business_id=self.business.id, name=None)),
            (Service, dict(business_id=self.business.id, name="Invalid", duration_minutes=None, price=0)),
            (Appointment, self.booking_values(customer_id=None)),
        ]
        for model, values in cases:
            with self.subTest(model=model.__name__):
                self.rejects(model.__table__.insert().values(**values), "23502")

    def test_foreign_keys_reject_missing_business_or_booking_references(self):
        self.rejects(Customer.__table__.insert().values(business_id=uuid4(), name="Missing tenant"), "23503")
        for field in ["customer_id", "staff_id", "service_id"]:
            with self.subTest(field=field):
                self.rejects(Appointment.__table__.insert().values(**self.booking_values(**{field: uuid4()})), "23503")

    def test_phone_uniqueness_is_business_scoped_and_nulls_are_allowed(self):
        other_business, _, _, _ = self.salon()
        for model in [Customer, Staff]:
            values = dict(business_id=self.business.id, name="Phone test", phone="+923001234567")
            self.connection.execute(model.__table__.insert().values(**values))
            self.rejects(model.__table__.insert().values(**values), "23505")
            self.connection.execute(model.__table__.insert().values(**{**values, "business_id": other_business.id}))
            for _ in range(2):
                self.connection.execute(model.__table__.insert().values(**{**values, "phone": None}))

    def test_active_service_name_uniqueness_and_inactive_history(self):
        values = dict(business_id=self.business.id, name="  hAiRcUt  ", duration_minutes=30, price=0, active=True)
        self.rejects(Service.__table__.insert().values(**values), "23505", "uq_services_business_active_name")
        self.connection.execute(Service.__table__.insert().values(**{**values, "active": False}))
        other_business = Business(name="Other " + uuid4().hex)
        self.session.add(other_business)
        self.session.flush()
        self.connection.execute(Service.__table__.insert().values(**{**values, "business_id": other_business.id}))

    def test_service_duration_and_price_checks(self):
        for duration, price in [(0, 0), (-1, 0), (30, Decimal("-0.01"))]:
            with self.subTest(duration=duration, price=price):
                self.rejects(Service.__table__.insert().values(business_id=self.business.id, name="Invalid",
                                                              duration_minutes=duration, price=price), "23514")
        self.connection.execute(Service.__table__.insert().values(business_id=self.business.id, name="Free",
                                                                 duration_minutes=1, price=Decimal("0.00")))

    def test_status_and_booking_type_database_checks(self):
        appointment = Appointment(**self.booking_values())
        self.session.add(appointment)
        self.session.flush()
        for field, values in [("status", AppointmentStatus), ("booking_type", AppointmentType)]:
            for value in values:
                self.connection.execute(text(f"UPDATE appointments SET {field}=:value WHERE id=:id"),
                                        {"value": value.value, "id": appointment.id})
            # Fixed column names above; raw SQL bypasses SQLAlchemy enum validation.
            statement = text(f"UPDATE appointments SET {field}='invalid' WHERE id=:id").bindparams(id=appointment.id)
            self.rejects(statement, "23514", "ck_appointments_appointment_" + ("status" if field == "status" else "type"))

    def test_composite_foreign_keys_reject_each_cross_business_reference(self):
        _, customer, staff, service = self.salon()
        for field, record, suffix in [("customer_id", customer, "customer"), ("staff_id", staff, "staff"),
                                      ("service_id", service, "service")]:
            with self.subTest(field=field):
                self.rejects(Appointment.__table__.insert().values(**self.booking_values(**{field: record.id})),
                             "23503", "fk_appointments_business_" + suffix)

    def test_price_duration_snapshots_survive_catalog_updates(self):
        appointment = Appointment(**self.booking_values(status=AppointmentStatus.COMPLETED))
        self.session.add(appointment)
        self.session.flush()
        ends_at = appointment.ends_at
        self.service.price = Decimal("2500.00")
        self.service.duration_minutes = 60
        self.session.flush()
        self.session.expire_all()
        self.assertEqual(appointment.booked_price, Decimal("1500.00"))
        self.assertEqual(appointment.booked_duration_minutes, 30)
        self.assertEqual(appointment.ends_at, ends_at)
        self.assertEqual(appointment.status, AppointmentStatus.COMPLETED)

    def test_restricted_deletion_preserves_completed_history(self):
        appointment = Appointment(**self.booking_values(status=AppointmentStatus.COMPLETED))
        self.session.add(appointment)
        self.session.flush()
        for record in [self.customer, self.staff, self.service, self.business]:
            with self.subTest(model=type(record).__name__):
                table = record.__table__
                self.rejects(table.delete().where(table.c.id == record.id), "23503")
        self.session.expire_all()
        self.assertIsNotNone(self.session.get(Appointment, appointment.id))

    def test_booking_time_and_snapshot_checks(self):
        for changes in [dict(booked_price=Decimal("-0.01")), dict(booked_duration_minutes=0),
                        dict(ends_at=datetime(2030, 1, 15, 8, tzinfo=timezone.utc)), dict(booked_duration_minutes=31)]:
            with self.subTest(changes=changes):
                self.rejects(Appointment.__table__.insert().values(**self.booking_values(**changes)), "23514")

    def test_live_revision_schema_constraints_and_no_pending_changes(self):
        inspector = inspect(self.connection)
        self.assertEqual(set(inspector.get_table_names()), set(Base.metadata.tables) | {"alembic_version"})
        self.assertEqual(self.connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all(),
                         ["b56e17b6641d"])
        totals = {"checks": 0, "foreign_keys": 0, "uniques": 0, "indexes": 0}
        for name, table in Base.metadata.tables.items():
            self.assertEqual(inspector.get_pk_constraint(name)["constrained_columns"], ["id"])
            checks = inspector.get_check_constraints(name)
            self.assertEqual({item["name"] for item in checks},
                             {str(c.name) for c in table.constraints if isinstance(c, CheckConstraint)})
            totals["checks"] += len(checks)
            fks = inspector.get_foreign_keys(name)
            self.assertEqual({(tuple(item["constrained_columns"]), item["referred_table"],
                               tuple(item["referred_columns"]), item["options"].get("ondelete")) for item in fks},
                             {(tuple(c.column_keys), c.referred_table.name,
                               tuple(element.column.name for element in c.elements), c.ondelete)
                              for c in table.constraints if isinstance(c, ForeignKeyConstraint)})
            totals["foreign_keys"] += len(fks)
            uniques = inspector.get_unique_constraints(name)
            self.assertEqual({(c["name"], tuple(c["column_names"])) for c in uniques},
                             {(str(c.name), tuple(c.columns.keys())) for c in table.constraints if isinstance(c, UniqueConstraint)})
            totals["uniques"] += len(uniques)
            indexes = [i for i in inspector.get_indexes(name) if not i.get("duplicates_constraint")]
            self.assertEqual({i["name"] for i in indexes}, {str(i.name) for i in table.indexes})
            totals["indexes"] += len(indexes)
        self.assertEqual(totals, dict(checks=14, foreign_keys=7, uniques=5, indexes=9))
        migration = MigrationContext.configure(connection=self.connection, opts={
            "target_metadata": Base.metadata, "compare_type": True, "compare_server_default": True,
            "autogenerate_plugins": ["alembic.autogenerate.*", "alembic.ext.checkconstraint_byname"],
        })
        self.assertEqual(compare_metadata(migration, Base.metadata), [])


if __name__ == "__main__":
    unittest.main()
