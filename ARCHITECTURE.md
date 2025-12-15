# Architecture Documentation

Detailed architecture documentation for the Context Engine MCP Server.

## Overview

This project implements a **local-first, agent-agnostic context engine** using the Model Context Protocol (MCP) as the interface layer and Auggie SDK as the core engine.

## 5-Layer Architecture

### Layer 1: Core Context Engine (Auggie SDK)

**Location**: External dependency (`@augmentcode/auggie`)

**Purpose**: The brain of the system. Handles all low-level context operations.

**Responsibilities**:
- File ingestion and scanning
- Code chunking with language awareness
- Embedding generation
- Semantic retrieval via vector search
- Metadata management

**What it does NOT do**:
- ❌ Serve HTTP
- ❌ Know about prompts or agents
- ❌ Generate LLM answers

**Interface**: CLI commands (`auggie index`, `auggie search`)

### Layer 2: Context Service Layer

**Location**: `src/mcp/serviceClient.ts`, `src/mcp/services/`

**Purpose**: Adapts raw retrieval into agent-friendly context and provides planning capabilities.

**Responsibilities**:
- Decide how much context to return
- Format snippets for readability
- Deduplicate results by file
- Enforce limits (max files, max tokens)
- Apply heuristics (importance, recency)
- Generate and manage implementation plans (v1.4.0+)
- Track plan execution and versioning (v1.4.0+)

**What it does NOT do**:
- ❌ Index files
- ❌ Store vectors
- ❌ Talk to agents directly

**Key Services**:

#### ContextServiceClient (`serviceClient.ts`)
```typescript
semanticSearch(query, topK): SearchResult[]
getFile(path): string
getContextForPrompt(query, maxFiles): ContextBundle
```

#### PlanningService (`services/planningService.ts`) - v1.4.0+
```typescript
generatePlan(task, options): PlanResult
refinePlan(currentPlan, feedback): PlanResult
analyzeDependencies(steps): DependencyGraph
```

#### PlanPersistenceService (`services/planPersistenceService.ts`) - v1.4.0+
```typescript
savePlan(plan, options): SaveResult
loadPlan(planId): EnhancedPlanOutput
listPlans(filters): PlanMetadata[]
deletePlan(planId): boolean
```

#### ExecutionTrackingService (`services/executionTrackingService.ts`) - v1.4.0+
```typescript
initializeExecution(plan): PlanExecutionState
startStep(planId, stepNumber): StepExecutionState
completeStep(planId, stepNumber, options): StepExecutionState
failStep(planId, stepNumber, options): StepExecutionState
getProgress(planId): ExecutionProgress
```

#### ApprovalWorkflowService (`services/approvalWorkflowService.ts`) - v1.4.0+
```typescript
createPlanApprovalRequest(plan): ApprovalRequest
createStepApprovalRequest(plan, stepNumber): ApprovalRequest
respondToApproval(requestId, action, comments): ApprovalResult
```

#### PlanHistoryService (`services/planHistoryService.ts`) - v1.4.0+
```typescript
recordVersion(plan, changeType, description): void
getHistory(planId, options): PlanHistory
generateDiff(planId, fromVersion, toVersion): PlanDiff
rollback(planId, version, reason): EnhancedPlanOutput
```

**Context Bundle Format**:
```typescript
{
  summary: string;
  files: Array<{
    path: string;
    snippets: Array<{
      text: string;
      lines: string;
    }>;
  }>;
  hints: string[];
}
```

### Layer 3: MCP Interface Layer

**Location**: `src/mcp/server.ts`, `src/mcp/tools/`

**Purpose**: Protocol adapter that lets agents communicate with the service layer.

**Responsibilities**:
- Expose tools via MCP protocol
- Validate input/output
- Map tool calls to service layer methods
- Stay stateless

**What it does NOT do**:
- ❌ Business logic
- ❌ Retrieval logic
- ❌ Formatting decisions

**Tools Exposed** (26 total):

#### Core Context Tools
1. **index_workspace** - Index workspace files
2. **codebase_retrieval** - Semantic search (JSON output)
3. **semantic_search** - Semantic search (markdown output)
4. **get_file** - Retrieve file contents
5. **get_context_for_prompt** - Get context bundle
6. **enhance_prompt** - AI-powered prompt enhancement

#### Index Management Tools
7. **index_status** - View index health
8. **reindex_workspace** - Rebuild index
9. **clear_index** - Clear index state
10. **tool_manifest** - List available tools

#### Planning Tools (v1.4.0+)
11. **create_plan** - Generate implementation plans
12. **refine_plan** - Refine existing plans
13. **visualize_plan** - Generate diagrams

#### Plan Persistence Tools (v1.4.0+)
14. **save_plan** - Save plans to storage
15. **load_plan** - Load saved plans
16. **list_plans** - List plans with filters
17. **delete_plan** - Delete plans

