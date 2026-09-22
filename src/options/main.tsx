import { getSettings } from '../shared/settings-store';
import { setUiLanguage } from '../shared/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OptionsApp } from './options-app';
import '../ui/base.css';
import './options.css';

const root = document.querySelector('#root');
if (!root) throw new Error('Options root element is missing');

void getSettings()
  .then((settings) => setUiLanguage(settings.uiLanguage))
  .catch(() => {})
  .then(() => {
    createRoot(root).render(
      <StrictMode>
        <OptionsApp />
      </StrictMode>,
    );
  });
