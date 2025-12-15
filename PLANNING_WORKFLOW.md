# Planning Workflow Guide

Complete guide to using the Context Engine's planning and execution features (v1.4.0+).

## Overview

The Context Engine provides a comprehensive planning system that helps you:
- Generate AI-powered implementation plans
- Track execution progress step-by-step
- Manage plan versions and history
- Request and respond to approvals
- Visualize dependencies and workflows

## Quick Start

### 1. Create a Plan

```javascript
create_plan({
  task: "Implement user authentication with JWT tokens",
  max_context_files: 10,
  generate_diagrams: true,
  mvp_only: false
})
```

**Output**: Structured plan with steps, dependencies, diagrams, and risk analysis.

### 2. Save the Plan

```javascript
save_plan({
  plan: "<Full Plan JSON from create_plan>",
  name: "JWT Authentication Implementation",
  tags: ["authentication", "security", "backend"]
})
```

**Output**: Plan ID and metadata for future reference.

### 3. Execute Steps

```javascript
// Start step 1
start_step({ plan_id: "plan_abc123", step_number: 1 })

// Do the work...

// Complete step 1
complete_step({ 
  plan_id: "plan_abc123", 
  step_number: 1,
  notes: "Created User model with bcrypt password hashing",
  files_modified: ["src/models/User.ts"]
})

// Check progress
view_progress({ plan_id: "plan_abc123" })
```

## Complete Workflow

### Phase 1: Planning

#### Step 1.1: Generate Initial Plan
```javascript
create_plan({
  task: "Your implementation task",
  max_context_files: 10,      // How many files to analyze
  context_token_budget: 12000, // Token budget for context
  generate_diagrams: true,     // Generate Mermaid diagrams
  mvp_only: false              // Include nice-to-have features
})
```

#### Step 1.2: Refine the Plan (Optional)
```javascript
refine_plan({
  current_plan: "<Plan JSON>",
  feedback: "Add error handling steps and logging",
  clarifications: {
    "Which database?": "PostgreSQL",
    "Authentication method?": "JWT with refresh tokens"
  },
  focus_steps: [3, 4, 5]  // Refine specific steps
})
```

#### Step 1.3: Visualize the Plan
```javascript
visualize_plan({
  plan: "<Plan JSON>",
  diagram_type: "dependencies"  // or "architecture" or "gantt"
})
```

#### Step 1.4: Save the Plan
```javascript
save_plan({
  plan: "<Plan JSON>",
  name: "Custom Plan Name",
  tags: ["feature", "backend", "auth"],
  overwrite: false
})
```

### Phase 2: Approval (Optional)

#### Step 2.1: Request Approval
```javascript
// Approve entire plan
request_approval({
  plan_id: "plan_abc123"
})

// Or approve specific steps
request_approval({
  plan_id: "plan_abc123",
  step_numbers: [1, 2, 3]
})
```

#### Step 2.2: Respond to Approval
```javascript
respond_approval({
  request_id: "approval_xyz789",
  action: "approve",  // or "reject" or "request_changes"
  comments: "Looks good, proceed with implementation"
})
```

### Phase 3: Execution

#### Step 3.1: Load the Plan
```javascript
load_plan({
  plan_id: "plan_abc123"
})
```

#### Step 3.2: Execute Steps
```javascript
// Start a step
start_step({
  plan_id: "plan_abc123",
  step_number: 1
})

// Complete the step
complete_step({
  plan_id: "plan_abc123",
  step_number: 1,
  notes: "Implementation notes",
  files_modified: ["file1.ts", "file2.ts"]
})

// Or mark as failed
fail_step({
  plan_id: "plan_abc123",
  step_number: 2,
  error: "Dependency conflict with library X",
  retry: true,              // Retry the step
  skip: false,              // Skip the step
  skip_dependents: false    // Skip dependent steps
})
```

#### Step 3.3: Monitor Progress
```javascript
view_progress({
  plan_id: "plan_abc123"
})
```

**Output**:
```json
{
  "percentage": 37,
  "completed_steps": 3,
  "failed_steps": 0,
  "in_progress_steps": 1,
  "ready_steps": [5, 6],
  "blocked_steps": [7, 8],
  "total_steps": 8
}
```

