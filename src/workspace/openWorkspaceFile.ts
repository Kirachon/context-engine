import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { assertPathInsideWorkspace, resolveRealPathInsideWorkspace } from './pathValidation.js';

/** Open before reading, then validate the opened identity against a contained path.
 * Linux additionally validates the descriptor target. Portable checks do not
 * promise an atomic open-beneath operation against arbitrary namespace races. */
export async function openWorkspaceFile(
  workspace: string, file: string, signal?: AbortSignal
): Promise<FileHandle> {
  signal?.throwIfAborted();
  const resolved = resolveRealPathInsideWorkspace(workspace, file);
  const handle = await fs.promises.open(resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    signal?.throwIfAborted();
    const contained = resolveRealPathInsideWorkspace(workspace, resolved);
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }), fs.promises.stat(contained, { bigint: true }),
    ]);
    if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Workspace file identity changed while opening');
    }
    if (resolveRealPathInsideWorkspace(workspace, resolved) !== contained) {
      throw new Error('Workspace file target changed while opening');
    }
    if (process.platform === 'linux' && fs.existsSync('/proc/self/fd')) {
      const target = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
      assertPathInsideWorkspace(fs.realpathSync.native(workspace), target);
    }
    signal?.throwIfAborted();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Consume text through the validated handle, with the fallback's size policy. */
export async function readWorkspaceText(workspace: string, file: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const handle = await openWorkspaceFile(workspace, file, signal);
  let closed: Promise<void> | undefined;
  const close = () => closed ??= handle.close();
  const onAbort = () => { void close().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    if ((await handle.stat()).size > maxBytes) throw new Error('File too large for local retrieval');
    const text = await readBoundedText(handle, maxBytes, signal);
    signal?.throwIfAborted();
    return text;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await close();
  }
}

/** A stat snapshot is insufficient: enforce the limit even if the file grows. */
export async function readBoundedText(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid file byte limit');
  const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1));
  const chunks: Buffer[] = [];
  let used = 0;
  while (used <= maxBytes) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - used), null);
    signal?.throwIfAborted();
    if (!bytesRead) break;
    used += bytesRead;
    if (used > maxBytes) throw new Error('File too large for local retrieval');
    chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
  }
  return Buffer.concat(chunks,used).toString('utf8');
}
