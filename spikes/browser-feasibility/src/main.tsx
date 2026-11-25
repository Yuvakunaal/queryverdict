import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './spike.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
