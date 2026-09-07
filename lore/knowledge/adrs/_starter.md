---
title: "ADR-0000: Primary datastore for the platform"
description: "All transactional data lives in PostgreSQL, one database per environment, because the data is relational and the team already operates Postgres; a document store was considered and rejected for now."
tags: [adr, database, postgresql, example]
status: accepted
date: 2026-05-16
deciders: [platform-team]
confidence: high
---

# ADR-0000: Primary datastore for the platform

> Replace this placeholder with real decisions as you make them, or as `/lore:adr discover`
> unearths the ones already baked into the code. Keep the section order: it is what `/lore:adr`
> writes and what reviewers look for. Real records start at `0001-`; this example uses `0000`
> so it never collides with one. The `description` is the decision in one sentence, because that
> line is what listings and searches show.

## Status

Accepted 2026-05-16. First code depending on it: the `orders` schema migration.

## Context

The platform needs a system of record for orders, payments and inventory levels. The data is
relational: an order references a customer, has many lines, and each line references a product
whose stock level is adjusted in the same transaction. Reporting joins across all three. The team
already runs PostgreSQL for two other services and has no operational experience with document
stores. Expected volume is low thousands of orders per day.

## Considered options

- **PostgreSQL** — relational fit, transactions across aggregates, existing operational skill.
- **A document store (MongoDB)** — schema flexibility while the order model is still changing.
- **SQLite per service** — zero operations, but no concurrent writers and no shared reporting.

## Decision

The platform stores all transactional data in PostgreSQL, one database per environment, because
the data is relational, the invariants need multi-row transactions, and the team already operates
Postgres in production.

Schema changes ship as migrations in the owning service's repository. No service reads another
service's tables directly.

## Consequences

- Cross-aggregate invariants (stock decremented when an order is placed) are enforced in one
  transaction instead of with compensating actions.
- Schema changes need a migration and a review, so early model churn costs more than it would in
  a schemaless store.
- Reporting can join across orders, payments and inventory without an export step.
- Every environment needs a managed Postgres instance, which is a real cost line from day one.

## Assumptions and invalidation triggers

- *Assumes volume stays within a single primary's write capacity.* Trigger: sustained write
  latency above the SLO or a need to shard ⇒ revisit with a new record.
- *Assumes no service needs a schemaless document model.* Trigger: a bounded context whose
  documents change shape per release ⇒ record a per-context exception rather than reopening this one.

## See also

- [[domain/_starter]] — the bounded context whose invariants drove the choice.
