# Steelkeep

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owner of self-hosted applications, initially the product owner himself; later small teams.

## Product Purpose

Back up multiple database engines, understand real operations, and safely recover data. Required engine scope: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server, each with an explicit safe recovery profile. Successful restore and data verification are required evidence, not a green backup status.

## Operating Context

Self-hosted UI, OpenAPI and native MCP share operations and history. AI agents are first-class clients: named identities, scoped expiring revocable tokens, safe configuration and operations, audit; no model subscription required. Initial fixtures are isolated synthetic databases and local S3-compatible storage. No production/deploy/publication/spend permission.

## Capabilities and Constraints

TanStack Start + Elysia are user choices. TanStack DB is explicitly desired. Durable jobs/schedules, safe secrets, separate empty restore target, cancellation and meaningful logs are mandatory. Full objective remains active. Runtime review is deferred by the user's current instruction; no browser/services/tests/build until requested.

## Brand Commitments

Working name Steelkeep. Main functional AND visual reference is Databasement; the owner explicitly wants close reference fidelity, with some own notes, and permits licensed code adaptation. Salt.md is the second reference. Reject the previous muddy green palette. Keep branding subordinate to a rich, coherent operational product.

## Evidence on Hand

Research and kickoff: /Users/dobrota/dev/reports/stillkeep-research-20261031. Databasement source: /tmp/stillkeep-research/databasement-ux. Salt source: /Users/dobrota/work/sekta/repos/salt-review-20261013. Current code is incomplete; earlier nine passing foundation tests do not prove product acceptance.

## Product Principles

Real operations over mock dashboards. Safe recovery by default. Shared UI/API/MCP semantics. Readable dense operational screens. Complete slices rather than a premature platform.
