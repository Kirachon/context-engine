# Enterprise Review System - Quick Reference Card

**Version**: v1.8.0  
**Last Updated**: December 26, 2025

---

## 🚀 Quick Start

### Run Review Locally
```bash
# Review current changes
npm run build
npx tsx scripts/ci/review-diff.ts

# Review specific commit range
BASE_SHA=abc123 HEAD_SHA=def456 npx tsx scripts/ci/review-diff.ts
```

### Environment Variables
```bash
CE_REVIEW_INCLUDE_SARIF=true          # Generate SARIF output
CE_REVIEW_INCLUDE_MARKDOWN=true       # Generate Markdown output
CE_REVIEW_FAIL_ON_SEVERITY=CRITICAL   # CI gate threshold
CE_REVIEW_INVARIANTS_PATH=.review-invariants.yml  # Custom invariants
```

---

## 📋 Review Flow

```
PR Diff → Parse → Classify → Preflight → Invariants → Noise Gate
                                                          ↓
                                                    Skip LLM? ←─┐
                                                          ↓     │
                                                    Context Plan │
                                                          ↓     │
                                                    Structural   │
                                                          ↓     │
                                                    Detailed?    │
                                                          ↓     │
                                                    Merge ←─────┘
                                                          ↓
                                                    Filter → Output
```

---

## 🎯 Risk Scoring (1-5 Scale)

| Score | Description | LLM Review? |
|-------|-------------|-------------|
| **1** | Trivial (docs, comments) | ❌ Skipped |
| **2** | Low risk (tests, small changes) | ❌ Skipped (if tests touched) |
| **3** | Medium risk (feature, refactor) | ✅ Structural only |
| **4** | High risk (API changes, hotspots) | ✅ Structural + Detailed |
| **5** | Critical (security, config, no tests) | ✅ Structural + Detailed |

**Formula**:
```typescript
risk = 1 + 
  (filesChanged > 10 ? 1 : 0) +
  (hotzonesHit * 0.5) +
  (publicApiChanged ? 1.5 : 0) +
  (configChanged ? 0.5 : 0) +
  (testsNotTouched ? 1 : 0)
```

---

## 🛡️ Invariants Configuration

### File: `.review-invariants.yml`

```yaml
security:
  # Block dangerous patterns
  - id: SEC001
    rule: "No eval() usage in source code"
    paths: ["src/**"]
    severity: CRITICAL
    category: security
    action: deny
    deny:
      regex:
        pattern: "\\beval\\("

  # Require safeguards
  - id: SEC002
    rule: "If req.user is used, requireAuth() must be present"
    paths: ["src/api/**"]
    severity: HIGH
    category: security
    action: when_require
    when:
      regex:
        pattern: "req\\.user"
    require:
      regex:
        pattern: "requireAuth\\("

maintainability:
  # Enforce best practices
  - id: MAINT001
    rule: "All exported functions must have JSDoc"
    paths: ["src/**/*.ts"]
    severity: MEDIUM
    category: maintainability
    action: require
    require:
      regex:
        pattern: "/\\*\\*[\\s\\S]*?\\*/"
```

### Action Types
- **`deny`**: Block if pattern found
- **`require`**: Require pattern to be present
- **`when_require`**: If `when` pattern found, `require` pattern must also be present

---

## 🔧 MCP Tool Usage

### `review_diff` Tool
```typescript
// Call from MCP client
{
  "name": "review_diff",
  "arguments": {
    "diff": "diff --git a/src/foo.ts b/src/foo.ts\n...",
    "changed_files": ["src/foo.ts", "src/bar.ts"],
    "options": {
      "confidence_threshold": 0.7,
      "max_findings": 50,
      "categories": ["security", "correctness"],
      "enable_llm": true,
      "llm_force": false,
      "two_pass": true,
      "risk_threshold": 3,
      "fail_on_severity": "HIGH",
      "include_sarif": true,
      "include_markdown": true
    }
  }
}
```

### Response Schema
```typescript
{
  "run_id": "uuid",
  "risk_score": 3,
  "classification": "feature",
  "hotspots": ["src/auth/", "src/api/"],
  "summary": "Added new authentication feature...",
  "findings": [
    {
      "id": "SEC001",
      "severity": "HIGH",
      "category": "security",
      "title": "Potential SQL injection",
      "message": "User input not sanitized...",
      "file": "src/api/users.ts",
      "line": 42,
      "confidence": 0.85
    }
  ],
  "should_fail": false,
  "stats": {
    "files_changed": 5,
    "lines_added": 120,
    "lines_removed": 30,
    "findings_count": 3,
    "llm_passes": 1
  }
}
```

---

## 🎨 Output Formats

### SARIF (GitHub Security Tab)
- Location: `artifacts/review_diff.sarif`
- Uploaded to: GitHub Security → Code scanning alerts
- Format: SARIF 2.1.0 standard

### Markdown (PR Comments)
- Location: `artifacts/review_diff.md`
- Posted as: PR comment with unique marker
- Updates: Existing comment updated on new pushes

---

## 🚦 CI/CD Integration

### GitHub Actions Workflow
```yaml
- name: Run review_diff
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
    HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    CE_REVIEW_FAIL_ON_SEVERITY: "CRITICAL"
  run: npx tsx scripts/ci/review-diff.ts
```

### Failure Policy
- **CRITICAL**: Block merge (default)
- **HIGH**: Block merge (optional)
- **MEDIUM**: Warning only
- **LOW**: Info only
- **INFO**: Info only

---

## 🔍 Debugging

### Enable Verbose Logging
```bash
DEBUG=context-engine:* npx tsx scripts/ci/review-diff.ts
```

### Check Noise Gate
```typescript
// Noise gate skips LLM if:
// - Risk score ≤ 2
// - No invariant violations
// - Tests were touched
```

### View Artifacts
```bash
ls -la artifacts/
cat artifacts/review_diff.md
cat artifacts/review_diff.sarif
```

---

## 📚 Related Documentation

- **Full Assessment**: `docs\archive\IMPLEMENTATION_STATUS_ASSESSMENT.md`
- **Executive Summary**: `docs\archive\ASSESSMENT_EXECUTIVE_SUMMARY.md`
- **Architecture Blueprint**: `docs\archive\ARCHITECTURE_ENHANCEMENT_BLUEPRINT.md`
- **Developer Guide**: `docs\archive\DEVELOPER_QUICK_REFERENCE.md`

---

**Need Help?** Check the test files in `tests/reviewer/` for usage examples.

