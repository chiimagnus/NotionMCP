// tools/index.mjs
// Aggregates every tool module into a single registry: the list of tool
// definitions for tools/list, and a name -> handler map for tools/call.
// To add a new tool: create tools/<name>.mjs exporting { name, definition,
// call }, then add it to the imports/array below.

import * as runCommand from "./run_command.mjs"
import * as readImage from "./read_image.mjs"
import * as applyPatch from "./apply_patch.mjs"

const modules = [runCommand, readImage, applyPatch]

export const definitions = modules.map((m) => m.definition)

export const handlers = Object.fromEntries(modules.map((m) => [m.name, m.call]))
