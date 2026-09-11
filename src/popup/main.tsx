import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PopupApp } from './popup-app';
import '../ui/base.css';
import './popup.css';

const root = document.querySelector('#root');
if (!root) throw new Error('Popup root element is missing');

createRoot(root).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
