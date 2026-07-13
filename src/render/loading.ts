export async function loadWithFallback<T>(
  load: () => Promise<T>,
  fallback: () => T,
  onFailure?: (error: unknown) => void,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    onFailure?.(error);
    return fallback();
  }
}
