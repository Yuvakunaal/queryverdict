// TEST-ONLY entry (P-022). Exposes fault-injection fixtures for browser tests. This file and
// everything it imports are excluded from the production artifact (scripts/check-artifact.mjs).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../src/app/ErrorBoundary';
import '../src/styles/tokens.css';
import '../src/styles/base.css';

/** Module-level fault switch, flipped by the fixture buttons (test-only). */
const fault = { broken: false };

/** Throws during render while the fault is on, then renders normally. */
function Flaky({ version }: { version: number }) {
  if (fault.broken) throw new Error('injected render failure');
  return <p>Fixture content rendered ({version})</p>;
}

function ErrorBoundaryFixture() {
  const [version, setVersion] = useState(0);
  return (
    <section aria-label="Error boundary fixture">
      <button type="button" onClick={() => { fault.broken = true; setVersion((n) => n + 1); }}>Break view</button>
      <button type="button" onClick={() => { fault.broken = false; }}>Heal view</button>
      <ErrorBoundary label="Fixture region">
        <Flaky version={version} />
      </ErrorBoundary>
      <p>Surrounding content</p>
    </section>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundaryFixture />
    </StrictMode>,
  );
}
document.body.dataset.harnessReady = 'true';
