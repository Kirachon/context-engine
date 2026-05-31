import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequestFormParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';

export type ClientElicitationCapability = {
  form?: Record<string, unknown>;
  url?: Record<string, unknown>;
};

export type ClientSamplingCapability = {
  context?: Record<string, unknown>;
  tools?: Record<string, unknown>;
};

export type AmbiguityTaskType = 'planning' | 'context';

export type AmbiguityClarificationRequest = {
  taskType: AmbiguityTaskType;
  subject: string;
  questions: readonly string[];
};

export type AmbiguityFallbackStructured = {
  capability: 'elicitation';
  supported: false;
  reason: 'unsupported' | 'unbound' | 'declined' | 'cancelled' | 'error';
  message: string;
  subject: string;
  task_type: AmbiguityTaskType;
  questions: string[];
  instructions: string;
};

export type ElicitationResolution =
  | {
      mode: 'elicited';
      action: ElicitResult['action'];
      answers: Record<string, unknown>;
    }
  | {
      mode: 'fallback';
      delivery: 'text' | 'structured';
      text: string;
      structured: AmbiguityFallbackStructured;
    };

export type SamplingResolution =
  | {
      mode: 'sampled';
      summary: string;
      model: string;
    }
  | {
      mode: 'fallback';
      reason: 'unsupported' | 'unbound' | 'empty' | 'error';
      content: string;
    };

type ElicitationActions = {
  elicitInput: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
};

type SamplingActions = {
  createMessage: (params: CreateMessageRequest['params']) => Promise<CreateMessageResult>;
};

const clientCapabilitiesStorage = new AsyncLocalStorage<ClientCapabilitiesManager>();

let defaultUnsupportedManager: ClientCapabilitiesManager | undefined;

export class ClientCapabilitiesManager {
  private elicitationSupported = false;
  private formElicitationSupported = false;
  private urlElicitationSupported = false;
  private samplingSupported = false;
  private elicitationActions: ElicitationActions | null = null;
  private samplingActions: SamplingActions | null = null;

  configureFromClientCapabilities(capabilities?: ClientCapabilities): void {
    const elicitation = capabilities?.elicitation;
    this.formElicitationSupported = Boolean(elicitation?.form);
    this.urlElicitationSupported = Boolean(elicitation?.url);
    this.elicitationSupported = this.formElicitationSupported || this.urlElicitationSupported;
    this.samplingSupported = Boolean(capabilities?.sampling);
  }

  bindServerActions(server: Pick<Server, 'elicitInput' | 'createMessage'>): void {
    this.elicitationActions = {
      elicitInput: server.elicitInput.bind(server),
    };
    this.samplingActions = {
      createMessage: server.createMessage.bind(server),
    };
  }

  bindElicitationActions(actions: ElicitationActions | null): void {
    this.elicitationActions = actions;
  }

  bindSamplingActions(actions: SamplingActions | null): void {
    this.samplingActions = actions;
  }

  isElicitationSupported(): boolean {
    return this.elicitationSupported;
  }

  isFormElicitationSupported(): boolean {
    return this.formElicitationSupported;
  }

  isUrlElicitationSupported(): boolean {
    return this.urlElicitationSupported;
  }

  isSamplingSupported(): boolean {
    return this.samplingSupported;
  }

  canElicit(): boolean {
    return this.formElicitationSupported && this.elicitationActions !== null;
  }

  canSample(): boolean {
    return this.samplingSupported && this.samplingActions !== null;
  }

  async elicitFormInput(params: ElicitRequestFormParams): Promise<ElicitResult> {
    if (!this.canElicit()) {
      throw new Error('Client form elicitation is not available');
    }
    return this.elicitationActions!.elicitInput(params);
  }

  async createSampleMessage(params: CreateMessageRequest['params']): Promise<CreateMessageResult> {
    if (!this.canSample()) {
      throw new Error('Client sampling is not available');
    }
    return this.samplingActions!.createMessage(params);
  }

