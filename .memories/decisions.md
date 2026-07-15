# Project Decisions

This file stores important architectural and technical decisions made during development. The AI assistant will reference these when suggesting implementations.

## Architecture Decisions

<!-- Add key architecture decisions here. Format:
### [Date] Decision Title
**Context:** Why this decision was needed
**Decision:** What was decided
**Rationale:** Why this choice was made
**Alternatives Considered:** What other options were rejected
-->

### [2024-12-17] Memory System Implementation
**Context:** Need for persistent cross-session memory in Context Engine
**Decision:** Use hybrid approach with markdown files in `.memories/` directory indexed by Auggie
**Rationale:** Zero new infrastructure, leverages existing semantic search, human-readable and git-friendly
**Alternatives Considered:** Wait for SDK updates (unknown timeline), build custom memory system (too complex)

<!--
Quarantine note: "indexed by Auggie" is Auggie-era and stale; the project has since
migrated to a local-native retrieval runtime (see ARCHITECTURE.md). The underlying
decision to store memories as markdown files under .memories/ is unaffected by this
note. Preserved verbatim above (non-destructive); marked archive below so this entry is
hard-excluded from default memory retrieval and handoff ranking (see
src/mcp/memoryQuarantine.ts) while remaining available via explicit archive access
(list_memories, or includeArchive: true). See .memories/README.md.
-->
- [meta] priority: archive
- [meta] subtype: quarantine
- [meta] tags: auggie-era, stale
- [meta] created_at: 2024-12-17T00:00:00.000Z
- [meta] updated_at: 2026-07-14T11:04:00.000Z

## Technology Choices

<!-- Add technology selection decisions here. Examples:
### [Date] Authentication Method
- Chose JWT tokens over sessions
- Tokens expire after 24 hours
- Refresh tokens stored in httpOnly cookies
-->

## API Design Decisions

<!-- Add API design decisions here. Examples:
### [Date] API Versioning Strategy
- Using URL path versioning (/v1/, /v2/)
- Breaking changes require new major version
- Deprecated endpoints supported for 6 months
-->

## Database Schema Decisions

<!-- Add database/schema decisions here. Examples:
### [Date] User Data Structure
- Store user preferences as JSON blob
- Separate table for audit logs
- Use UUIDs for primary keys
-->

