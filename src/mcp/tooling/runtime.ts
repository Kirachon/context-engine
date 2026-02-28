export type ToolHandler = (args: unknown) => Promise<string>;

export type ToolCallResult = 'success' | 'error';

type ToolResponseContent = {
  type: 'text';
  text: string;
};

export type ToolCallResponse =
  | {
      content: ToolResponseContent[];
      isError?: false;
    }
  | {
      content: ToolResponseContent[];
      isError: true;
    };

export type ExecuteToolCallParams = {
  name: string;
  args: unknown;
  toolHandlers: Map<string, ToolHandler>;
  now?: () => number;
  log?: (message: string) => void;
};

export type ExecuteToolCallResult = {
  response: ToolCallResponse;
  result: ToolCallResult;
  elapsedMs: number;
};

export async function executeToolCall(params: ExecuteToolCallParams): Promise<ExecuteToolCallResult> {
  const { name, args, toolHandlers } = params;
  const now = params.now ?? Date.now;
  const log = params.log ?? console.error;
  const startTime = now();

  log(`[${new Date().toISOString()}] Tool: ${name}`);

  try {
    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = await handler(args);
    const elapsedMs = now() - startTime;
    log(`[${new Date().toISOString()}] Tool ${name} completed in ${elapsedMs}ms`);

    return {
      response: {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      },
      result: 'success',
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    log(`[${new Date().toISOString()}] Tool ${name} failed after ${elapsedMs}ms: ${errorMessage}`);

    return {
      response: {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      },
      result: 'error',
      elapsedMs,
    };
  }
}
