/** Return the wrapped focus target for a modal Tab press, or null for native movement. */
export function wrappedDialogFocusIndex(currentIndex: number, focusableCount: number, backwards: boolean): number | null {
  if (focusableCount <= 0) return null;
  if (backwards && currentIndex <= 0) return focusableCount - 1;
  if (!backwards && (currentIndex < 0 || currentIndex >= focusableCount - 1)) return 0;
  return null;
}
