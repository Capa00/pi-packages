import { keys } from "./validation.mjs";

export const toolPermissionNames = ["readFiles", "writeFiles", "executeCommands"];
export const deniedToolPermissions = () => Object.fromEntries(toolPermissionNames.map((name) => [name, false]));

// These are tool-selection permissions, not an OS sandbox. In particular, bash
// can read/write files and access credentials using the service account's rights.
export function validateToolPermissions(value) {
  if (value === undefined) return deniedToolPermissions();
  keys(value, toolPermissionNames, "Pi: tool permissions");
  for (const name of toolPermissionNames) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      throw new Error("Pi: tool permissions must be booleans.");
    }
  }
  return Object.fromEntries(toolPermissionNames.map((name) => [name, value[name] === true]));
}

export function permittedToolNames(value) {
  const permissions = validateToolPermissions(value);
  return [
    ...(permissions.readFiles ? ["read", "grep", "find", "ls"] : []),
    ...(permissions.writeFiles ? ["write", "edit"] : []),
    ...(permissions.executeCommands ? ["bash"] : []),
  ];
}
