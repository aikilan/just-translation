import { initializeContentLanguage } from './ui-language';
import { sendRuntimeMessage } from '../shared/chrome-api';
import type { PageCommand, PublicTranslatorSettings } from '../shared/messages';
import { SelectionIcon } from './selection-icon';
import { SelectionTranslationController, captureSelectionAnchor } from './selection-translation';
import type { SelectionAnchor } from './selection-translation-view';

const controller = new SelectionTranslationController();
const icon = new SelectionIcon(
  () => sendRuntimeMessage<PublicTranslatorSettings>({ type: 'GET_PUBLIC_SETTINGS' }),
  ({ text, anchor, translator }) => controller.start(text, anchor, translator),
);
let anchor: SelectionAnchor | undefined;
document.addEventListener(
  'contextmenu',
  (event) => {
    const target = event.composedPath().find((node): node is Element => node instanceof Element);
    if (target) anchor = captureSelectionAnchor(event, target);
  },
  { capture: true },
);

// Only this listener responds to selection commands; the page controller owns all other commands.
chrome.runtime.onMessage.addListener((command: PageCommand, _sender, respond) => {
  if (command.type !== 'START_SELECTION_TRANSLATION') return;
  icon.hide();
  if (anchor) controller.start(command.text, anchor, command.translator);
  respond({ ok: Boolean(anchor) });
});

initializeContentLanguage();
