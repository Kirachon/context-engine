# Usage Examples

Real-world examples of using the Context Engine MCP Server with Codex CLI and other MCP clients.

## Basic Usage

### Example 1: Finding Authentication Code

**User Query:**
> "Search for authentication logic in the codebase"

**What Happens:**
1. Codex calls `semantic_search` tool
2. Query: "authentication logic"
3. Returns relevant files with auth code

**Expected Response:**
```
Found 5 results for: "authentication logic"

1. src/auth/login.ts
   Lines: 15-45
   Relevance: 92.3%
   export async function authenticateUser(credentials) {
     const user = await validateCredentials(credentials);
     ...

2. src/middleware/auth.ts
   Lines: 8-30
   Relevance: 88.7%
   export function requireAuth(req, res, next) {
     const token = req.headers.authorization;
     ...
```

### Example 2: Getting Complete File

**User Query:**
> "Show me the package.json file"

**What Happens:**
1. Codex calls `get_file` tool
2. Path: "package.json"
3. Returns complete file contents

**Expected Response:**
```
File: package.json
Lines: 35
Size: 1247 bytes

================================================================================

{
  "name": "my-project",
  "version": "1.0.0",
  ...
}
```

### Example 3: Context for Feature Development

**User Query:**
> "I need to add a new API endpoint for user profiles. Get me relevant context."

**What Happens:**
1. Codex calls `get_context_for_prompt` tool
2. Query: "API endpoint user profiles"
3. Returns comprehensive context bundle

**Expected Response:**
```markdown
# Context for: "API endpoint user profiles"

## Key Insights
- Found code in: .ts, .js
- 5 relevant files found

## Relevant Code

### 1. src/routes/api.ts

Lines: 10-50

```typescript
export const apiRouter = express.Router();

apiRouter.get('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  res.json(user);
});
```

### 2. src/controllers/userController.ts

Lines: 5-30

```typescript
export async function getUserProfile(userId: string) {
  const profile = await db.users.findOne({ id: userId });
  return formatUserProfile(profile);
}
```
```

## Advanced Usage

### Example 4: Code Review Assistance

**User Query:**
> "Review the error handling patterns in this codebase"

**Codex's Workflow:**
1. Calls `semantic_search` with query "error handling try catch"
2. Analyzes results
3. Calls `get_file` for specific files
4. Provides comprehensive review

**User Benefits:**
- Finds all error handling code
- Identifies inconsistencies
- Suggests improvements

### Example 5: Bug Investigation

**User Query:**
> "There's a bug in the payment processing. Help me find the relevant code."

**Codex's Workflow:**
1. Calls `get_context_for_prompt` with "payment processing"
2. Reviews context bundle
3. Asks clarifying questions
4. Calls `get_file` for specific files
5. Helps debug

### Example 6: Learning Codebase

**User Query:**
> "I'm new to this codebase. Explain how the database layer works."

**Codex's Workflow:**
1. Calls `get_context_for_prompt` with "database layer schema models"
2. Analyzes structure
3. Calls `semantic_search` for specific patterns
4. Provides explanation with code examples

## Tool-Specific Examples

### semantic_search Tool

**Use Cases:**
- Finding specific patterns
- Locating similar code
- Discovering implementations

**Example Queries:**
```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "database connection pool",
    "top_k": 5
  }
}
```

```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "error handling middleware",
    "top_k": 10
  }
}
```

### get_file Tool

**Use Cases:**
- Reading configuration files
- Reviewing specific implementations
- Getting complete context

**Example Queries:**
```json
{
  "name": "get_file",
  "arguments": {
    "path": "src/config/database.ts"
  }
}
```

```json
{
  "name": "get_file",
  "arguments": {
    "path": "README.md"
  }
}
```

### get_context_for_prompt Tool

**Use Cases:**
- Feature development
- Understanding subsystems
- Comprehensive code review

**Example Queries:**
```json
{
  "name": "get_context_for_prompt",
  "arguments": {
    "query": "authentication and authorization system",
    "max_files": 5
  }
}
```

```json
{
  "name": "get_context_for_prompt",
  "arguments": {
    "query": "API rate limiting implementation",
    "max_files": 3
  }
}
```

### enhance_prompt Tool

