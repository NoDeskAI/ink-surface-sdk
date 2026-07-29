---
title: Critical Reliability Patterns
date: 2026-07-29
category: best-practices
module: InkLoop Platform
problem_type: reliability_pattern
component: architecture
applies_when:
  - implementing durable ingestion, synchronization, meeting capture, or postprocessing
  - changing occurrence identity, retries, cursors, acknowledgements, or deletion
severity: critical
tags: [durability, idempotency, retries, privacy, occurrence-identity]
---

# Critical Reliability Patterns

Read these rules before changing a durable InkLoop workflow. They are merge
gates, not optional conventions.

## Persist before advancing

Write and verify authoritative data before returning an ACK, advancing a
cursor, publishing a projection, or updating an in-memory success state. A
retry after a crash must either replay idempotently or resume from the last
durable boundary.

## Keep one canonical occurrence identity

Centralize the mapping from provider rooms, recurring calendar events, local
sessions, and InkLoop meeting documents to one occurrence identifier. Never
derive a second identity in a downstream worker. Ambiguous recurring-room
matches must fail closed rather than select an arbitrary meeting.

## Bound every background failure domain

Every provider/model call needs an abortable deadline, finite retry budget,
terminal failure state, bounded queue, and cleanup path. A provisional
projection must never block authoritative fact upload or formal convergence.

## Make replay and ordering explicit

Serialize stateful work at its real scope, such as session plus audio track.
Commit mutations before marking events applied. Duplicate, out-of-order,
restart, and equal-revision conflicts require deterministic tests.

## Delete fail closed

Persist an idempotent deletion tombstone before removing any evidence. Once
deletion is requested, all reads must remain unavailable even when a later
media, runtime, provider, or local-device deletion step fails. Retrying the
same command resumes the saga without resurrecting data.

## Related solutions

- [Runtime Sync Canonical Path](../integration-issues/runtime-sync-canonical-path-2026-07-02.md)
- [Source-file-centered V1 Product Boundary](../best-practices/source-file-centered-v1-product-boundary-2026-07-02.md)
- [Project Docs Boundary and Feishu Projection](../documentation-gaps/project-docs-boundary-and-feishu-projection-2026-07-02.md)
