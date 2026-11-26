// TEST-ONLY entry (P-022). Exposes fault-injection fixtures for browser tests. This file and
// everything it imports are excluded from the production artifact (scripts/check-artifact.mjs).
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/app/App';
import { ErrorBoundary } from '../src/app/ErrorBoundary';
import { browserDarkSchemeQuery, createUiPrefsStore } from '../src/stores/uiPrefsStore';
import { engineHarness, faults, FaultyDriver } from './engine';
import './datasets';
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
const view = new URLSearchParams(location.search).get('view');
if (root && view === 'app-faulty') {
  // The production App on a runtime whose first boot fails a lockdown statement (Retry test).
  faults.failStatement = 'SET enable_external_access = false';
  const runtime = engineHarness.createEngineRuntime(engineHarness.DEFAULT_PROFILE, new FaultyDriver());
  runtime.start();
  createRoot(root).render(
    <StrictMode>
      <App prefs={createUiPrefsStore(browserDarkSchemeQuery())} runtime={runtime} />
    </StrictMode>,
  );
} else if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundaryFixture />
    </StrictMode>,
  );
}
document.body.dataset.harnessReady = 'true';
