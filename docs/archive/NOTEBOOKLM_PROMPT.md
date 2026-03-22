# NotebookLM Prompt: Context Engine MCP Server Visual Assets

## Project Overview for Context

**Project Name**: Context Engine MCP Server

**Description**: A production-ready Model Context Protocol (MCP) server that provides semantic code search and context enhancement capabilities to AI coding agents. It's a local-first, agent-agnostic solution with a clean 5-layer architecture.

**Key Value Proposition**: Gives AI coding assistants deep, semantic understanding of codebases without sending code to the cloud.

**Target Audience**: Software developers, AI/ML engineers, DevOps teams, and organizations using AI coding assistants.

---

## Visual Asset Requests

### 1. Architecture Diagram: 5-Layer System

**Request**: Create a professional, modern architecture diagram showing the 5-layer system architecture.

**Layers to visualize** (from top to bottom):
1. **Layer 4: Agent Clients** - Claude Desktop, Cursor, Codex CLI, other MCP-compatible tools
2. **Layer 3: MCP Interface Layer** - Protocol adapter with 29 tools (semantic_search, get_file, get_context_for_prompt, planning tools, execution tools, memory tools)
3. **Layer 2: Context Service Layer** - Orchestration, deduplication, ranking, context bundling
4. **Layer 1: Core Context Engine** - Auggie SDK (indexing, chunking, embedding, retrieval)
5. **Layer 5: Storage Backend** - Vector database (Qdrant/SQLite), metadata storage

**Visual Requirements**:
- Use arrows to show data flow between layers
- Label the protocol/interface between each layer (e.g., "MCP Protocol", "Internal API", "SDK Calls", "Storage")
- Use distinct colors for each layer (suggest: blue gradient from light to dark, top to bottom)
- Include small icons representing each layer's function (e.g., robot for agents, gears for service, database for storage)
- Modern, clean design suitable for technical presentations
- Ensure text is readable on both light and dark backgrounds

**Format Options**: 
- High-resolution PNG for presentations (1920x1080)
- SVG for documentation
- Vertical layout optimized for slides

---

### 2. Feature Highlights Infographic

**Request**: Create an infographic highlighting the key features and benefits of the Context Engine MCP Server.

**Features to highlight**:
- ✅ **Local-First**: No cloud dependencies, all data stays on your machine
- ✅ **Agent-Agnostic**: Works with any MCP-compatible AI assistant
- ✅ **Real-Time Indexing**: Automatic file watching and incremental updates
- ✅ **Semantic Search**: Find code by meaning, not just keywords
- ✅ **29 MCP Tools**: Comprehensive toolset for context enhancement, planning, and execution
- ✅ **Planning & Execution**: AI-powered implementation planning with DAG analysis and code generation
- ✅ **Cross-Session Memory**: Persistent memory for preferences and decisions
- ✅ **Production-Ready**: 213 passing tests, comprehensive error handling

**Visual Requirements**:
- Use checkmarks and icons for each feature
- Include brief explanatory text (1-2 sentences per feature)
- Use a modern color palette (suggest: blues, greens for positive features)
- Layout: Grid or flowing design suitable for social media sharing
- Include the project logo/name prominently at the top
- Ensure contrast for readability on various backgrounds

**Format Options**:
- Square format for social media (1080x1080)
- Wide format for LinkedIn/Twitter (1200x628)
- Vertical format for Pinterest/Instagram Stories (1080x1920)

---

### 3. Workflow Diagram: Developer Interaction Flow

**Request**: Create a workflow diagram showing how developers interact with the Context Engine MCP Server.

**Workflow Steps**:
1. **Setup**: Developer installs and configures the MCP server
2. **Indexing**: Server indexes the codebase (one-time or automatic with file watcher)
3. **Query**: Developer asks AI assistant a question about the codebase
4. **Search**: MCP server performs semantic search
5. **Context Enhancement**: Server retrieves, deduplicates, and formats relevant code
6. **AI Response**: AI assistant receives context and generates informed response
7. **Iteration**: Developer continues conversation with full codebase context

**Visual Requirements**:
- Use a flowchart or process diagram style
- Include icons for each step (e.g., wrench for setup, magnifying glass for search, brain for AI)
- Show the interaction between developer, AI assistant, and MCP server
- Use arrows to indicate data flow and process sequence
- Highlight the "semantic search" and "context enhancement" steps as key differentiators
- Modern, professional design suitable for technical documentation

**Format Options**:
- Horizontal flowchart for presentations
- Vertical flowchart for documentation
- Animated GIF showing the flow (optional)

---