  getNegotiatedCapabilities(): {
    elicitation: boolean;
    form_elicitation: boolean;
    url_elicitation: boolean;
    sampling: boolean;
  } {
    return {
      elicitation: this.elicitationSupported,
      form_elicitation: this.formElicitationSupported,
      url_elicitation: this.urlElicitationSupported,
      sampling: this.samplingSupported,
    };
  }
}

export function runWithClientCapabilitiesManager<T>(
  manager: ClientCapabilitiesManager,
  fn: () => T
): T {
  return clientCapabilitiesStorage.run(manager, fn);
}

export function getActiveClientCapabilitiesManager(): ClientCapabilitiesManager | undefined {
  return clientCapabilitiesStorage.getStore();
}

export function resolveClientCapabilitiesManager(
  serviceClient?: {
    getClientCapabilitiesManager?: () => ClientCapabilitiesManager | null;
  }
): ClientCapabilitiesManager {
  return (
    getActiveClientCapabilitiesManager()
    ?? serviceClient?.getClientCapabilitiesManager?.()
    ?? getDefaultUnsupportedManager()
  );
}

function getDefaultUnsupportedManager(): ClientCapabilitiesManager {
  if (!defaultUnsupportedManager) {
    defaultUnsupportedManager = new ClientCapabilitiesManager();
  }
  return defaultUnsupportedManager;
}

export function isAmbiguousPlanningTask(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  const vagueLeadPattern = /^(fix|improve|update|refactor|add|remove|change|help with|work on|plan|implement)\b/;
  if (normalized.length <= 48 && vagueLeadPattern.test(normalized)) {
    return true;
  }

  if (/^(fix|improve|update|refactor)\s+\w+(\s+\w+)?$/.test(normalized)) {
    return true;
  }

  return false;
}

export function isAmbiguousContextQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  if (normalized.length <= 24) {
    return true;
  }

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount <= 3) {
    return true;
  }

  const vagueShortPattern = /^(fix|auth|login|database|api|tests?)\b/;
  return normalized.length <= 40 && vagueShortPattern.test(normalized);
}

export function buildDefaultPlanningClarificationQuestions(task: string): string[] {
  return [
    `What exact outcome should "${task.trim()}" achieve?`,
    'Which files, modules, or user flows should be in scope?',
    'Should tests, migrations, or rollout steps be included?',
  ];
}

export function buildDefaultContextClarificationQuestions(query: string): string[] {
  return [
    `What specific behavior or code path should "${query.trim()}" focus on?`,
    'Are you looking for implementation details, tests, configuration, or recent changes?',
    'Should the context include related dependencies and callers?',
  ];
}

export function buildAmbiguityFallbackStructured(
  request: AmbiguityClarificationRequest,
  reason: AmbiguityFallbackStructured['reason']
): AmbiguityFallbackStructured {
  return {
    capability: 'elicitation',
    supported: false,
    reason,
    message:
      'This MCP client does not support server-initiated elicitation. Answer the clarification questions in your next message.',
    subject: request.subject,
    task_type: request.taskType,
    questions: [...request.questions],
    instructions:
      'Reply with clarifications as plain text or a JSON object keyed by the question text.',
  };
}

export function formatAmbiguityFallbackText(structured: AmbiguityFallbackStructured): string {
  let output = '## Clarification Required\n\n';
  output += `${structured.message}\n\n`;
  output += `**Subject:** ${structured.subject}\n\n`;
  output += `**Client capability:** elicitation=${structured.supported ? 'supported' : 'unsupported'} (${structured.reason})\n\n`;
  output += `### Questions\n`;
  for (const question of structured.questions) {
    output += `- ${question}\n`;
  }
  output += `\n${structured.instructions}\n`;
  return output;
}

function buildElicitationFormParams(request: AmbiguityClarificationRequest): ElicitRequestFormParams {
  const properties: ElicitRequestFormParams['requestedSchema']['properties'] = {};
  const required: string[] = [];

  request.questions.forEach((question, index) => {
    const key = `question_${index + 1}`;
    properties[key] = {
      type: 'string',
      title: `Question ${index + 1}`,
      description: question,
    };
    required.push(key);
  });

  return {
    mode: 'form',
    message: `The ${request.taskType} request "${request.subject}" is ambiguous. Please clarify before continuing.`,
    requestedSchema: {
      type: 'object',
      properties,
      required,
    },
  };
}

