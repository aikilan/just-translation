import { beforeEach } from 'vitest';
import { setUiLanguage } from '../shared/i18n';
// Existing behavior tests use Chinese; locale-specific tests explicitly choose another language.
beforeEach(() => setUiLanguage('zh-CN'));