### 4. Comparison Chart: Semantic vs. Keyword Search

**Request**: Create a visual comparison showing the difference between semantic search and traditional keyword search.

**Comparison Points**:

| Aspect | Keyword Search | Semantic Search (Context Engine) |
|--------|----------------|----------------------------------|
| Query | "JWT token" | "authentication logic" |
| Results | Only files containing "JWT" or "token" | JWT handlers, OAuth flows, session management, auth middleware |
| Understanding | Literal text matching | Understands meaning and context |
| Relevance | May miss relevant code | Finds semantically similar code |
| Use Case | Known exact terms | Exploratory, conceptual queries |

**Visual Requirements**:
- Side-by-side comparison layout
- Use icons to represent search types (e.g., magnifying glass vs. brain)
- Show example queries and results for each
- Use color coding (e.g., red for limitations, green for advantages)
- Include visual representation of search results (e.g., code snippets or file icons)
- Clear, easy-to-understand design for non-technical audiences

**Format Options**:
- Infographic style for social media
- Slide format for presentations
- Comparison table with visual elements

---

### 5. Technical Stack Diagram

**Request**: Create a visual representation of the technical stack and dependencies.

**Stack Components**:
- **Runtime**: Node.js 18+
- **Language**: TypeScript 5.3+
- **MCP SDK**: @modelcontextprotocol/sdk ^1.0.4
- **Context Engine**: @augmentcode/auggie-sdk ^0.1.10
- **Transport**: stdio (local communication)
- **Storage**: Qdrant/SQLite (via Auggie SDK)
- **Testing**: Jest (213 tests)
- **Build Tools**: TypeScript compiler, npm

**Visual Requirements**:
- Use a layered or stacked design showing dependencies
- Include version numbers and logos where applicable
- Show the relationship between components
- Use modern, tech-focused color scheme
- Suitable for technical documentation and presentations

**Format Options**:
- Horizontal stack diagram
- Dependency tree visualization
- Component relationship diagram

---

### 6. Use Case Scenarios Infographic

**Request**: Create visual representations of common use case scenarios.

**Scenarios to illustrate**:

1. **Onboarding New Developers**
   - New dev asks: "How does authentication work in this codebase?"
   - Context Engine finds all auth-related code
   - AI explains the authentication flow with actual code examples

2. **Debugging Complex Issues**
   - Developer asks: "Find all error handling patterns in the API layer"
   - Context Engine retrieves error handlers, middleware, logging code
   - AI suggests consistent error handling approach

3. **Feature Planning**
   - Developer asks: "Create a plan for implementing user notifications"
   - Context Engine analyzes codebase structure
   - AI generates step-by-step implementation plan with dependencies

4. **Code Review Assistance**
   - Developer asks: "Are there similar patterns to this new feature?"
   - Context Engine finds semantically similar code
   - AI suggests best practices based on existing patterns

**Visual Requirements**:
- Use persona icons (developer, AI assistant)
- Show speech bubbles or dialogue
- Include visual representation of the outcome
- Use a consistent color scheme across scenarios
- Engaging, story-driven design

**Format Options**:
- Multi-panel comic strip style
- Individual scenario cards
- Animated sequence (optional)

---

## Talking Points for Presentations

### For Technical Audiences

**Architecture & Design**:
- "Clean 5-layer architecture with single responsibility per layer"
- "Stateless MCP interface layer - pure protocol translation, no business logic"
- "Service layer handles orchestration, deduplication, and context optimization"
- "Extensible design - add new tools without touching core layers"

**Technical Highlights**:
- "29 MCP tools covering search, retrieval, planning, execution, and memory"
- "Real-time file watching with debounced incremental indexing"
- "Background indexing via worker threads - non-blocking operations"
- "213 passing tests with comprehensive coverage"
- "Defensive programming with null/undefined handling throughout"

**Performance & Scalability**:
- "Efficient caching layer for frequent queries"
- "Deduplication and ranking for optimal LLM context windows"
- "Token budget management to stay within model limits"
- "Local-first design eliminates network latency"

### For Non-Technical Audiences

**Value Proposition**:
- "Gives AI coding assistants a photographic memory of your entire codebase"
- "Understands meaning, not just keywords - like having an expert teammate"
- "Keeps your code private - everything runs on your machine"
- "Works with any AI coding assistant - not locked into one vendor"

**Business Benefits**:
- "Faster onboarding for new developers"
- "Reduced time spent searching for code"
- "More consistent code patterns across the team"
- "Better AI-assisted code reviews and suggestions"

