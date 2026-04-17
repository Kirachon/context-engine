# Documentation Map

This page is the entry point for the active documentation set. Start here when you need to find the current setup guides, architecture docs, runbooks, contracts, and rollout material. Historical plans, superseded guides, and old reports live in [archive/INDEX.md](archive/INDEX.md).

## Start here

- [../README.md](../README.md) — project overview, quick start, and primary usage path
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — system architecture and layer model
- [../CHANGELOG.md](../CHANGELOG.md) — release history

## Docs tree

```text
docs/
├─ README.md                              # this map
├─ MCP_CLIENT_SETUP.md                    # client-specific setup how-to
├─ WINDOWS_DEPLOYMENT_GUIDE.md            # end-to-end Windows setup
├─ WINDOWS_SERVER_MANAGEMENT.md           # Windows operations and maintenance
├─ MEMORY_OPERATIONS_RUNBOOK.md           # memory governance and cleanup runbook
├─ ROLLOUT_RUNBOOK.md                     # rollout and release operations
├─ RUNBOOK_CONTEXT_ENGINE_PROCESS_HEALTH.md # process-health runbook
├─ REVIEW_CONTRACTS.md                    # review workflow contracts and expectations
├─ CONTRACT_FREEZE.md                     # frozen contract reference
├─ FLAG_REGISTRY.md                       # feature-flag inventory
├─ BENCHMARKING*.md                       # performance and gate references
├─ RETRIEVAL_*.md / LEGACY_PROVIDER_*.md  # migration and rollout tracking
├─ templates/                             # rollout and governance templates
├─ examples/                              # sample artifacts
├─ plan-execution/                        # execution packs and supporting plans
├─ rollout-evidence/                      # dated rollout receipts
└─ archive/                               # superseded and historical docs
```

## What lives where

### Architecture
- [../ARCHITECTURE.md](../ARCHITECTURE.md)
- [CONTRACT_FREEZE.md](CONTRACT_FREEZE.md)
- [REVIEW_CONTRACTS.md](REVIEW_CONTRACTS.md)
- [VERSIONING_CONTRACT_POLICY.md](VERSIONING_CONTRACT_POLICY.md)

### How-tos
- [MCP_CLIENT_SETUP.md](MCP_CLIENT_SETUP.md)
- [WINDOWS_DEPLOYMENT_GUIDE.md](WINDOWS_DEPLOYMENT_GUIDE.md)
- [WINDOWS_SERVER_MANAGEMENT.md](WINDOWS_SERVER_MANAGEMENT.md)

### Runbooks and operations
- [MEMORY_OPERATIONS_RUNBOOK.md](MEMORY_OPERATIONS_RUNBOOK.md)
- [ROLLOUT_RUNBOOK.md](ROLLOUT_RUNBOOK.md)
- [RUNBOOK_CONTEXT_ENGINE_PROCESS_HEALTH.md](RUNBOOK_CONTEXT_ENGINE_PROCESS_HEALTH.md)
- [BENCHMARKING.md](BENCHMARKING.md)
- [BENCHMARKING_GATES.md](BENCHMARKING_GATES.md)

### API / contracts / reference
- [REVIEW_CONTRACTS.md](REVIEW_CONTRACTS.md)
- [CONTRACT_FREEZE.md](CONTRACT_FREEZE.md)
- [FLAG_REGISTRY.md](FLAG_REGISTRY.md)
- [PHASE2_TOOL_INVENTORY.md](PHASE2_TOOL_INVENTORY.md)
- [R9_RECOMMENDATION_IMPORT_SCHEMA.md](R9_RECOMMENDATION_IMPORT_SCHEMA.md)

### Migrations and rollout tracking
- [LEGACY_PROVIDER_ADOPTION_AND_REMOVAL_TRACKER.md](LEGACY_PROVIDER_ADOPTION_AND_REMOVAL_TRACKER.md)
- [RETRIEVAL_MIGRATION_MONITORING_CHECKLIST.md](RETRIEVAL_MIGRATION_MONITORING_CHECKLIST.md)
- [RETRIEVAL_SPEED_QUALITY_ROLLOUT.md](RETRIEVAL_SPEED_QUALITY_ROLLOUT.md)
- [ROLLOUT_EVIDENCE_LOG.md](ROLLOUT_EVIDENCE_LOG.md)
- [rollout-evidence/](rollout-evidence)
- [plan-execution/](plan-execution)

### Templates and examples
- [templates/](templates)
- [examples/](examples)

### Archive
- [archive/INDEX.md](archive/INDEX.md)
- [deprecation-policy.md](deprecation-policy.md)

## Notes

- Prefer the docs linked above before using one-off plan files at the docs root; many `*-plan.md` files are working artifacts rather than canonical references.
- If you are looking for retired or superseded material, use [archive/INDEX.md](archive/INDEX.md), which records why a document was archived and whether a successor exists.
