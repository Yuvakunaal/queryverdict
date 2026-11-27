import { createRoot } from 'react-dom/client';
import { ready, sampleSql } from './doc';
function App() { return <textarea aria-label="SQL editor" defaultValue={sampleSql()} rows={20} cols={80} />; }
createRoot(document.getElementById('root')!).render(<App />);
const ta = () => document.querySelector('textarea') as HTMLTextAreaElement;
ready({ get: () => ta().value, caret: () => ta().selectionStart, toEnd: () => { ta().focus(); ta().setSelectionRange(ta().value.length, ta().value.length); } });
