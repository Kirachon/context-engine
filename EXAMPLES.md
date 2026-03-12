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

**Example 1: Basic Usage (Structured Markdown Output)**

```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "How should we implement user authentication?"
  }
}
```

This returns structured markdown with required sections:
- Objective
- Critical Context
- Assumptions
- Constraints
- Proposed Plan
- Validation Checklist
- Risks and Mitigations
- Open Questions
- Done Definition

**Example 2: JSON Envelope Output**

```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "Show me the database schema"
  }
}
```

Set environment variable:

```bash
CE_ENHANCE_PROMPT_RESPONSE_FORMAT=json
```

Success JSON shape:

```json
{
  "schema_version": "2.0.0",
  "template_version": "2.0.0",
  "enhanced_prompt": "## Objective\\n- ...",
  "source": "ai",
  "reason_code": "ai_enhanced"
}
```

**Example 3: Transient Failure JSON Envelope (No Fallback Template)**

When upstream times out or queue pressure occurs, the tool no longer returns fallback template text.
In JSON mode it returns:

```json
{
  "schema_version": "2.0.0",
  "error_code": "TRANSIENT_UPSTREAM",
  "message": "AI enhancement is temporarily unavailable...",
  "retryable": true
}
```

**Important Notes:**
- `enhance_prompt` only accepts `prompt` in its input arguments.
- Structured markdown is the default text output.
- No deterministic fallback template output path is used for transient failures.

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
   node dist/index.js --workspace /path/to/project --index
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

## Code Review Examples (v1.7.0)

Timeout note: `review_changes` and `review_git_diff` use a default AI timeout of `120000` ms. Set `CE_REVIEW_AI_TIMEOUT_MS` to override globally, or set `llm_timeout_ms` per call.

### Example 1: Review Staged Changes Before Commit

**User Query:**
> "Review my staged changes before I commit"

**What Happens:**
1. Codex calls `review_git_diff` tool
2. Target: "staged" (default)
3. AI analyzes the diff and returns structured findings

**Tool Call:**
```json
{
  "tool": "review_git_diff",
  "arguments": {
    "target": "staged"
  }
}
```

**Expected Response:**
```json
{
  "findings": [
    {
      "category": "security",
      "priority": "P0",
      "confidence": 0.95,
      "file_path": "src/auth/login.ts",
      "line_start": 42,
      "line_end": 45,
      "title": "SQL Injection Vulnerability",
      "description": "Direct string concatenation in SQL query allows SQL injection attacks. User input is not sanitized or parameterized.",
      "suggestion": "Use parameterized queries or an ORM. Replace: `SELECT * FROM users WHERE email = '${email}'` with prepared statements.",
      "code_snippet": "const query = `SELECT * FROM users WHERE email = '${email}'`;"
    },
    {
      "category": "correctness",
      "priority": "P1",
      "confidence": 0.88,
      "file_path": "src/utils/validation.ts",
      "line_start": 15,
      "line_end": 18,
      "title": "Missing Null Check",
      "description": "Function may receive null/undefined input but doesn't validate before accessing properties.",
      "suggestion": "Add null check: `if (!user || !user.email) { throw new Error('Invalid user'); }`",
      "code_snippet": "function validateEmail(user) {\n  return user.email.includes('@');\n}"
    }
  ],
  "overall_correctness": "needs_improvement",
  "overall_confidence_score": 0.91,
  "overall_explanation": "Found 2 significant issues: 1 critical security vulnerability and 1 correctness issue. The SQL injection vulnerability must be fixed before merging.",
  "changes_summary": {
    "files_changed": 2,
    "lines_added": 15,
    "lines_removed": 8
  }
}
```

### Example 2: Security-Focused Review of a Feature Branch

**User Query:**
> "Review my feature branch for security issues compared to main"

**What Happens:**
1. Codex calls `review_git_diff` tool
2. Target: "feature/user-auth", Base: "main"
3. Options: Focus on security category only

**Tool Call:**
```json
{
  "tool": "review_git_diff",
  "arguments": {
    "target": "feature/user-auth",
    "base": "main",
    "options": {
      "categories": "security",
      "confidence_threshold": 0.8,
      "max_findings": 10
    }
  }
}
```

**Expected Response:**
```json
{
  "findings": [
    {
      "category": "security",
      "priority": "P0",
      "confidence": 0.92,
      "file_path": "src/api/auth.ts",
      "line_start": 28,
      "line_end": 32,
      "title": "Hardcoded Secret Key",
      "description": "Secret key is hardcoded in source code. This is a critical security vulnerability as the key will be exposed in version control.",
      "suggestion": "Move secret to environment variable: `const secret = process.env.JWT_SECRET;` and add validation to ensure it's set.",
      "code_snippet": "const secret = 'my-super-secret-key-12345';"
    },
    {
      "category": "security",
      "priority": "P1",
      "confidence": 0.87,
      "file_path": "src/api/auth.ts",
      "line_start": 45,
      "line_end": 48,
      "title": "Weak Password Hashing",
      "description": "Using MD5 for password hashing is cryptographically broken. Attackers can easily crack MD5 hashes.",
      "suggestion": "Use bcrypt or argon2: `const hash = await bcrypt.hash(password, 10);`",
      "code_snippet": "const hash = crypto.createHash('md5').update(password).digest('hex');"
    }
  ],
  "overall_correctness": "needs_major_revision",
  "overall_confidence_score": 0.89,
  "overall_explanation": "Found 2 critical security issues that must be addressed before merging. Both involve authentication security best practices."
}
```

