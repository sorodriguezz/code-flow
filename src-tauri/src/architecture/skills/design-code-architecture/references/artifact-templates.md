# Artifact Templates — design-code-architecture

Skeletons this metaskill creates in the user's `docs/` folder. Extend-only artifacts (TECH-DEBT.md, TESTING.md, OPERATIONS.md) are governed by the section headings named in each phase, not duplicated here. Copy a skeleton verbatim the first time you create its file; on later phases, extend the existing file — add or update your own sections, preserve everyone else's.

## docs/DESIGN-CODE-ARCHITECTURE-PLAN.md (tracker)

Created on first run; never shared with other journeys. The Phase Status table is pre-filled with this journey's real phases.

```markdown
# Design Code Architecture Plan

## Context
Intake answers, date started, project specifics (stack, core differentiator, year-one load, outbound dependencies, system of record, number of owning teams).

## Phase Status
| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1 — Draw the boundaries | clean-architecture | pending | ARCHITECTURE.md | |
| 2 — Model the domain | domain-driven-design | pending | ARCHITECTURE.md | |
| 3 — Size the system | system-design | pending | ARCHITECTURE.md | |
| 4 — Make data decisions | ddia-systems | pending | ARCHITECTURE.md | |
| 5 — Keep modules deep | software-design-philosophy | pending | TECH-DEBT.md | |
| 6 — Design for failure | release-it | pending | RELIABILITY.md | |
| 7 — Prove wiring, lock in habits | pragmatic-programmer | pending | TESTING.md + TECH-DEBT.md | |
| 8 — Cut scope to essential | 37signals-way | pending | ARCHITECTURE.md + TECH-DEBT.md | |
| Optional — Align teams to boundaries | team-topologies | pending | OPERATIONS.md | |
Statuses: pending · in-progress · awaiting-evidence · done · deferred: <reason> · skipped: <reason>

## Key Decisions
| Date | Phase | Decision | Rationale |
|---|---|---|---|

## Next Actions
- [ ] action (owner, due)
```

## docs/ARCHITECTURE.md

Created in Phase 1; extended in Phases 2, 3, 4, and 8. System structure and decisions — includes the domain model and data decisions (no separate DATA.md or DOMAIN.md).

```markdown
# Architecture

## System Context
What the system does, key integrations, load reality (back-of-envelope numbers).

## Layer Map & Dependency Rule
Layers, what depends on what, current violations.
| Violation | Location | Fix | Status |
|---|---|---|---|

## Bounded Contexts & Context Map
Contexts, relationships, anti-corruption layers.

## Domain Glossary (Ubiquitous Language)
| Term | Meaning | Code name |
|---|---|---|

## Data & Storage Decisions
Data models, storage engines, isolation levels, replication, system-of-record vs derived data.

## Decision Log
| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
```

## docs/RELIABILITY.md

Created in Phase 6. Production hardening status.

```markdown
# Reliability

## Integration-Point Audit
| Dependency | Timeout | Circuit breaker | Bulkhead | Retry policy | Status |
|---|---|---|---|---|---|

## Query & Resource Findings
Unbounded result sets, missing LIMITs/pagination, blocked threads.

## Health Checks & Metrics
Deep health checks · RED metrics · symptom-based alerts.

## Deploy vs Release
Feature flags, expand-contract migrations, rollback plan.
```
