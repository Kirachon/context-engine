export type ConnectorSignalStatus = 'available' | 'unavailable';

export interface ConnectorSignal {
  id: string;
  label: string;
  status: ConnectorSignalStatus;
  fingerprint: string;
  summary: string;
  details: string[];
}

export interface ContextConnector {
  id: string;
  label: string;
  collect(workspacePath: string): Promise<ConnectorSignal | null>;
}

export interface ConnectorRegistry {
  collectSignals(workspacePath: string): Promise<ConnectorSignal[]>;
}
