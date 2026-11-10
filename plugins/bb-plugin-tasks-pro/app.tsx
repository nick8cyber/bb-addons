/**
 * bb-plugin-tasks-pro — Frontend entry.
 *
 * Registers the "Tasks Pro" navigation panel: an advanced read-only task
 * browser (toolbar filters, sortable grouped table, kanban, task drawer,
 * saved views). All data flows through this plugin's own RPC contract in
 * ./server; no mutations are performed anywhere.
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TasksProPanel } from "./src/TasksProPanel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "explorer",
    title: "Tasks Pro",
    icon: "ListTodo",
    path: "explorer",
    component: TasksProPanel,
  });
});
