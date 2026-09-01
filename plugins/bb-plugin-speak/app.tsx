/**
 * The plugin's frontend: one button on every chat message, and the settings
 * section behind it.
 *
 * Both halves talk to the server through `lib/rpc.ts` rather than `useRpc()`,
 * because a `messageAction`'s `run` is a plain callback with no component
 * around it to hold a hook. bb supplies React, the SDK and `sonner`; this file
 * is bundled into dist/app.js by `bb plugin build`.
 */

import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { SpeakSection } from "./src/SpeakSection.js";
import { mountSpeakOverlay } from "./src/SpeakOverlay.js";
import { player } from "./src/player.js";

function syncButtonState(stage: string) {
  if (typeof document === "undefined") return;
  const buttons = document.querySelectorAll(
    'button:has([data-plugin-icon-asset*="speak"]), button[title="Read aloud"]',
  );
  buttons.forEach((btn) => {
    if (stage === "idle") {
      btn.removeAttribute("data-speak-state");
    } else {
      btn.setAttribute("data-speak-state", stage);
    }
  });
}

if (typeof window !== "undefined") {
  player.subscribe((state) => {
    syncButtonState(state.stage);
  });
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "speak-overlay",
    mount: mountSpeakOverlay,
  });

  app.slots.messageAction({
    id: "speak",
    title: "Read aloud",
    // Only the text-selection menu reads this name; bb's icon set has no
    // speaker, so `Play` is the nearest thing there. The button in the action
    // bar ignores it entirely and masks this plugin's own branding SVG
    // (`icons/speak.svg`) into a 12px span — which is where the speaker
    // actually comes from, and why that file is drawn for 12px.
    icon: "Play",
    run: (context) => {
      // The action appears on user messages too. The SDK offers no predicate
      // to limit a messageAction to one role, and reading your own prompt
      // back is a coherent thing to want, so this is left as it is.
      void player.speak({
        // Selection wins when there is one: highlighting a paragraph and
        // invoking the action should read the paragraph, not the message.
        text: context.selectedText ?? context.message.text,
        // Keyed on the message either way, so a second click stops the
        // playback the first one started, selection or not.
        messageId: context.message.id,
      });
    },
  });

  app.slots.settingsSection({
    id: "speak",
    title: "Speak",
    description:
      "Which voice reads a message aloud, how fast, and what happens when Google will not answer.",
    component: SpeakSection,
  });
});
