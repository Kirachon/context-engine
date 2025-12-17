# Memory System

This directory contains persistent memories that the AI assistant will reference across sessions.

## How It Works

1. **Automatic Indexing**: Files in this directory are indexed by Auggie alongside your code
2. **Semantic Search**: When you ask questions, relevant memories are retrieved automatically
3. **Human-Editable**: You can read and edit these files directly - they're just markdown
4. **Version Controlled**: Commit to Git to track memory evolution and share with your team

## Memory Categories

| File | Purpose | Example Content |
|------|---------|-----------------|
| `preferences.md` | Coding style and tool preferences | "Prefer functional programming", "Use Jest for testing" |
| `decisions.md` | Architecture and design decisions | "Chose JWT over sessions", "Using PostgreSQL" |
| `facts.md` | Project facts and environment info | "API runs on port 3000", "Uses monorepo structure" |

## Adding Memories

### Option 1: Use the MCP Tool (Recommended)
```
AI: Use the add_memory tool to store this preference:
    category: preferences
    content: "Prefers TypeScript strict mode for all new files"
```

### Option 2: Edit Files Directly
Simply open any `.md` file in this directory and add your content under the appropriate section.

### Option 3: Let the AI Learn
The AI can suggest adding memories based on your conversations. Just approve them!

## Tips for Effective Memories

1. **Be Specific**: "Use 2-space indentation" is better than "format code nicely"
2. **Include Context**: Explain *why* for decisions, not just *what*
3. **Date Important Decisions**: Use `### [YYYY-MM-DD] Title` format
4. **Keep It Current**: Remove outdated memories to avoid confusion

## Privacy Note

These files are stored locally in your project directory. They are only shared if you commit them to Git.

