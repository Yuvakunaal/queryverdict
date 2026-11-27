import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createEngineRuntime } from './app/bootstrap';
import { DEFAULT_PROFILE, validateProfile } from './core/profile/profile';
import { ConfigurationError } from './core/util/errors';
import { browserDarkSchemeQuery, createUiPrefsStore } from './stores/uiPrefsStore';
import { createWorkspaceStore } from './stores/workspaceStore';
import './styles/tokens.css';
import './styles/base.css';
import './styles/explorer.css';
import './styles/workspace.css';

// Singletons are created once per page, outside React, so StrictMode's double mount cannot
// create duplicates (docs/ARCHITECTURE.md §6.2).
const root = document.getElementById('root');
if (!root) throw new ConfigurationError('Missing #root element');

const problems = validateProfile(DEFAULT_PROFILE);
if (problems.length) {
  // Developer misconfiguration: fail visibly instead of running with unsafe limits.
  createRoot(root).render(
    <div role="alert" className="error-panel">
      <p>QueryVerdict cannot start: the release profile is invalid.</p>
      <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>,
  );
} else {
  const prefs = createUiPrefsStore(browserDarkSchemeQuery());
  const runtime = createEngineRuntime(DEFAULT_PROFILE);
  const workspace = createWorkspaceStore();
  runtime.start();
  createRoot(root).render(
    <StrictMode>
      <App prefs={prefs} runtime={runtime} workspace={workspace} />
    </StrictMode>,
  );
}