#### Approval Workflow Tools (v1.4.0+)
18. **request_approval** - Create approval requests
19. **respond_approval** - Respond to approvals

#### Execution Tracking Tools (v1.4.0+)
20. **start_step** - Mark step as in-progress
21. **complete_step** - Mark step as completed
22. **fail_step** - Mark step as failed
23. **view_progress** - View execution progress

#### History & Versioning Tools (v1.4.0+)
24. **view_history** - View plan version history
25. **compare_plan_versions** - Compare versions
26. **rollback_plan** - Rollback to previous version

**Example Tool Definitions**:

1. **semantic_search**
   - Input: `{ query: string, top_k?: number }`
   - Output: Formatted search results
   - Use case: Find specific code patterns

2. **get_file**
   - Input: `{ path: string }`
   - Output: Complete file contents
   - Use case: Retrieve full file after search

3. **create_plan** (v1.4.0+)
   - Input: `{ task: string, max_context_files?: number, generate_diagrams?: boolean }`
   - Output: Structured plan with steps, dependencies, diagrams
   - Use case: Generate implementation plans

4. **get_context_for_prompt**
   - Input: `{ query: string, max_files?: number }`
   - Output: Rich context bundle
   - Use case: Primary tool for prompt enhancement

### Layer 4: Agent Clients

**Location**: External (Codex CLI, Cursor, etc.)

**Purpose**: Consume context and generate responses.

**Agent Responsibilities**:
- Decide when to call tools
- Decide how to use context
- Generate final answers

**What the system does NOT do**:
- ❌ Generate answers
- ❌ Make decisions for agents
- ❌ Interpret results

### Layer 5: Storage Backend

**Location**: Auggie SDK internal

**Purpose**: Persist embeddings and metadata.

**Responsibilities**:
- Store vector embeddings
- Store file metadata
- Support fast vector similarity search

**Storage Options** (handled by Auggie):
- Qdrant (recommended)
- SQLite (simple)
- Hybrid (future)

## Data Flow

### Indexing Flow

```
File System
    ↓
Scanner (Layer 1)
    ↓
Chunker (Layer 1)
    ↓
Embedder (Layer 1)
    ↓
Vector Store (Layer 5)
```

### Prompt Enhancement Flow

```
Agent Prompt
    ↓
MCP Tool Call (Layer 3)
    ↓
Context Service (Layer 2)
    ↓
Engine Retrieval (Layer 1)
    ↓
Context Bundle (Layer 2)
    ↓
Agent Final Prompt (Layer 4)
```

## Design Principles

### 1. Separation of Concerns

Each layer has **one responsibility only**. Never collapse layers.

### 2. Clean Contracts

Interfaces between layers are well-defined and stable:
- Layer 1 ↔ Layer 2: CLI commands and JSON output
- Layer 2 ↔ Layer 3: TypeScript interfaces
- Layer 3 ↔ Layer 4: MCP protocol

### 3. Stateless MCP Layer

Layer 3 maintains no state. Each tool call is independent.

### 4. Agent-Agnostic

No LLM-specific logic anywhere in the stack. Works with any MCP client.

### 5. Local-First

- No cloud dependencies
- No exposed network ports
- No data leaves the machine
- All processing happens locally

## Planning Mode Architecture (v1.4.0+)

The planning system adds a complete workflow for AI-assisted software planning and execution tracking.

