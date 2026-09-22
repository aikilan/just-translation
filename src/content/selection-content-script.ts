import { initializeContentLanguage } from './ui-language';
import type { PageCommand } from '../shared/messages';
import { SelectionTranslationController, captureSelectionAnchor } from './selection-translation';
import type { SelectionAnchor } from './selection-translation-view';

const controller = new SelectionTranslationController();
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
  if (anchor) controller.start(command.text, anchor);
  respond({ ok: Boolean(anchor) });
});

initializeContentLanguage();
