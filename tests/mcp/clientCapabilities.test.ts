import { describe, expect, it, jest } from '@jest/globals';

import {
  ClientCapabilitiesManager,
  appendClarificationSection,
  attachClientCapabilitiesHandlers,
  buildAmbiguityFallbackStructured,
  buildDefaultContextClarificationQuestions,
  buildDefaultPlanningClarificationQuestions,
  formatAmbiguityFallbackText,
  isAmbiguousContextQuery,
  isAmbiguousPlanningTask,
  maybeSummarizeViaSampling,
  mergeClarificationAnswersIntoText,
  resolveAmbiguityViaElicitation,
  resolveClientCapabilitiesManager,
} from '../../src/mcp/capabilities/clientCapabilities.js';

describe('ClientCapabilitiesManager', () => {
  it('tracks negotiated elicitation and sampling capabilities from initialize', () => {
    const manager = new ClientCapabilitiesManager();

    manager.configureFromClientCapabilities({
      elicitation: { form: {} },
      sampling: { context: {} },
    });

    expect(manager.getNegotiatedCapabilities()).toEqual({
      elicitation: true,
      form_elicitation: true,
      url_elicitation: false,
      sampling: true,
    });
  });

  it('reports unsupported capabilities when nothing is negotiated', () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({});

    expect(manager.isElicitationSupported()).toBe(false);
    expect(manager.isSamplingSupported()).toBe(false);
    expect(manager.canElicit()).toBe(false);
    expect(manager.canSample()).toBe(false);
  });
});

describe('ambiguity detection', () => {
  it('flags vague planning tasks', () => {
    expect(isAmbiguousPlanningTask('fix auth')).toBe(true);
    expect(isAmbiguousPlanningTask('Implement JWT refresh rotation with migration plan')).toBe(false);
  });

  it('flags short or vague context queries', () => {
    expect(isAmbiguousContextQuery('auth')).toBe(true);
    expect(isAmbiguousContextQuery('how does user registration validate email addresses')).toBe(false);
  });
});

describe('resolveAmbiguityViaElicitation', () => {
  const request = {
    taskType: 'planning' as const,
    subject: 'fix auth',
    questions: buildDefaultPlanningClarificationQuestions('fix auth'),
  };

  it('returns explicit fallback text for unsupported clients', async () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({});

    const resolution = await resolveAmbiguityViaElicitation(manager, request);

    expect(resolution.mode).toBe('fallback');
    if (resolution.mode !== 'fallback') {
      throw new Error('Expected fallback resolution');
    }

    expect(resolution.delivery).toBe('structured');
    expect(resolution.structured.supported).toBe(false);
    expect(resolution.structured.reason).toBe('unsupported');
    expect(resolution.text).toContain('does not support server-initiated elicitation');
    expect(resolution.text).toContain('fix auth');
    expect(formatAmbiguityFallbackText(resolution.structured)).toBe(resolution.text);
  });

  it('uses client elicitation when form capability is negotiated and bound', async () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({ elicitation: { form: {} } });
    manager.bindElicitationActions({
      elicitInput: jest.fn(async () => ({
        action: 'accept' as const,
        content: {
          question_1: 'Fix login redirect loop',
          question_2: 'src/auth/**',
          question_3: 'Include tests',
        },
      })),
    });

    const resolution = await resolveAmbiguityViaElicitation(manager, request);

    expect(resolution.mode).toBe('elicited');
    if (resolution.mode !== 'elicited') {
      throw new Error('Expected elicited resolution');
    }

    expect(resolution.answers.question_1).toBe('Fix login redirect loop');
    expect(
      mergeClarificationAnswersIntoText('fix auth', resolution.answers)
    ).toContain('Fix login redirect loop');
  });

  it('falls back explicitly when the client declines elicitation', async () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({ elicitation: { form: {} } });
    manager.bindElicitationActions({
      elicitInput: jest.fn(async () => ({
        action: 'decline' as const,
      })),
    });

    const resolution = await resolveAmbiguityViaElicitation(manager, request);

    expect(resolution.mode).toBe('fallback');
    if (resolution.mode !== 'fallback') {
      throw new Error('Expected fallback resolution');
    }

    expect(resolution.structured.reason).toBe('declined');
    expect(resolution.text).toContain('Clarification Required');
  });
});

describe('maybeSummarizeViaSampling', () => {
  it('returns the original content when sampling is unsupported', async () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({});

    const resolution = await maybeSummarizeViaSampling(manager, {
      content: 'large context body',
      instruction: 'Summarize this context',
    });

    expect(resolution).toEqual({
      mode: 'fallback',
      reason: 'unsupported',
      content: 'large context body',
    });
  });

  it('uses client sampling when capability is negotiated and bound', async () => {
    const manager = new ClientCapabilitiesManager();
    manager.configureFromClientCapabilities({ sampling: {} });
    manager.bindSamplingActions({
      createMessage: jest.fn(async () => ({
        model: 'mock-client-model',
        role: 'assistant' as const,
        content: {
          type: 'text' as const,
          text: 'Summarized context for the agent.',
        },
      })),
    });

    const resolution = await maybeSummarizeViaSampling(manager, {
      content: 'large context body',
      instruction: 'Summarize this context',
    });

    expect(resolution.mode).toBe('sampled');
    if (resolution.mode !== 'sampled') {
      throw new Error('Expected sampled resolution');
    }

    expect(resolution.summary).toBe('Summarized context for the agent.');
    expect(resolution.model).toBe('mock-client-model');
  });
});

describe('attachClientCapabilitiesHandlers', () => {
  it('configures negotiated capabilities during MCP initialize', async () => {
    const manager = new ClientCapabilitiesManager();
    const server = {
      oninitialized: undefined as (() => Promise<void>) | undefined,
      getClientCapabilities: () => ({
        elicitation: { form: {} },
        sampling: {},
      }),
      elicitInput: jest.fn(),
      createMessage: jest.fn(),
    };

    attachClientCapabilitiesHandlers(server as never, manager, { log: () => undefined });

    await server.oninitialized?.();

    expect(manager.isFormElicitationSupported()).toBe(true);
    expect(manager.isSamplingSupported()).toBe(true);
    expect(manager.canElicit()).toBe(true);
    expect(manager.canSample()).toBe(true);
  });
});

describe('resolveClientCapabilitiesManager', () => {
  it('falls back to an unsupported manager when nothing is registered', () => {
    const manager = resolveClientCapabilitiesManager();
    expect(manager.isElicitationSupported()).toBe(false);
  });

  it('prefers a service client manager when provided', () => {
    const registered = new ClientCapabilitiesManager();
    registered.configureFromClientCapabilities({ elicitation: { form: {} } });

    const manager = resolveClientCapabilitiesManager({
      getClientCapabilitiesManager: () => registered,
    });

    expect(manager).toBe(registered);
    expect(manager.isFormElicitationSupported()).toBe(true);
  });
});

describe('appendClarificationSection', () => {
  it('appends structured fallback text for unsupported clients', () => {
    const structured = buildAmbiguityFallbackStructured(
      {
        taskType: 'context',
        subject: 'auth',
        questions: buildDefaultContextClarificationQuestions('auth'),
      },
      'unsupported'
    );

    const output = appendClarificationSection('base output', {
      mode: 'fallback',
      delivery: 'structured',
      text: formatAmbiguityFallbackText(structured),
      structured,
    });

    expect(output).toContain('base output');
    expect(output).toContain('Clarification Required');
    expect(output).toContain('elicitation=unsupported');
  });
});
