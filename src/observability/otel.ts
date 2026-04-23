import { envBool, envString } from '../config/env.js';

type HeaderCarrier = Record<string, string | string[] | undefined>;

type OtelSpanLike = {
  setAttribute?: (name: string, value: string | number | boolean) => void;
  addEvent?: (name: string, attributes?: Record<string, string | number | boolean>) => void;
  recordException?: (error: Error) => void;
  setStatus?: (status: { code: number; message?: string }) => void;
  end: () => void;
};

type LoadedOtelState = {
  api: any;
  tracer: any;
  sdk: any;
};

export interface ObservabilityHandle {
  enabled: boolean;
  reason: 'disabled' | 'started' | 'dependencies_unavailable' | 'startup_failed';
}

export interface ObservabilitySpan {
  setAttribute(name: string, value: string | number | boolean | undefined): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean | undefined>): void;
  recordException(error: unknown): void;
  setErrorStatus(message: string): void;
  end(): void;
}

type ObservabilityState = {
  handle: ObservabilityHandle;
  loaded?: LoadedOtelState;
};

let currentState: ObservabilityState | undefined;

function normalizeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

function sanitizeAttributes(
  attributes: Record<string, unknown> | undefined
): Record<string, string | number | boolean> | undefined {
  if (!attributes) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [key, normalizeAttributeValue(value)])
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

class NoopSpan implements ObservabilitySpan {
  setAttribute(): void {}
  addEvent(): void {}
  recordException(): void {}
  setErrorStatus(): void {}
  end(): void {}
}

class WrappedSpan implements ObservabilitySpan {
  constructor(
    private readonly span: OtelSpanLike,
    private readonly api: any
  ) {}

  setAttribute(name: string, value: string | number | boolean | undefined): void {
    const normalized = normalizeAttributeValue(value);
    if (normalized === undefined) {
      return;
    }
    this.span.setAttribute?.(name, normalized);
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean | undefined>): void {
    const sanitized = sanitizeAttributes(attributes);
    this.span.addEvent?.(name, sanitized);
  }

  recordException(error: unknown): void {
    if (error instanceof Error) {
      this.span.recordException?.(error);
    }
  }

  setErrorStatus(message: string): void {
    const code = this.api?.SpanStatusCode?.ERROR;
    if (typeof code === 'number') {
      this.span.setStatus?.({ code, message });
    }
  }

  end(): void {
    this.span.end();
  }
}

async function loadOtelState(): Promise<LoadedOtelState> {
  const [api, sdkNode, resources, semanticConventions] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);

  const serviceName = envString('CE_OBSERVABILITY_SERVICE_NAME', 'context-engine') ?? 'context-engine';
  const exporterUrl = envString('CE_OBSERVABILITY_EXPORTER_URL');
  const resourceAttributes = {
    [semanticConventions.SemanticResourceAttributes?.SERVICE_NAME ?? 'service.name']: serviceName,
  };
  const resource = typeof resources.resourceFromAttributes === 'function'
    ? resources.resourceFromAttributes(resourceAttributes)
    : new resources.Resource(resourceAttributes);

  let traceExporter: unknown;
  if (exporterUrl) {
    const exporterModule = await import('@opentelemetry/exporter-trace-otlp-http');
    traceExporter = new exporterModule.OTLPTraceExporter({ url: exporterUrl });
  }

  const sdk = new sdkNode.NodeSDK({
    resource,
    ...(traceExporter ? { traceExporter } : {}),
  });

  await sdk.start();

  return {
    api,
    sdk,
    tracer: api.trace.getTracer('context-engine'),
  };
}

export async function startObservability(): Promise<ObservabilityHandle> {
  if (currentState) {
    return currentState.handle;
  }

  if (!envBool('CE_OBSERVABILITY_ENABLED', false)) {
    const handle: ObservabilityHandle = { enabled: false, reason: 'disabled' };
    currentState = { handle };
    return handle;
  }

  try {
    const loaded = await loadOtelState();
    const handle: ObservabilityHandle = { enabled: true, reason: 'started' };
    currentState = { handle, loaded };
    return handle;
  } catch (error) {
    console.warn('[observability] OpenTelemetry bootstrap unavailable; continuing with observability disabled.', error);
    const missingModuleName = typeof (error as { moduleName?: unknown })?.moduleName === 'string'
      ? String((error as { moduleName?: string }).moduleName)
      : '';
    const errorMessage = error instanceof Error ? error.message : String(error);
    const reason: ObservabilityHandle['reason'] = /@opentelemetry\//i.test(`${missingModuleName} ${errorMessage}`)
      ? 'dependencies_unavailable'
      : 'startup_failed';
    const handle: ObservabilityHandle = { enabled: false, reason };
    currentState = { handle };
    return handle;
  }
}

export async function shutdownObservability(): Promise<void> {
  if (!currentState?.loaded?.sdk) {
    currentState = undefined;
    return;
  }

  try {
    await currentState.loaded.sdk.shutdown();
  } catch (error) {
    console.warn('[observability] OpenTelemetry shutdown failed.', error);
  } finally {
    currentState = undefined;
  }
}

export function withObservabilitySpanContext<T>(
  name: string,
  options: {
    attributes?: Record<string, unknown>;
    headers?: HeaderCarrier;
  },
  fn: (span: ObservabilitySpan | undefined) => T
): T {
  const loaded = currentState?.loaded;
  if (!loaded) {
    return fn(undefined);
  }

  const attributes = sanitizeAttributes(options.attributes);
  const parentContext = options.headers
    ? loaded.api.propagation.extract(loaded.api.context.active(), options.headers)
    : loaded.api.context.active();
  const rawSpan = loaded.tracer.startSpan(name, { attributes }, parentContext);
  const wrappedSpan = new WrappedSpan(rawSpan, loaded.api);
  const spanContext = loaded.api.trace.setSpan(parentContext, rawSpan);

  return loaded.api.context.with(spanContext, () => fn(wrappedSpan));
}

export async function runWithObservabilitySpan<T>(
  name: string,
  options: {
    attributes?: Record<string, unknown>;
    headers?: HeaderCarrier;
  },
  fn: (span: ObservabilitySpan | undefined) => Promise<T> | T
): Promise<T> {
  return await withObservabilitySpanContext(name, options, async (span) => {
    const activeSpan = span ?? new NoopSpan();
    try {
      return await fn(span);
    } catch (error) {
      activeSpan.recordException(error);
      activeSpan.setErrorStatus(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      activeSpan.end();
    }
  });
}

export function setActiveSpanAttributes(attributes: Record<string, unknown>): void {
  const loaded = currentState?.loaded;
  if (!loaded) {
    return;
  }

  const activeSpan = loaded.api.trace.getActiveSpan?.() as OtelSpanLike | undefined;
  if (!activeSpan) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttributeValue(value);
    if (normalized !== undefined) {
      activeSpan.setAttribute?.(key, normalized);
    }
  }
}

export function __resetObservabilityForTests(): void {
  currentState = undefined;
}
