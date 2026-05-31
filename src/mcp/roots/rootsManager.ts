import fs from 'node:fs';
import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { RootsListChangedNotificationSchema, type Root } from '@modelcontextprotocol/sdk/types.js';
import {
  assertPathInsideWorkspace,
  resolveRealPathInsideWorkspace,
} from '../../workspace/pathValidation.js';

export type ClientRootsCapability = {
  listChanged?: boolean;
};

export type RootsUpdateResult = {
  accepted: boolean;
  reason?: 'unsupported' | 'invalid_uri' | 'outside_workspace' | 'symlink_escape';
  allowedRoots: readonly string[];
  rejectedRoots: readonly RejectedRoot[];
};

export type RejectedRoot = {
  uri: string;
  reason: RootsUpdateResult['reason'];
  message: string;
};

export function parseFileRootUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') {
      return null;
    }

    let filePath = decodeURIComponent(parsed.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }

    return path.normalize(filePath);
  } catch {
    return null;
  }
}

function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const root of roots) {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped.sort((left, right) => left.length - right.length);
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class RootsManager {
  private readonly workspacePath: string;
  private readonly workspaceRealPath: string;
  private rootsSupported = false;
  private listChangedSupported = false;
  private enforcementActive = false;
  private allowedRoots: string[] = [];

  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath);
    this.workspaceRealPath = fs.existsSync(this.workspacePath)
      ? fs.realpathSync(this.workspacePath)
      : this.workspacePath;
  }

  configureFromClientCapabilities(capabilities?: { roots?: ClientRootsCapability }): void {
    this.rootsSupported = Boolean(capabilities?.roots);
    this.listChangedSupported = Boolean(capabilities?.roots?.listChanged);
    if (!this.rootsSupported) {
      this.enforcementActive = false;
      this.allowedRoots = [];
    }
  }

  isRootsSupported(): boolean {
    return this.rootsSupported;
  }

  isListChangedSupported(): boolean {
    return this.listChangedSupported;
  }

  isEnforcementActive(): boolean {
    return this.enforcementActive;
  }

  getAllowedRoots(): readonly string[] {
    return this.allowedRoots;
  }

  getIndexingRoots(): string[] {
    if (!this.enforcementActive) {
      return [this.workspacePath];
    }
    return [...this.allowedRoots];
  }

  updateRoots(roots: readonly Root[]): RootsUpdateResult {
    if (!this.rootsSupported) {
      return {
        accepted: false,
        reason: 'unsupported',
        allowedRoots: [],
        rejectedRoots: [],
      };
    }

    const acceptedRoots: string[] = [];
    const rejectedRoots: RejectedRoot[] = [];

    for (const root of roots) {
      const parsedPath = parseFileRootUri(root.uri);
      if (!parsedPath) {
        rejectedRoots.push({
          uri: root.uri,
          reason: 'invalid_uri',
          message: `Unsupported root URI: ${root.uri}`,
        });
        continue;
      }

      let resolvedPath: string;
      try {
        resolvedPath = path.resolve(parsedPath);
        assertPathInsideWorkspace(this.workspaceRealPath, resolvedPath, 'root');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectedRoots.push({
          uri: root.uri,
          reason: 'outside_workspace',
          message,
        });
        continue;
      }

      if (!fs.existsSync(resolvedPath)) {
        rejectedRoots.push({
          uri: root.uri,
          reason: 'outside_workspace',
          message: `Root path does not exist: ${root.uri}`,
        });
        continue;
      }

      try {
        const safeRoot = resolveRealPathInsideWorkspace(this.workspacePath, resolvedPath, 'root');
        acceptedRoots.push(safeRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectedRoots.push({
          uri: root.uri,
          reason: 'symlink_escape',
          message,
        });
      }
    }

    this.allowedRoots = dedupeRoots(acceptedRoots);
    this.enforcementActive = true;

    return {
      accepted: true,
      allowedRoots: this.allowedRoots,
      rejectedRoots,
    };
  }

  isAbsolutePathAllowed(candidatePath: string): boolean {
    if (!this.enforcementActive) {
      return true;
    }

    if (this.allowedRoots.length === 0) {
      return false;
    }

    let resolvedCandidate: string;
    try {
      resolvedCandidate = path.resolve(candidatePath);
      assertPathInsideWorkspace(this.workspaceRealPath, resolvedCandidate, 'path');
    } catch {
      return false;
    }

    if (!fs.existsSync(resolvedCandidate)) {
      return this.allowedRoots.some((root) => isPathInsideRoot(root, resolvedCandidate));
    }

    try {
      const safeCandidate = resolveRealPathInsideWorkspace(this.workspacePath, resolvedCandidate, 'path');
      return this.allowedRoots.some((root) => isPathInsideRoot(root, safeCandidate));
    } catch {
      return false;
    }
  }

  isRelativePathAllowed(relativePath: string): boolean {
    const resolved = path.resolve(this.workspacePath, relativePath.replace(/\\/g, '/'));
    return this.isAbsolutePathAllowed(resolved);
  }

  filterAllowedRelativePaths(relativePaths: readonly string[]): string[] {
    if (!this.enforcementActive) {
      return [...relativePaths];
    }
    return relativePaths.filter((relativePath) => this.isRelativePathAllowed(relativePath));
  }

  getAllowedRootsForPolicy(): readonly string[] | undefined {
    return this.enforcementActive ? this.allowedRoots : undefined;
  }
}

export type AttachRootsHandlersOptions = {
  onRootsUpdated?: (result: RootsUpdateResult) => void;
  log?: (message: string) => void;
};

export async function refreshRootsFromClient(
  server: Pick<Server, 'listRoots'>,
  rootsManager: RootsManager
): Promise<RootsUpdateResult | null> {
  if (!rootsManager.isRootsSupported()) {
    return null;
  }

  const result = await server.listRoots();
  return rootsManager.updateRoots(result.roots ?? []);
}

export function attachRootsHandlers(
  server: Server,
  rootsManager: RootsManager,
  options?: AttachRootsHandlersOptions
): void {
  const log = options?.log ?? ((message: string) => console.error(message));
  let listChangedHandlerRegistered = false;

  server.oninitialized = async () => {
    rootsManager.configureFromClientCapabilities(server.getClientCapabilities());
    if (!rootsManager.isRootsSupported()) {
      return;
    }

    if (rootsManager.isListChangedSupported() && !listChangedHandlerRegistered) {
      server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
        if (!rootsManager.isRootsSupported()) {
          return;
        }

        try {
          const updateResult = await refreshRootsFromClient(server, rootsManager);
          if (updateResult) {
            options?.onRootsUpdated?.(updateResult);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[roots] Failed to refresh client roots: ${message}`);
        }
      });
      listChangedHandlerRegistered = true;
    }

    try {
      const updateResult = await refreshRootsFromClient(server, rootsManager);
      if (updateResult) {
        options?.onRootsUpdated?.(updateResult);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[roots] Failed to list client roots during initialization: ${message}`);
    }
  };
}