### Example 3: Review Specific Diff with Custom Instructions

**User Query:**
> "Review this diff and check if it follows React best practices"

**What Happens:**
1. User provides diff content
2. Codex calls `review_changes` tool
3. Custom instructions specify React focus

**Tool Call:**
```json
{
  "tool": "review_changes",
  "arguments": {
    "diff": "diff --git a/src/components/UserProfile.tsx b/src/components/UserProfile.tsx\n...",
    "options": {
      "custom_instructions": "Focus on React best practices: hooks usage, component structure, prop types, and performance optimizations",
      "categories": "correctness,performance,maintainability",
      "changed_lines_only": true
    }
  }
}
```

**Expected Response:**
```json
{
  "findings": [
    {
      "category": "performance",
      "priority": "P2",
      "confidence": 0.85,
      "file_path": "src/components/UserProfile.tsx",
      "line_start": 12,
      "line_end": 15,
      "title": "Missing useMemo for Expensive Calculation",
      "description": "Expensive filtering operation runs on every render. This could cause performance issues with large datasets.",
      "suggestion": "Wrap in useMemo: `const filteredUsers = useMemo(() => users.filter(u => u.active), [users]);`",
      "code_snippet": "const filteredUsers = users.filter(u => u.active);"
    },
    {
      "category": "maintainability",
      "priority": "P2",
      "confidence": 0.78,
      "file_path": "src/components/UserProfile.tsx",
      "line_start": 22,
      "line_end": 25,
      "title": "Missing PropTypes or TypeScript Interface",
      "description": "Component props are not typed, making it harder to catch errors and understand the component API.",
      "suggestion": "Add interface: `interface UserProfileProps { userId: string; onUpdate: (user: User) => void; }`",
      "code_snippet": "export function UserProfile({ userId, onUpdate }) {"
    }
  ],
  "overall_correctness": "acceptable",
  "overall_confidence_score": 0.81,
  "overall_explanation": "Code is functional but has 2 areas for improvement related to React best practices: performance optimization and type safety."
}
```

### Example 4: Review Unstaged Changes (Work in Progress)

**User Query:**
> "Review my current work in progress changes"

**What Happens:**
1. Codex calls `review_git_diff` tool
2. Target: "unstaged" (working directory changes)
3. Quick feedback on uncommitted work

**Tool Call:**
```json
{
  "tool": "review_git_diff",
  "arguments": {
    "target": "unstaged",
    "options": {
      "confidence_threshold": 0.7,
      "max_findings": 5
    }
  }
}
```

### Example 5: Review with File Context for Better Understanding

**User Query:**
> "Review this change with full file context"

**What Happens:**
1. User provides diff and full file contents
2. Codex calls `review_changes` tool
3. AI has complete context for better analysis

**Tool Call:**
```json
{
  "tool": "review_changes",
  "arguments": {
    "diff": "diff --git a/src/services/payment.ts b/src/services/payment.ts\n...",
    "file_contexts": {
      "src/services/payment.ts": "// Full file content here...\nexport class PaymentService {\n  ...\n}",
      "src/types/payment.ts": "// Type definitions...\nexport interface Payment {\n  ...\n}"
    },
    "options": {
      "categories": "correctness,security",
      "changed_lines_only": false
    }
  }
}
```

### Example 6: Exclude Generated Files from Review

**User Query:**
> "Review my changes but skip generated files and tests"

**What Happens:**
1. Codex calls `review_git_diff` tool
2. Exclude patterns filter out unwanted files

**Tool Call:**
```json
{
  "tool": "review_git_diff",
  "arguments": {
    "target": "staged",
    "options": {
      "exclude_patterns": "*.test.ts,*.spec.js,dist/*,build/*,*.generated.ts"
    }
  }
}
```

### Example 7: `review_auto` with `review_git_diff_options.llm_timeout_ms`

**Tool Call:**
```json
{
  "tool": "review_auto",
  "arguments": {
    "target": "staged",
    "review_git_diff_options": {
      "llm_timeout_ms": 180000,
      "max_findings": 10
    }
  }
}
```

### Common Code Review Workflows

#### 1. Pre-Commit Review
```
1. Make changes to code
2. git add <files>
3. review_git_diff("staged") → Get AI feedback
4. Fix issues
5. git commit
```

#### 2. Pull Request Review
```
1. review_git_diff("feature-branch", "main") → Review all changes
2. Filter by priority: P0 and P1 only
3. Address critical issues
4. Re-review after fixes
```

#### 3. Security Audit
```
1. review_git_diff("develop", "main", options: { categories: "security" })
2. Review all P0 security findings
3. Create tickets for P1/P2 findings
4. Document P3 findings for future improvement
```

#### 4. Code Quality Check
```
1. review_git_diff("unstaged") → Quick WIP check
2. review_git_diff("staged") → Pre-commit check
3. Fix issues iteratively
4. Commit when overall_correctness is "good" or "acceptable"
```

---

For more examples and use cases, see the [TESTING.md](TESTING.md) guide.
