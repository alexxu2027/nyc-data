// Conductor-owned (plan §7.1).
import '@fontsource/source-code-pro/400.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/index.css';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
