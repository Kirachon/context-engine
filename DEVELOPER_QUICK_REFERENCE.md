# Developer Quick Reference

## 🚀 Quick Start

### Installation
```bash
npm install
npm run build
```

### Running the Server
```bash
# Development mode (with watch)
npm run dev

# Production mode
npm start

# Using built distribution
npm run start:dist
```

### Testing
```bash
# Run all tests
npm test

# Watch mode
npm test:watch

# Coverage report
npm test:coverage
```

## 📁 Key Files

### Entry Points
- `src/index.ts` - Main entry point
- `bin/context-engine-mcp.js` - CLI wrapper

### Core Components
- `src/mcp/server.ts` - MCP server implementation
- `src/mcp/serviceClient.ts` - Context service client
- `src/http/httpServer.ts` - HTTP server for VS Code

### Services (Layer 2)
- `src/mcp/services/planningService.ts` - Plan generation
- `src/mcp/services/planPersistenceService.ts` - Plan storage
- `src/mcp/services/executionTrackingService.ts` - Execution tracking
- `src/mcp/services/approvalWorkflowService.ts` - Approval system
- `src/mcp/services/planHistoryService.ts` - Version control

### Tools (Layer 3)
- `src/mcp/tools/search.ts` - Semantic search
- `src/mcp/tools/file.ts` - File retrieval
- `src/mcp/tools/context.ts` - Context bundling
- `src/mcp/tools/plan.ts` - Planning tools
- `src/mcp/tools/planManagement.ts` - Plan management
- `src/mcp/tools/memory.ts` - Memory system

## 🛠️ Common Tasks

### Adding a New Tool

1. Create tool file in `src/mcp/tools/`:
```typescript
// src/mcp/tools/myTool.ts
export const myTool = {
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string', description: 'Parameter description' }
    },
    required: ['param']
  }
};

export async function handleMyTool(
  args: { param: string },
  serviceClient: ContextServiceClient
): Promise<string> {
  // Implementation
  return JSON.stringify({ result: 'success' });
}
```

2. Register in `src/mcp/server.ts`:
```typescript
import { myTool, handleMyTool } from './tools/myTool.js';

// In ListToolsRequestSchema handler:
tools: [
  // ... existing tools
  myTool,
]

// In CallToolRequestSchema handler:
case 'my_tool':
  result = await handleMyTool(args as any, this.serviceClient);
  break;
```

3. Update `src/mcp/tools/manifest.ts`:
```typescript
tools: [
  // ... existing tools
  'my_tool',
]
```

### Adding a New Service

1. Create service file in `src/mcp/services/`:
```typescript
// src/mcp/services/myService.ts
export class MyService {
  constructor(private workspacePath: string) {}
  
  async doSomething(): Promise<Result> {
    // Implementation
  }
}
```

2. Use in tools or serviceClient as needed

### Running Tests

```bash
# All tests
npm test

# Specific test file
npm test -- serviceClient.test.ts

# With coverage
npm test:coverage

# Watch mode
npm test:watch
```

### Debugging

```bash
# Use MCP Inspector
npm run inspector

# Manual debugging
node --inspect dist/index.js --workspace .
```

## 📊 Architecture Layers

### Layer 1: Local-Native Retrieval Runtime
- **Location**: `src/retrieval/`, `src/internal/retrieval/`, `src/mcp/serviceClient.ts`
- **Purpose**: Core indexing and retrieval
- **Interface**: retrieval provider boundary + MCP tools

### Layer 2: Service Layer
- **Location**: `src/mcp/serviceClient.ts`, `src/mcp/services/`
- **Purpose**: Business logic and orchestration
- **Interface**: Service classes

### Layer 3: MCP Interface
- **Location**: `src/mcp/server.ts`, `src/mcp/tools/`
- **Purpose**: Tool definitions and handlers
- **Interface**: MCP protocol

### Layer 4: Transport
- **Location**: `src/http/`
- **Purpose**: HTTP transport for VS Code
- **Interface**: REST API

## 🔍 Code Patterns

### Tool Handler Pattern
```typescript
export async function handleToolName(
  args: ToolArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  try {
    // 1. Validate input
    if (!args.required_param) {
      throw new Error('required_param is required');
    }
    
    // 2. Call service layer
    const result = await serviceClient.someMethod(args);
    
    // 3. Format output
    return JSON.stringify(result, null, 2);
  } catch (error) {
    // 4. Handle errors
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
```

### Service Pattern
```typescript
export class MyService {
  constructor(private workspacePath: string) {}
  
  async operation(params: Params): Promise<Result> {
    // 1. Validate
    this.validateParams(params);
    
    // 2. Process
    const data = await this.processData(params);
    
    // 3. Persist (if needed)
    await this.saveData(data);
    
    // 4. Return
    return data;
  }
  
  private validateParams(params: Params): void {
    // Validation logic
  }
}
```

## 📝 Testing Patterns

### Unit Test Pattern
```typescript
describe('MyService', () => {
  let service: MyService;
  
  beforeEach(() => {
    service = new MyService('/test/workspace');
  });
  
  it('should do something', async () => {
    const result = await service.operation({ param: 'value' });
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });
});
```

## 🔧 Configuration

### Environment Variables
- `CE_RETRIEVAL_PROVIDER` - retrieval provider preference (`local_native`)
- `CE_AI_PROVIDER` - AI provider for ask flows (`openai_session`)

### MCP Configuration
See `codex_config.example.toml` for MCP client setup

## 📚 Documentation

- `README.md` - Overview and quick start
- `ARCHITECTURE.md` - Detailed architecture
- `PLANNING_WORKFLOW.md` - Planning feature guide
- `TESTING.md` - Testing guide
- `TROUBLESHOOTING.md` - Common issues
- `COMPREHENSIVE_PROJECT_SUMMARY.md` - Complete project summary

## 🎯 Best Practices

1. **Always validate input** in tool handlers
2. **Use TypeScript types** for all parameters
3. **Handle errors gracefully** with try-catch
4. **Write tests** for new features
5. **Update documentation** when adding features
6. **Follow layer boundaries** - don't skip layers
7. **Use service layer** for business logic
8. **Keep tools thin** - delegate to services