The `enhance_prompt` tool transforms simple prompts into detailed, structured prompts enriched with relevant codebase context. This is particularly useful for RAG (Retrieval-Augmented Generation) pipelines and preparing prompts for external LLMs.

**Use Cases:**
- Preparing prompts for external LLM APIs with codebase context
- RAG pipeline enhancement
- Context enrichment before sending prompts to other services
- Generating detailed prompts from simple user queries

**Example 1: Basic Usage with AI Mode (Default)**

```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "How should we implement user authentication?",
    "max_files": 5,
    "use_ai": true
  }
}
```

This uses AI to intelligently select and summarize the most relevant code context, producing a well-structured prompt suitable for external LLMs.

**Example 2: Template Mode**

```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "Show me the database schema",
    "max_files": 3,
    "use_ai": false
  }
}
```

Template mode returns raw code snippets in a structured format without AI summarization, useful when you want direct access to the code.

**Example 3: Custom max_files Parameter**

```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "Explain the payment processing workflow",
    "max_files": 10
  }
}
```

**Output Format Differences:**
- **AI Mode (`use_ai: true`)**: Returns a narrative-style enhanced prompt with AI-generated summaries and context integration
- **Template Mode (`use_ai: false`)**: Returns structured code snippets with metadata, suitable for programmatic processing

**When to Use Each Mode:**
- Use **AI Mode** when sending prompts to external LLMs or when you need human-readable context
- Use **Template Mode** when building automated pipelines or when you need raw code for further processing

### index_workspace Tool

The `index_workspace` tool indexes workspace files for semantic search. This tool should be called during initial setup or after major codebase changes to ensure search results are accurate and up-to-date.

**Use Cases:**
- First-time setup of the MCP server
- After major codebase changes or file reorganization
- When semantic search returns no results or incomplete results
- Periodic re-indexing for large codebases

**Example 1: Basic Indexing**

```json
{
  "name": "index_workspace",
  "arguments": {
    "force": false
  }
}
```

This performs incremental indexing, only processing files that have changed since the last index.

**Example 2: Force Re-indexing**

```json
{
  "name": "index_workspace",
  "arguments": {
    "force": true
  }
}
```

Force re-indexing rebuilds the entire index from scratch, useful when the index may be corrupted or out of sync.

**Expected Output Format:**

```
Indexing workspace...
Indexed X files in Y seconds
```

**When to Use Force Re-indexing:**
- After major codebase restructuring
- If search results seem incomplete or inaccurate
- When troubleshooting search functionality
- After upgrading the MCP server

## Best Practices

### 1. Be Specific in Queries

❌ **Bad:** "Show me code"
✅ **Good:** "Show me the authentication middleware code"

❌ **Bad:** "Find functions"
✅ **Good:** "Find database query functions in the user service"

### 2. Use the Right Tool

- **semantic_search**: When you know what you're looking for
- **get_file**: When you know the exact file
- **get_context_for_prompt**: When you need comprehensive context

### 3. Iterate

Start broad, then narrow down:
1. `get_context_for_prompt` - Get overview
2. `semantic_search` - Find specific patterns
3. `get_file` - Read complete files

### 4. Adjust Parameters

**For broad exploration:**
```json
{
  "query": "authentication",
  "max_files": 10
}
```

**For focused investigation:**
```json
{
  "query": "JWT token validation in auth middleware",
  "max_files": 3
}
```

## Common Workflows

### Workflow 1: Adding a New Feature

1. **Understand existing patterns**
   - Query: "Get context for similar feature X"
   
2. **Find implementation examples**
   - Query: "Search for pattern Y"
   
3. **Review specific files**
   - Query: "Show me file Z"

### Workflow 2: Debugging

1. **Locate problem area**
   - Query: "Get context for module with bug"
   
2. **Find related code**
   - Query: "Search for error handling in module"
   
3. **Review implementation**
   - Query: "Show me the specific file"

### Workflow 3: Code Review

1. **Get overview**
   - Query: "Get context for the PR changes"
   
2. **Check patterns**
   - Query: "Search for similar implementations"
   
3. **Verify specific files**
   - Query: "Show me each changed file"

## Tips for Better Results

1. **Index your workspace first**
   ```bash
   node dist/index.js --workspace /path/to/project --index
   ```

2. **Use domain-specific terms**
   - Instead of "code that handles users"
   - Use "user authentication service"

