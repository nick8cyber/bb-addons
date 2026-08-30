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
    description: "Google AI Studio, TokenRouter, OpenRouter, NVIDIA Build, OpenCode Zen, Kilo Code, and custom endpoints served through pi.",
    component: PiGatewaysSection,
  });
});
