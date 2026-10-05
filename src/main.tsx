import { render } from 'solid-js/web';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/fraunces';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { audio, project, samples, ui } from './store/app';

const root = document.getElementById('root')!;
if (!('AudioWorkletNode' in window)) {
  root.innerHTML =
    '<p style="padding:2rem;font-family:sans-serif;color:#ede6d6;background:#1f1e1c">AFTERIMAGE needs a browser with AudioWorklet support (recent Chrome, Edge or Firefox).</p>';
} else {
  render(() => <App />, root);
  // Test hook for the Playwright suite (development builds only).
  if (import.meta.env.DEV) (window as any).__afterimage = { project, samples, audio, ui };
}
