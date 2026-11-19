# SalonPulse architecture

SalonPulse is a mobile-first, multi-tenant SaaS for barbershops and beauty salons
in Lahore, Pakistan.

```text
React + TypeScript + Tailwind CSS (browser; Vite tooling)
                         |
                     HTTP / JSON
                         v
                    FastAPI (Python)
                         |
                  future SQL access
                         v
                     PostgreSQL
```

The frontend owns presentation and will call the backend for application data.
FastAPI will own validation, authorization, and database access. Browsers will
never connect directly to PostgreSQL or receive database credentials.

## Planned tenant isolation

Start with a shared PostgreSQL database and shared schema. Each salon or
barbershop organization will be a tenant; tenant-owned tables will include a
non-null `tenant_id`. Future branches can belong to the same tenant.

Once authentication is implemented, the API will resolve tenant context from
the authenticated user's verified tenant membership. A client-supplied tenant
identifier alone must never grant access. Queries and writes must always be
scoped to that verified tenant. Composite constraints and foreign keys should
prevent references between tenants; unique business identifiers should be
scoped by tenant where appropriate.

PostgreSQL row-level security is planned as an additional isolation layer.
Tenant context must be transaction-local so pooled connections cannot carry it
between requests. Future integration tests must verify cross-tenant access is
rejected, including background jobs and administrative paths.

## Current scope

This repository contains only a static React starter and `GET /health`, which
returns `{"status":"ok"}`. PostgreSQL is planned, not connected. Authentication,
tenant enforcement, database models, migrations, business features, and AI are
not implemented. The frontend currently makes no API requests, so CORS and
frontend API configuration are not needed yet.
