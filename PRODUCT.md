# Steelkeep

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owner of self-hosted applications, initially the product owner himself; later small teams.

## Product Purpose

Back up multiple database engines, understand real operations, and safely recover data. Required engine scope: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server, each with an explicit safe recovery profile. Successful restore and data verification are required evidence, not a green backup status.

## Operating Context

Self-hosted UI, OpenAPI and native MCP share operations and history. AI agents are first-class clients: named identities, scoped expiring revocable tokens, safe configuration and operations, audit; no model subscription required. Initial fixtures are isolated synthetic databases and local S3-compatible storage. Execution, real data connections and publication require an authorized target and scope.

## Capabilities and Constraints

TanStack Start + Elysia are user choices. TanStack DB is explicitly desired. Durable jobs/schedules, safe secrets, separate empty restore target, cancellation and meaningful logs are mandatory. The owner expanded the active goal to a complete platform; GOAL.md is the current scope. Use isolated synthetic checks and source mounts where authorized; avoid Docker builds for routine code or UI changes. Follow AGENTS.md for the active execution constraints.

## Brand Commitments

Working name Steelkeep. Main functional AND visual reference is Databasement; the owner explicitly wants close reference fidelity, with some own notes, and permits licensed code adaptation. Salt.md is the second reference. Reject the previous muddy green palette. Keep branding subordinate to a rich, coherent operational product.

## Evidence on Hand

Current qualification is recorded in docs/server-runtime.md and docs/acceptance.md. Reference provenance is in THIRD-PARTY-NOTICES.md. Earlier foundation tests do not establish complete product acceptance.

## Product Principles

Real operations over mock dashboards. Safe recovery by default. Shared UI/API/MCP semantics. Readable dense operational screens. Deliver the agreed platform through complete, verified slices.