function buildFallbackResolution(
  request: AmbiguityClarificationRequest,
  reason: AmbiguityFallbackStructured['reason']
): ElicitationResolution {
  const structured = buildAmbiguityFallbackStructured(request, reason);
  return {
    mode: 'fallback',
    delivery: 'structured',
    text: formatAmbiguityFallbackText(structured),
    structured,
  };
}

export async function resolveAmbiguityViaElicitation(
  manager: ClientCapabilitiesManager,
  request: AmbiguityClarificationRequest
): Promise<ElicitationResolution> {
  if (!manager.isFormElicitationSupported()) {
    return buildFallbackResolution(request, 'unsupported');
  }

  if (!manager.canElicit()) {
    return buildFallbackResolution(request, 'unbound');
  }

  try {
    const result = await manager.elicitFormInput(buildElicitationFormParams(request));
    if (result.action === 'accept' && result.content) {
      return {
        mode: 'elicited',
        action: result.action,
        answers: result.content as Record<string, unknown>,
      };
    }

    const reason = result.action === 'cancel' ? 'cancelled' : 'declined';
    return buildFallbackResolution(request, reason);
  } catch {
    return buildFallbackResolution(request, 'error');
  }
}

export function mergeClarificationAnswersIntoText(
  subject: string,
  answers: Record<string, unknown>
): string {
  const lines = Object.entries(answers).map(([key, value]) => `- ${key}: ${String(value)}`);
  return `${subject.trim()}\n\nClarifications:\n${lines.join('\n')}`;
}

export function appendClarificationSection(baseOutput: string, resolution: ElicitationResolution): string {
  if (resolution.mode === 'elicited') {
    const lines = Object.entries(resolution.answers).map(([key, value]) => `- ${key}: ${String(value)}`);
    return `${baseOutput}\n\n## Client Clarifications\n\nThe connected MCP client provided these answers via elicitation:\n${lines.join('\n')}\n`;
  }

  return `${baseOutput}\n\n${resolution.text}`;
}

export async function maybeSummarizeViaSampling(
  manager: ClientCapabilitiesManager,
  params: {
    content: string;
    instruction: string;
    maxTokens?: number;
  }
): Promise<SamplingResolution> {
  if (!manager.isSamplingSupported()) {
    return {
      mode: 'fallback',
      reason: 'unsupported',
      content: params.content,
    };
  }

  if (!manager.canSample()) {
    return {
      mode: 'fallback',
      reason: 'unbound',
      content: params.content,
    };
  }

  try {
    const result = await manager.createSampleMessage({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${params.instruction}\n\n${params.content}`,
          },
        },
      ],
      maxTokens: params.maxTokens ?? 512,
    });

    const text = extractSamplingText(result);
    if (!text) {
      return {
        mode: 'fallback',
        reason: 'empty',
        content: params.content,
      };
    }

    return {
      mode: 'sampled',
      summary: text,
      model: result.model,
    };
  } catch {
    return {
      mode: 'fallback',
      reason: 'error',
      content: params.content,
    };
  }
}

function extractSamplingText(result: CreateMessageResult): string {
  const content = result.content;
  if (content && typeof content === 'object' && 'type' in content && content.type === 'text') {
    return content.text.trim();
  }
  return '';
}

export type AttachClientCapabilitiesHandlersOptions = {
  log?: (message: string) => void;
};

export function attachClientCapabilitiesHandlers(
  server: Server,
  manager: ClientCapabilitiesManager,
  options?: AttachClientCapabilitiesHandlersOptions
): void {
  const log = options?.log ?? ((message: string) => console.error(message));
  const previousOnInitialized = server.oninitialized;

  server.oninitialized = async () => {
    manager.configureFromClientCapabilities(server.getClientCapabilities());
    manager.bindServerActions(server);
    log(
      `[client-capabilities] Negotiated capabilities: ${JSON.stringify(manager.getNegotiatedCapabilities())}`
    );
    await previousOnInitialized?.();
  };
}
