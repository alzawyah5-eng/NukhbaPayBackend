const maxBodyBytes = 2 * 1024 * 1024;
const exactNumber = Symbol('catalogue wire number');

export function wireNumber(value: unknown): string | undefined {
  return (value as { readonly [exactNumber]?: string } | null | undefined)?.[exactNumber];
}

export function withinCatalogueDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readCatalogueJson(response: Response, signal: AbortSignal, fields: ReadonlySet<string>, invalid: () => Error): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !response.body ||
      contentLength !== null && (!/^\d{1,10}$/.test(contentLength) || Number(contentLength) > maxBodyBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await withinCatalogueDeadline(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBodyBytes || chunks.length >= 4096) throw invalid();
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      (key, value: unknown, context?: { source: string }) => fields.has(key) && typeof value === 'number' && context
        ? { [exactNumber]: context.source } : value) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}
