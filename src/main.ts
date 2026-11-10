import './style.css';
import { App } from './app';
import { createBackend } from './backend';

const backend = await createBackend();
await new App(document.getElementById('app')!, backend).init();