3. **Combine tools**
   - Start with `get_context_for_prompt`
   - Follow up with `semantic_search`
   - Finish with `get_file`

4. **Re-index after major changes**
   ```bash
   auggie index /path/to/project
   ```

## Troubleshooting Examples

### No Results Found

**Problem:** Query returns no results

**Solutions:**
- Make query more general
- Check if workspace is indexed
- Verify file types are supported

### Too Many Results

**Problem:** Query returns too many irrelevant results

**Solutions:**
- Make query more specific
- Reduce `top_k` or `max_files`
- Use more technical terms

### Wrong Files Returned

**Problem:** Results don't match expectation

**Solutions:**
- Rephrase query with different terms
- Use `get_context_for_prompt` instead of `semantic_search`
- Check if files are actually indexed

## Planning and Execution Examples (v1.4.0+)

### Example 7: Creating an Implementation Plan

**User Query:**
> "Create a plan to implement user authentication with JWT tokens"

**What Happens:**
1. AI calls `create_plan` tool
2. Analyzes codebase for existing patterns
3. Generates structured plan with steps, dependencies, and diagrams

**Example Tool Call:**
```json
{
  "name": "create_plan",
  "arguments": {
    "task": "Implement user authentication with JWT tokens",
    "max_context_files": 10,
    "generate_diagrams": true,
    "mvp_only": false
  }
}
```

**Expected Response:**
```markdown
# Implementation Plan

**ID:** plan_abc123
**Version:** 1
**Status:** ready
**Confidence:** 85%

## Goal
Implement user authentication with JWT tokens

## MVP Features
- User login endpoint
- JWT token generation
- Token validation middleware
- Secure password hashing

## Steps

### Step 1: Create User Model
**Description:** Define user schema with email and password fields
**Files to Create:** src/models/User.ts
**Estimated Effort:** 2-3 hours

### Step 2: Implement Password Hashing
**Description:** Add bcrypt for secure password storage
**Files to Modify:** src/models/User.ts
**Depends On:** Step 1
**Estimated Effort:** 1-2 hours

### Step 3: Create JWT Service
**Description:** Implement token generation and validation
**Files to Create:** src/services/jwtService.ts
**Depends On:** Step 1
**Estimated Effort:** 3-4 hours

...

## Dependency Graph
[Mermaid diagram showing step dependencies]
```

### Example 8: Saving and Loading Plans

**Saving a Plan:**
```json
{
  "name": "save_plan",
  "arguments": {
    "plan": "<Full Plan JSON from create_plan>",
    "name": "JWT Authentication Implementation",
    "tags": ["authentication", "security", "backend"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "planId": "plan_abc123",
  "message": "Plan saved successfully",
  "metadata": {
    "name": "JWT Authentication Implementation",
    "tags": ["authentication", "security", "backend"],
    "status": "ready",
    "filesAffected": 8
  }
}
```

**Loading a Plan:**
```json
{
  "name": "load_plan",
  "arguments": {
    "plan_id": "plan_abc123"
  }
}
```

**Listing Plans:**
```json
{
  "name": "list_plans",
  "arguments": {
    "status": "ready",
    "tags": ["authentication"],
    "limit": 10
  }
}
```

### Example 9: Executing a Plan Step-by-Step

**Step 1: Start a Step**
```json
{
  "name": "start_step",
  "arguments": {
    "plan_id": "plan_abc123",
    "step_number": 1
  }
}
```

**Response:**
```json
{
  "success": true,
  "step": {
    "step_number": 1,
    "step_id": "step_1",
    "status": "in_progress",
    "started_at": "2025-12-15T10:30:00Z"
  }
}
```

**Step 2: Complete the Step**
```json
{
  "name": "complete_step",
  "arguments": {
    "plan_id": "plan_abc123",
    "step_number": 1,
    "notes": "Created User model with email, password, and timestamps",
    "files_modified": ["src/models/User.ts", "src/models/index.ts"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "step": {
    "step_number": 1,
    "status": "completed",
    "completed_at": "2025-12-15T11:15:00Z",
    "duration_ms": 2700000,
    "notes": "Created User model with email, password, and timestamps"
  },
  "progress": {
    "percentage": 12,
    "completed_steps": 1,
    "total_steps": 8,
    "ready_steps": [2, 3]
  }
}
```

**Step 3: View Progress**
```json
{
  "name": "view_progress",
  "arguments": {
    "plan_id": "plan_abc123"
  }
}
```

