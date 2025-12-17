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

