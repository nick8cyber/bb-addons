/**
 * bb-plugin-pi-gateways — frontend entry.
 *
 * Registers the "Pi Gateways" settings section where gateways are listed,
 * probed, added and removed without touching JSON by hand.
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PiGatewaysSection } from "./src/PiGatewaysSection.js";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "pi-gateways",
    title: "Pi Gateways",
    description: "OpenCode Zen, Kilo Code and your own OpenAI-compatible endpoints served through the pi provider.",
    component: PiGatewaysSection,
  });
});
