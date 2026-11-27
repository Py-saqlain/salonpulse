"""Model checks require no engine, database connection, or schema creation."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest
from uuid import UUID, uuid4
import warnings

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import SAWarning
from sqlalchemy.orm import configure_mappers
from sqlalchemy.schema import CreateIndex, CreateTable

from app.db.base import Base
from app.models import Appointment, AppointmentStatus, AppointmentType, Business, Customer, Service, Staff


class ModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dialect = postgresql.dialect()
        with warnings.catch_warnings():
            warnings.simplefilter("error", SAWarning)
            configure_mappers()

    def test_all_models_registered_and_postgresql_ddl_compiles(self):
        self.assertEqual(set(Base.metadata.tables), {"businesses", "customers", "staff", "services", "appointments", "users", "payments", "payment_intents"})
        for table in Base.metadata.sorted_tables:
            ddl = str(CreateTable(table).compile(dialect=self.dialect))
            self.assertIn("CREATE TABLE", ddl)
            self.assertNotIn("CASCADE", ddl)
            for index in table.indexes:
                self.assertIn("CREATE", str(CreateIndex(index).compile(dialect=self.dialect)))

    def test_uuid_keys_and_required_tenant_fields(self):
        for model in [Business, Customer, Staff, Service, Appointment]:
            columns = model.__table__.c
            self.assertTrue(columns.id.primary_key)
            self.assertTrue(columns.id.type.as_uuid)
            self.assertIsInstance(columns.id.default.arg(None), UUID)
            for name in (["name"] if model is Business else ["business_id"]):
                self.assertFalse(columns[name].nullable)
        for name in ["customer_id", "staff_id", "service_id", "starts_at", "ends_at", "status",
                     "booking_type", "booked_price", "booked_duration_minutes"]:
            self.assertFalse(Appointment.__table__.c[name].nullable)

    def test_timestamps_and_business_defaults(self):
        for table in Base.metadata.tables.values():
            for name in ["created_at", "updated_at"]:
                column = table.c[name]
                self.assertFalse(column.nullable)
                self.assertTrue(column.type.timezone)
                self.assertIsNotNone(column.server_default)
            self.assertIsNotNone(table.c.updated_at.onupdate)
        self.assertEqual(Business.__table__.c.timezone.default.arg, "Asia/Karachi")
        self.assertEqual(Business.__table__.c.currency.default.arg, "PKR")

    def test_relationships_are_bidirectional_and_tenant_aware(self):
        self.assertEqual(set(inspect(Business).relationships.keys()), {"customers", "staff", "services", "appointments", "users", "payments"})
        for name in ["customer", "staff", "service"]:
            relation = inspect(Appointment).relationships[name]
            self.assertFalse(relation.uselist)
            self.assertEqual(relation.back_populates, "appointments")
            self.assertIn("business_id", str(relation.primaryjoin))
            self.assertEqual(len(relation.synchronize_pairs), 1)
            reverse = inspect(relation.mapper.class_).relationships.appointments
            self.assertTrue(reverse.uselist)
            self.assertEqual(reverse.back_populates, name)

    def test_relationship_assignment_preserves_business_and_history(self):
        tenant = uuid4()
        business = Business(id=tenant, name="Lahore Salon")
        customer = Customer(id=uuid4(), business=business, name="Ayesha")
        appointment = Appointment(business_id=tenant, customer=customer)
        self.assertIn(appointment, customer.appointments)
        self.assertIn(customer, business.customers)
        customer.name = "Ayesha Khan"
        self.assertIs(appointment.customer, customer)
        self.assertEqual(appointment.business_id, tenant)

    def test_composite_foreign_keys_require_matching_business(self):
        constraints = [constraint for constraint in Appointment.__table__.constraints
                       if isinstance(constraint, ForeignKeyConstraint) and len(constraint.columns) == 2]
        self.assertEqual(len(constraints), 3)
        for entity, target in [("customer", "customers"), ("staff", "staff"), ("service", "services")]:
            constraint = next(item for item in constraints if f"{entity}_id" in item.column_keys)
            self.assertEqual(constraint.column_keys, ["business_id", f"{entity}_id"])
            self.assertEqual([element.target_fullname for element in constraint.elements],
                             [f"{target}.business_id", f"{target}.id"])
            self.assertEqual(constraint.ondelete, "RESTRICT")
            target_table = Base.metadata.tables[target]
            self.assertTrue(any(isinstance(item, UniqueConstraint) and
                                list(item.columns.keys()) == ["business_id", "id"]
                                for item in target_table.constraints))

    def test_phone_uniqueness_scoped_to_business_and_nulls_allowed(self):
        for model in [Customer, Staff]:
            table = model.__table__
            self.assertTrue(table.c.phone.nullable)
            unique = [list(item.columns.keys()) for item in table.constraints if isinstance(item, UniqueConstraint)]
            self.assertIn(["business_id", "phone"], unique)
            self.assertNotIn(["phone"], unique)
            checks = " ".join(str(item.sqltext) for item in table.constraints if isinstance(item, CheckConstraint))
            self.assertIn("phone IS NULL", checks)
            self.assertIn("923[0-9]{9}", checks)

    def test_active_service_names_have_normalized_tenant_unique_index(self):
        index = next(item for item in Service.__table__.indexes if item.unique)
        ddl = str(CreateIndex(index).compile(dialect=self.dialect))
        self.assertIn("business_id, lower(TRIM(BOTH FROM name))", ddl)
        self.assertIn("WHERE active IS true", ddl)

    def test_numeric_and_time_constraints(self):
        for model, expected in [
            (Service, ["duration_minutes > 0", "price >= 0"]),
            (Appointment, ["booked_duration_minutes > 0", "booked_price >= 0", "ends_at > starts_at",
                           "ends_at = starts_at + booked_duration_minutes * INTERVAL '1 minute'"]),
        ]:
            checks = {str(item.sqltext) for item in model.__table__.constraints if isinstance(item, CheckConstraint)}
            for expression in expected:
                self.assertIn(expression, checks)
        for name in ["starts_at", "ends_at"]:
            self.assertTrue(Appointment.__table__.c[name].type.timezone)
        for model in [Business, Customer, Staff, Service]:
            self.assertIn("length(trim(name)) > 0", {
                str(item.sqltext) for item in model.__table__.constraints if isinstance(item, CheckConstraint)})

    def test_price_and_duration_snapshots_do_not_follow_catalog_edits(self):
        start = datetime(2026, 11, 25, 9, tzinfo=timezone.utc)
        service = Service(name="Haircut", price=Decimal("1500.00"), duration_minutes=30)
        appointment = Appointment(service=service, starts_at=start, ends_at=start + timedelta(minutes=30),
                                  booked_price=service.price, booked_duration_minutes=service.duration_minutes)
        service.price = Decimal("2000.00")
        service.duration_minutes = 45
        self.assertEqual(appointment.booked_price, Decimal("1500.00"))
        self.assertEqual(appointment.booked_duration_minutes, 30)
        self.assertEqual(appointment.ends_at, start + timedelta(minutes=30))
        for column in [Service.__table__.c.price, Appointment.__table__.c.booked_price]:
            self.assertTrue(column.type.asdecimal)
            self.assertEqual(column.type.scale, 2)

    def test_status_and_type_accept_known_values_reject_invalid_on_bind(self):
        for column, enum in [(Appointment.__table__.c.status, AppointmentStatus),
                             (Appointment.__table__.c.booking_type, AppointmentType)]:
            processor = column.type.bind_processor(self.dialect)
            for member in enum:
                self.assertEqual(processor(member), member.value)
                self.assertEqual(processor(member.value), member.value)
            with self.assertRaises(LookupError):
                processor("unknown")
            self.assertTrue(column.type.create_constraint)
            self.assertFalse(column.type.native_enum)
            self.assertIn(column.type.name, str(CreateTable(Appointment.__table__).compile(dialect=self.dialect)))

    def test_deletions_never_cascade_into_history(self):
        for mapper in Base.registry.mappers:
            for relation in mapper.relationships:
                self.assertNotIn("delete", relation.cascade)
                self.assertNotIn("delete-orphan", relation.cascade)
                if relation.uselist:
                    self.assertEqual(relation.passive_deletes, "all")
            for constraint in mapper.local_table.foreign_key_constraints:
                self.assertEqual(constraint.ondelete, "RESTRICT")


if __name__ == "__main__":
    unittest.main()
