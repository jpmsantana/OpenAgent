export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  );
}

export function isAbortOrTimeoutError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return false;
  }
  const name = (err as { name: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export function rethrowIfAbort(err: unknown, signal?: AbortSignal): void {
  if (isAbortError(err)) {
    throw err;
  }
  signal?.throwIfAborted();
}
