# Solutions

This directory stores durable solutions to recurring problems.

It is the compounding layer of the documentation system: the first time a problem is solved, document the root cause and fix here so the next occurrence can be handled quickly.

## Structure

Solution docs are organized by `problem_type` category:

```text
docs/solutions/build-errors/
docs/solutions/test-failures/
docs/solutions/runtime-errors/
docs/solutions/performance-issues/
docs/solutions/database-issues/
docs/solutions/security-issues/
docs/solutions/ui-bugs/
docs/solutions/integration-issues/
docs/solutions/logic-errors/
docs/solutions/developer-experience/
docs/solutions/workflow-issues/
docs/solutions/best-practices/
docs/solutions/documentation-gaps/
```

Only create category directories that contain real docs.

## Frontmatter

Each solution should include searchable YAML frontmatter:

```yaml
---
title: Clear problem title
date: YYYY-MM-DD
category: integration-issues
module: Obsidian Runtime Host
problem_type: integration_issue
component: tooling
symptoms:
  - Observable symptom
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [obsidian, svg, sidecar-sync]
---
```

Use the schema from the CE compound workflow:

- bug categories include `symptoms`, `root_cause`, and `resolution_type`
- knowledge categories include `applies_when` when useful
- tags should be lowercase and hyphen-separated

## Current Solutions

- [Stabilize Obsidian Ink Rendering and Vault Opening](./integration-issues/obsidian-ink-rendering-stability-2026-06-28.md)

## When to Add a Solution

Add or update a solution when:

- a bug required non-trivial root-cause analysis
- a fix crosses package, host, or adapter boundaries
- a user-visible issue can recur in Web, Obsidian, or native hosts
- a workflow or packaging rule should guide future agents
- a plan or review reveals a reusable implementation pattern

If an existing solution covers the same problem, update that document instead of creating a duplicate.