**Response:**
```json
{
  "success": true,
  "progress": {
    "percentage": 12,
    "completed_steps": 1,
    "failed_steps": 0,
    "in_progress_steps": 0,
    "ready_steps": [2, 3],
    "blocked_steps": [4, 5, 6, 7, 8],
    "total_steps": 8
  },
  "ready_steps": [2, 3],
  "current_steps": []
}
```

### Example 10: Handling Step Failures

**Mark a Step as Failed:**
```json
{
  "name": "fail_step",
  "arguments": {
    "plan_id": "plan_abc123",
    "step_number": 3,
    "error": "JWT library not compatible with current Node version",
    "retry": false,
    "skip": true,
    "skip_dependents": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "step": {
    "step_number": 3,
    "status": "skipped",
    "error": "JWT library not compatible with current Node version",
    "completed_at": "2025-12-15T12:00:00Z"
  },
  "progress": {
    "percentage": 25,
    "completed_steps": 2,
    "failed_steps": 0,
    "skipped_steps": 1,
    "total_steps": 8
  }
}
```

### Example 11: Approval Workflow

**Request Approval for a Plan:**
```json
{
  "name": "request_approval",
  "arguments": {
    "plan_id": "plan_abc123"
  }
}
```

**Response:**
```json
{
  "success": true,
  "request": {
    "id": "approval_xyz789",
    "plan_id": "plan_abc123",
    "type": "plan",
    "status": "pending",
    "summary": "Approve plan: Implement user authentication with JWT tokens",
    "details": "This plan includes 8 steps affecting 12 files...",
    "affected_files": ["src/models/User.ts", "src/services/jwtService.ts", ...],
    "risks": [
      "Password security (high likelihood)",
      "Token expiration handling (medium likelihood)"
    ]
  }
}
```

**Approve the Plan:**
```json
{
  "name": "respond_approval",
  "arguments": {
    "request_id": "approval_xyz789",
    "action": "approve",
    "comments": "Plan looks good. Proceed with implementation."
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": {
    "request_id": "approval_xyz789",
    "status": "approved",
    "approved_at": "2025-12-15T09:00:00Z",
    "approved_by": "user",
    "comments": "Plan looks good. Proceed with implementation."
  }
}
```

### Example 12: Version History and Rollback

**View Plan History:**
```json
{
  "name": "view_history",
  "arguments": {
    "plan_id": "plan_abc123",
    "limit": 5,
    "include_plans": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "history": {
    "plan_id": "plan_abc123",
    "versions": [
      {
        "version": 3,
        "timestamp": "2025-12-15T14:00:00Z",
        "change_type": "refined",
        "description": "Added error handling steps"
      },
      {
        "version": 2,
        "timestamp": "2025-12-15T12:00:00Z",
        "change_type": "modified",
        "description": "Updated JWT library version"
      },
      {
        "version": 1,
        "timestamp": "2025-12-15T10:00:00Z",
        "change_type": "created",
        "description": "Plan created"
      }
    ]
  }
}
```

**Compare Versions:**
```json
{
  "name": "compare_plan_versions",
  "arguments": {
    "plan_id": "plan_abc123",
    "from_version": 1,
    "to_version": 3
  }
}
```

**Rollback to Previous Version:**
```json
{
  "name": "rollback_plan",
  "arguments": {
    "plan_id": "plan_abc123",
    "version": 2,
    "reason": "Version 3 introduced breaking changes"
  }
}
```

## Planning Workflow Best Practices

### 1. Complete Planning Workflow

```
1. create_plan → Generate initial plan
2. save_plan → Persist the plan
3. request_approval → Get stakeholder approval (optional)
4. respond_approval → Approve/reject
5. start_step → Begin execution
6. complete_step → Mark steps as done
7. view_progress → Monitor progress
8. view_history → Track changes
```

### 2. Handling Plan Refinements

```
1. create_plan → Initial plan
2. refine_plan → Improve based on feedback
3. save_plan → Save refined version
4. compare_plan_versions → Review changes
```

### 3. Error Recovery

```
1. fail_step → Mark step as failed
2. view_progress → Check impact
3. refine_plan → Adjust plan
4. start_step → Retry or continue
```

---

For more examples and use cases, see the [TESTING.md](TESTING.md) guide.