### Planning Services Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Tools Layer                          │
│  create_plan | refine_plan | visualize_plan                 │
│  save_plan | load_plan | list_plans | delete_plan           │
│  request_approval | respond_approval                        │
│  start_step | complete_step | fail_step | view_progress     │
│  view_history | compare_plan_versions | rollback_plan       │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│                 Planning Services Layer                     │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────┐            │
│  │ PlanningService  │  │ PlanPersistenceService│            │
│  │ - generatePlan() │  │ - savePlan()          │            │
│  │ - refinePlan()   │  │ - loadPlan()          │            │
│  │ - analyzeDeps()  │  │ - listPlans()         │            │
│  └──────────────────┘  └──────────────────────┘            │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────┐            │
│  │ExecutionTracking │  │ApprovalWorkflow      │            │
│  │ - startStep()    │  │ - createRequest()    │            │
│  │ - completeStep() │  │ - respondApproval()  │            │
│  │ - getProgress()  │  │ - trackHistory()     │            │
│  └──────────────────┘  └──────────────────────┘            │
│                                                              │
│  ┌──────────────────┐                                       │
│  │ PlanHistory      │                                       │
│  │ - recordVersion()│                                       │
│  │ - generateDiff() │                                       │
│  │ - rollback()     │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│                  Storage Layer                              │
│  .context-engine/plans/                                     │
│  ├── index.json (plan metadata)                             │
│  ├── plan_abc123.json (plan data)                           │
│  └── history/                                               │
│      └── plan_abc123.json (version history)                 │
└─────────────────────────────────────────────────────────────┘
```

### Planning Workflow

1. **Plan Generation**
   - User provides task description
   - `PlanningService` retrieves relevant codebase context
   - AI generates structured plan with steps, dependencies, diagrams
   - Plan includes DAG analysis (topological sort, critical path, parallel groups)

2. **Plan Persistence**
   - Plans saved to `.context-engine/plans/` directory
   - Metadata tracked in `index.json`
   - Each plan has unique ID and version number

3. **Approval Workflow** (Optional)
   - Create approval requests for full plans or specific steps
   - Track approval status and comments
   - Support approve/reject/request_changes actions

4. **Execution Tracking**
   - Initialize execution state from saved plan
   - Track step states: pending → ready → in_progress → completed/failed/skipped
   - Automatically unlock dependent steps when prerequisites complete
   - Calculate real-time progress percentage

5. **Version History**
   - Every plan modification creates new version
   - Track changes with timestamps and descriptions
   - Generate diffs between versions
   - Support rollback to previous versions

### Key Data Structures

**EnhancedPlanOutput**:
```typescript
{
  id: string;
  version: number;
  goal: string;
  scope: { included, excluded, assumptions, constraints };
  mvp_features: string[];
  nice_to_have_features: string[];
  architecture: { notes, patterns_used, diagrams };
  risks: Array<{ issue, mitigation, likelihood }>;
  milestones: Array<{ name, steps_included, estimated_time }>;
  steps: Array<{
    step_number: number;
    title: string;
    description: string;
    files_to_modify: string[];
    files_to_create: string[];
    depends_on: number[];
    blocks: number[];
    can_parallel_with: number[];
    priority: 'high' | 'medium' | 'low';
    estimated_effort: string;
    acceptance_criteria: string[];
  }>;
  dependency_graph: {
    nodes, edges, critical_path, parallel_groups, execution_order
  };
  testing_strategy: { unit, integration, coverage_target };
  confidence_score: number;
  questions_for_clarification: string[];
}
```

**PlanExecutionState**:
```typescript
{
  plan_id: string;
  status: 'ready' | 'executing' | 'completed' | 'failed';
  steps: Array<{
    step_number: number;
    status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'skipped';
    started_at?: string;
    completed_at?: string;
    duration_ms?: number;
    error?: string;
    notes?: string;
  }>;
  current_steps: number[];
  ready_steps: number[];
  blocked_steps: number[];
}
```

## Extension Points

### Adding New Tools

1. Create tool handler in `src/mcp/tools/`
2. Define input schema
3. Implement handler function
4. Register in `src/mcp/server.ts`

Example:
```typescript
// src/mcp/tools/myTool.ts
export const myTool = {
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: { /* ... */ }
};

export async function handleMyTool(args, serviceClient) {
  // Implementation
}
```

### Adding Service Methods

Add methods to `ContextServiceClient` in `src/mcp/serviceClient.ts`:

```typescript
async myServiceMethod(params): Promise<Result> {
  // Call Auggie CLI or process data
  // Apply Layer 2 logic (formatting, deduplication, etc.)
  return result;
}
```

### Future Enhancements

These can be added **without architectural changes**:

- File watchers (Layer 1)
- Incremental indexing (Layer 1)
- Multi-repo support (Layer 2)
- Role-based filtering (Layer 2)
- Hybrid search (Layer 1)
- Caching (Layer 2)
- Custom context strategies (Layer 2)

## Security Considerations

### Authentication

- Uses Auggie CLI session or environment variables
- No credentials stored in code
- Session file: `~/.augment/session.json`

### Data Privacy

- All data stays local
- No network calls except to Auggie API (for embeddings)
- No telemetry or tracking

### Input Validation

- All tool inputs validated in Layer 3
- Path traversal prevention in file access
- Query sanitization before CLI execution

## Performance Considerations

### Indexing

- Initial indexing can be slow for large codebases
- Incremental updates are faster
- Respects `.gitignore` and `.augmentignore`

### Search

- Vector search is fast (< 100ms typically)
- Results limited by `top_k` parameter
- Deduplication adds minimal overhead

### Context Bundling

- Limited by `max_files` parameter
- Snippet extraction is fast
- Formatting is lightweight

## Monitoring and Debugging

### Logs

- Server logs to stderr
- Codex CLI: Check `~/.codex/config.toml` and use `codex mcp list`
- Auggie CLI logs: Check auggie documentation

### Debugging Tools

- MCP Inspector for interactive testing
- Direct CLI testing with auggie
- TypeScript source maps for stack traces

## Testing Strategy

See [TESTING.md](TESTING.md) for comprehensive testing guide.

## References

- [plan.md](plan.md) - Original architecture plan
- [MCP Documentation](https://modelcontextprotocol.io/)
- [Auggie SDK](https://docs.augmentcode.com/)

