import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { AgySafetySection } from "./src/AgySafetySection.js";

/**
 * The provider mark, drawn inline. Two routes exist and this is the better
 * one: `icons/agy.svg` reaches clients as a `logoUrl` and is drawn through
 * `<img>` — a separate document — while this component renders inside the app,
 * so it stays crisp and needs no fetch. bb's resolution order puts a
 * plugin-registered icon first, the vendored brand maps second, and a server
 * `logoUrl` third, so the SVG file remains the fallback for when this frontend
 * has not booted yet, is disabled, or fails to load.
 *
 * The palette is explicit rather than `currentColor`: a four-colour mark has
 * no single tint to inherit, and these mid-tone hues carry on both the light
 * and the dark theme. Original artwork — a double chevron for the upward pull
 * the name claims — not a reproduction of anyone's logo.
 */
function AntigravityIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      strokeWidth={2.4}
      strokeLinejoin="round"
    >
      <path d="M 4.11 6.27 A 9.75 9.75 0 0 1 19.89 6.27" stroke="#EA4335" strokeWidth="4.50" fill="none" strokeLinecap="butt" />
      <path d="M 19.89 6.27 A 9.75 9.75 0 0 1 20.27 17.17" stroke="#4285F4" strokeWidth="4.50" fill="none" strokeLinecap="butt" />
      <path d="M 19.68 18.00 A 9.75 9.75 0 0 1 4.01 17.59" stroke="#34A853" strokeWidth="4.50" fill="none" strokeLinecap="butt" />
      <path d="M 4.01 17.59 A 9.75 9.75 0 0 1 4.11 6.27" stroke="#FBBC05" strokeWidth="4.50" fill="none" strokeLinecap="butt" />
      <rect x="11.5" y="9.75" width="10.5" height="4.50" fill="#4285F4" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({
    providerId: "agy",
    icon: AntigravityIcon,
  });
  // The provider's own page: the two setup steps bb cannot do for the user
  // (install the CLI, sign it in on the machine that runs the turn), then
  // what a thread on agy may do once they are done. Neither belongs in the
  // picker, and neither should require reading the source.
  app.slots.settingsSection({
    id: "agy-safety",
    title: "Antigravity (agy)",
    description:
      "How to install and sign in to the agy CLI, and what a thread on this provider may do once you have.",
    component: AgySafetySection,
  });
});
