import './styles.css';
import { App, loadInitialSettings } from './app/App';

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  if (!document.createElement('canvas').getContext('webgl2')) {
    root.innerHTML = '<div class="fatal">Worldgen Lab needs a browser with WebGL2 support.</div>';
    return;
  }
  const { settings, source } = await loadInitialSettings();
  const app = new App(root, settings);
  // Handy for poking at the app from the devtools console.
  (window as unknown as { worldgen: App }).worldgen = app;
  if (source === 'link') app.ui.toasts.show('Loaded world from share link');
  app.ui.help.maybeShowFirstTime();
}

main().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  if (root) root.innerHTML = `<div class="fatal">Something went wrong while starting: ${String(err)}</div>`;
});
