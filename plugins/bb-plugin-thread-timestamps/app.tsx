import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountTimestamps } from "./browser";
import "./app.css";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "conversation-timestamps",
    mount: mountTimestamps,
  });
});