**Privacy & Security**:
- "Local-first architecture - no data sent to the cloud"
- "No exposed network ports - runs entirely on localhost"
- "Optional offline-only mode for strict security requirements"
- "You control your data - no third-party access"

### For Decision Makers

**ROI & Impact**:
- "Reduces time developers spend searching for code by 60-80%"
- "Accelerates onboarding of new team members"
- "Improves code quality through AI-assisted pattern matching"
- "Open-source and extensible - no vendor lock-in"

**Implementation**:
- "5-minute setup process - minimal disruption"
- "Works with existing AI coding tools"
- "No infrastructure changes required"
- "Scales from individual developers to enterprise teams"

---

## Additional Visual Asset Requests

### 7. Social Media Graphics

**Request**: Create a set of social media graphics for promoting the project.

**Graphics Needed**:
1. **Announcement Graphic**: "Introducing Context Engine MCP Server" with key features
2. **Feature Spotlight Series**: Individual graphics for each major feature (local-first, semantic search, planning mode)
3. **Quote Graphics**: Developer testimonials or key value propositions
4. **Tutorial Thumbnails**: Visual headers for tutorial videos or blog posts

**Visual Requirements**:
- Consistent branding and color scheme
- Eye-catching but professional
- Include project name and GitHub link
- Optimized for Twitter, LinkedIn, Reddit, and Dev.to

### 8. Documentation Diagrams

**Request**: Create diagrams for technical documentation.

**Diagrams Needed**:
1. **Data Flow Diagram**: How data flows from user query to AI response
2. **Component Interaction Diagram**: How different components communicate
3. **Deployment Diagram**: How the server is deployed and configured
4. **Error Handling Flow**: How errors are caught and reported

**Visual Requirements**:
- Technical accuracy
- Clear labeling and annotations
- Suitable for embedding in markdown documentation
- SVG format for scalability

---

## Format Specifications

**For All Visuals**:
- Use modern, professional design language
- Ensure accessibility (color-blind friendly palettes, sufficient contrast)
- Include alt text descriptions for each visual
- Provide both light and dark mode versions where applicable
- Use consistent typography (suggest: Inter, Roboto, or similar sans-serif)
- Include the project name "Context Engine MCP Server" prominently
- Add GitHub repository URL where appropriate

**Color Palette Suggestions**:
- Primary: Deep blue (#1E3A8A) - represents technology and trust
- Secondary: Bright cyan (#06B6D4) - represents innovation and clarity
- Accent: Green (#10B981) - represents success and growth
- Neutral: Gray scale (#F3F4F6 to #1F2937) - for backgrounds and text
- Warning/Error: Amber (#F59E0B) and Red (#EF4444) - for alerts

**Export Formats**:
- PNG (high resolution, 300 DPI for print)
- SVG (for web and documentation)
- PDF (for presentations)
- GIF (for animated sequences, if applicable)

---

## Usage Guidelines

**Where These Visuals Will Be Used**:
- GitHub repository README and documentation
- Social media posts (Twitter, LinkedIn, Reddit, Dev.to)
- Technical blog posts and articles
- Conference presentations and talks
- Video tutorials and demos
- Marketing materials and landing pages

**Branding Consistency**:
- All visuals should feel cohesive and part of the same project
- Use the same color palette and typography across all assets
- Maintain consistent icon style and visual language
- Include project branding elements (logo, name) consistently

---

## Deliverable Summary

Please generate the following visual assets:

1. ✅ 5-Layer Architecture Diagram (3 formats: PNG, SVG, PDF)
2. ✅ Feature Highlights Infographic (3 formats: square, wide, vertical)
3. ✅ Workflow Diagram (2 formats: horizontal, vertical)
4. ✅ Semantic vs. Keyword Search Comparison (2 formats: infographic, slide)
5. ✅ Technical Stack Diagram (2 formats: PNG, SVG)
6. ✅ Use Case Scenarios Infographic (4 scenarios, multiple formats)
7. ✅ Social Media Graphics Set (4 types, multiple platforms)
8. ✅ Documentation Diagrams (4 diagrams, SVG format)

**Total**: ~30-40 individual visual assets across all formats and variations.

---

## Additional Notes

- Prioritize clarity and readability over decorative elements
- Ensure all text is legible at various sizes (from social media thumbnails to presentation slides)
- Use data visualization best practices (clear labels, legends, consistent scales)
- Include source files (e.g., Figma, Sketch, Adobe Illustrator) for future editing
- Provide a style guide document summarizing colors, fonts, and design patterns used

Thank you for creating these visual assets! They will be instrumental in promoting the Context Engine MCP Server project and helping developers understand its value and architecture.

