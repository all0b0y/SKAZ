import { mount } from './kb/main';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// The Knowledge Wiki interface (frontend/src/kb) is the only interface.
mount(container);
