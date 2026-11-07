import React from 'react';
import { createRoot } from 'react-dom/client';
import Panel from './Panel.jsx';
import { applyTheme } from './lib.jsx';
import './index.css';
import './cloud.css';

applyTheme();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>
);