### Phase 4: Version Management

#### Step 4.1: View History
```javascript
view_history({
  plan_id: "plan_abc123",
  limit: 10,
  include_plans: false
})
```

#### Step 4.2: Compare Versions
```javascript
compare_plan_versions({
  plan_id: "plan_abc123",
  from_version: 1,
  to_version: 3
})
```

**Output**: Detailed diff showing:
- Steps added/removed/modified
- Files changed
- Scope changes
- Risk changes

#### Step 4.3: Rollback (if needed)
```javascript
rollback_plan({
  plan_id: "plan_abc123",
  version: 2,
  reason: "Version 3 introduced breaking changes"
})
```

## Plan Management

### List All Plans
```javascript
// List all plans
list_plans({})

// Filter by status
list_plans({
  status: "ready",  // or "approved", "executing", "completed", "failed"
  limit: 20
})

// Filter by tags
list_plans({
  tags: ["authentication", "backend"],
  limit: 10
})
```

### Delete a Plan
```javascript
delete_plan({
  plan_id: "plan_abc123"
})
```

## Understanding Plan Structure

### EnhancedPlanOutput

A complete plan includes:

```typescript
{
  // Metadata
  id: "plan_abc123",
  version: 1,
  created_at: "2025-12-15T10:00:00Z",
  updated_at: "2025-12-15T10:00:00Z",

  // Core Plan
  goal: "Implement user authentication with JWT tokens",
  scope: {
    included: ["User login", "Token generation", "Token validation"],
    excluded: ["OAuth integration", "2FA"],
    assumptions: ["PostgreSQL database", "Express.js framework"],
    constraints: ["Must complete in 2 weeks", "No external dependencies"]
  },

  // Features
  mvp_features: ["Login endpoint", "JWT generation", "Auth middleware"],
  nice_to_have_features: ["Remember me", "Session management"],

  // Architecture
  architecture: {
    notes: "RESTful API with JWT-based authentication",
    patterns_used: ["Repository pattern", "Middleware pattern"],
    diagrams: [
      {
        type: "architecture",
        title: "Authentication Flow",
        mermaid: "graph TD\n  A[Client] --> B[Login Endpoint]..."
      }
    ]
  },

  // Risks
  risks: [
    {
      issue: "Password security vulnerabilities",
      mitigation: "Use bcrypt with salt rounds >= 10",
      likelihood: "high"
    }
  ],

  // Milestones
  milestones: [
    {
      name: "Core Authentication",
      steps_included: [1, 2, 3],
      estimated_time: "3 days"
    }
  ],

  // Steps
  steps: [
    {
      step_number: 1,
      id: "step_1",
      title: "Create User Model",
      description: "Define user schema with email and password fields",
      files_to_modify: [],
      files_to_create: ["src/models/User.ts"],
      files_to_delete: [],
      depends_on: [],
      blocks: [2, 3],
      can_parallel_with: [],
      priority: "high",
      estimated_effort: "2-3 hours",
      acceptance_criteria: [
        "User model has email and password fields",
        "Password is hashed with bcrypt",
        "Email validation is implemented"
      ]
    }
  ],

  // Dependency Graph
  dependency_graph: {
    nodes: [{ id: "step_1", step_number: 1 }],
    edges: [{ from: "step_1", to: "step_2", type: "blocks" }],
    critical_path: [1, 2, 3, 5, 7],
    parallel_groups: [[4, 6]],
    execution_order: [1, 2, 3, 4, 5, 6, 7, 8]
  },

  // Testing Strategy
  testing_strategy: {
    unit: "Jest for model and service tests",
    integration: "Supertest for API endpoint tests",
    coverage_target: "80%"
  },

  // Confidence & Questions
  confidence_score: 0.85,
  questions_for_clarification: [
    "Should we support social login in the future?",
    "What is the token expiration time?"
  ],

  // Context
  context_files: ["src/models/", "src/routes/api.ts"],
  codebase_insights: [
    "Existing models use TypeORM",
    "API routes follow RESTful conventions"
  ]
}
```

## Execution States

### Step States

Steps progress through these states:

1. **pending** - Not yet ready (waiting for dependencies)
2. **ready** - Dependencies met, can be started
3. **in_progress** - Currently being worked on
4. **completed** - Successfully finished
5. **failed** - Failed with error
6. **skipped** - Manually skipped
7. **blocked** - Blocked by failed dependencies

### Plan States

Plans have these overall states:

1. **ready** - Plan created, ready to execute
2. **approved** - Plan approved by stakeholders
3. **executing** - Execution in progress
4. **completed** - All steps completed
5. **failed** - Execution failed

## Best Practices

### 1. Planning Phase

- **Be specific** in your task description
- **Include context** about existing codebase patterns
- **Set realistic scope** - use `mvp_only: true` for initial implementation
- **Review and refine** - use `refine_plan` to improve the plan

### 2. Execution Phase

- **Follow dependencies** - start steps only when they're "ready"
- **Document progress** - add notes when completing steps
- **Track file changes** - list files_modified for better history
- **Handle failures gracefully** - use retry or skip options appropriately

### 3. Version Management

- **Review history regularly** - track how the plan evolved
- **Compare before rollback** - use `compare_plan_versions` first
- **Document rollback reasons** - always provide a reason

### 4. Approval Workflow

- **Request approval early** - get stakeholder buy-in before execution
- **Be specific in comments** - provide clear feedback
- **Approve incrementally** - approve step groups for large plans

## Common Patterns

### Pattern 1: Iterative Refinement

```
1. create_plan → Initial plan
2. refine_plan → Add error handling
3. refine_plan → Optimize for performance
4. save_plan → Save final version
```

### Pattern 2: Phased Execution

```
1. request_approval (steps 1-3) → Approve Phase 1
2. Execute steps 1-3
3. request_approval (steps 4-6) → Approve Phase 2
4. Execute steps 4-6
```

### Pattern 3: Error Recovery

```
1. fail_step (step 5, retry: false, skip: true)
2. refine_plan → Adjust remaining steps
3. Continue execution from step 6
```

## Troubleshooting

### Issue: Steps not becoming "ready"

**Cause**: Dependencies not completed
**Solution**: Check `view_progress` to see blocked_steps and their dependencies

### Issue: Plan refinement not working

**Cause**: Invalid plan JSON or missing required fields
**Solution**: Ensure you're passing the complete plan JSON from `create_plan`

### Issue: Cannot rollback

**Cause**: Version doesn't exist or plan has been deleted
**Solution**: Use `view_history` to check available versions

### Issue: Approval request not found

**Cause**: Request ID is incorrect or approval already processed
**Solution**: List pending approvals or check approval history

## Advanced Features

### Parallel Execution

The system identifies steps that can run in parallel:

```javascript
view_progress({ plan_id: "plan_abc123" })
// Returns: ready_steps: [4, 5, 6]
// Steps 4, 5, 6 can be executed in parallel
```

### Critical Path Analysis

The dependency graph includes the critical path:

```javascript
visualize_plan({
  plan: "<Plan JSON>",
  diagram_type: "dependencies"
})
// Highlights critical path in the diagram
```

### Custom Diagrams

Generate different diagram types:

```javascript
// Dependency graph
visualize_plan({ plan: "<Plan JSON>", diagram_type: "dependencies" })

// Architecture diagram
visualize_plan({ plan: "<Plan JSON>", diagram_type: "architecture" })

// Gantt chart
visualize_plan({ plan: "<Plan JSON>", diagram_type: "gantt" })
```

## Integration with Other Tools

### With Codex CLI

```
User: "Create a plan to implement user authentication"
Codex: [Calls create_plan tool]
User: "Save this plan with tag 'auth'"
Codex: [Calls save_plan tool]
User: "Start executing step 1"
Codex: [Calls start_step tool]
```

### With Claude Desktop

Same workflow - all tools are available through the MCP interface.

### With Cursor IDE

Use the planning tools directly in your IDE for seamless development.

## See Also

- [EXAMPLES.md](EXAMPLES.md) - Complete examples with expected outputs
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical architecture details
- [README.md](README.md) - General documentation
- [CHANGELOG.md](CHANGELOG.md) - Version history and changes


