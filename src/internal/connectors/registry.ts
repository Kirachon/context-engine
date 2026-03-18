import type { ConnectorRegistry, ConnectorSignal, ContextConnector } from './types.js';
import { createGitMetadataConnector } from './gitMetadata.js';

function uniqueConnectors(connectors: ContextConnector[]): ContextConnector[] {
  const seen = new Set<string>();
  const output: ContextConnector[] = [];
  for (const connector of connectors) {
    if (seen.has(connector.id)) {
      continue;
    }
    seen.add(connector.id);
    output.push(connector);
  }
  return output;
}

export function createConnectorRegistry(
  connectors: ContextConnector[] = [createGitMetadataConnector()]
): ConnectorRegistry {
  const activeConnectors = uniqueConnectors(connectors);

  return {
    async collectSignals(workspacePath: string): Promise<ConnectorSignal[]> {
      const snapshots = await Promise.all(
        activeConnectors.map(async (connector) => {
          try {
            return await connector.collect(workspacePath);
          } catch {
            return null;
          }
        })
      );

      return snapshots.filter((snapshot): snapshot is ConnectorSignal => snapshot !== null);
    },
  };
}

export function buildConnectorFingerprint(signals: ConnectorSignal[]): string {
  if (signals.length === 0) {
    return 'connectors:none';
  }

  return signals
    .map((signal) => signal.fingerprint)
    .join('|');
}

export function formatConnectorHint(signal: ConnectorSignal): string {
  const detailSuffix = signal.details.length > 0
    ? ` (${signal.details.slice(0, 3).join('; ')})`
    : '';
  return `${signal.label}: ${signal.summary}${detailSuffix}`;
}
