/**
 * The plugin's frontend: one button on every chat message, and the settings
 * section behind it.
 *
 * Both halves talk to the server through `lib/rpc.ts` rather than `useRpc()`,
 * because a `messageAction`'s `run` is a plain callback with no component
 * around it to hold a hook. bb supplies React, the SDK and `sonner`; this file
 * is bundled into dist/app.js by `bb plugin build`.
 */

import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { SpeakSection } from "./src/SpeakSection.js";
import { player } from "./src/player.js";

export default definePluginApp((app) => {
  app.slots.messageAction({
    id: "speak",
    title: "Read aloud",
    // "Play" on purpose. bb's icon set (ICON_NAMES in the app bundle) has no
    // speaker, volume or ear glyph — an unknown name does not warn, it
    // silently degrades to a generic icon, so "Volume2" would look like a
    // rendering bug rather than a typo. Check the set before changing this.
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
