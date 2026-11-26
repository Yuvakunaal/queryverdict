/**
 * The single persistent status region (docs/DESIGN_SYSTEM.md §5): changes are announced once,
 * politely, by replacing its text. It never receives focus.
 */
export function StatusRegion({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="status-message" style={{ margin: 0 }}>
      {message}
    </p>
  );
}
