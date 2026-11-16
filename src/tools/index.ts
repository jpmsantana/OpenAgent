import { deleteFile } from "./delete-file.js";
import { grep } from "./grep.js";
import { listDir } from "./list-dir.js";
import { readFile } from "./read-file.js";
import { runCommandTool } from "./run-command.js";
import { strReplace } from "./str-replace.js";
import { writeFile } from "./write-file.js";
import type { Tool } from "./common.js";

export type { ConfirmInfo, Tool, ToolContext } from "./common.js";
export {
  GREP_MAX_FILES,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  GREP_SKIP_DIR_NAMES,
  READ_MAX_BYTES,
} from "./common.js";

export function createTools(): Tool[] {
  return [
    {
      name: "list_dir",
      description:
        "List files and directories at a path inside the workspace. Not recursive.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory relative to the workspace root. Defaults to .",
          },
        },
      },
      execute: listDir,
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the workspace. Optional offset (1-based line) and limit window the result. Fails on missing files, directories, binaries, or files larger than 262144 bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: {
            type: "number",
            description: "1-based line to start reading. Optional.",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to return. Optional.",
          },
        },
        required: ["path"],
      },
      execute: readFile,
    },
    {
      name: "grep",
      description:
        "Search workspace files for a regular expression. Returns path:line:text. Skips node_modules, .git, and dist. Caps at 50 matches. Auto-allow.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regular expression source. Not a /slash/-wrapped literal.",
          },
          path: {
            type: "string",
            description:
              "File or directory relative to the workspace root. Defaults to .",
          },
          case_insensitive: {
            type: "boolean",
            description: "If true, compile the regex with the i flag. Default false.",
          },
        },
        required: ["pattern"],
      },
      execute: grep,
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file inside the workspace. The user must approve each write. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      execute: writeFile,
    },
    {
      name: "str_replace",
      description:
        "Replace one unique literal substring in a UTF-8 file inside the workspace. old_string must match exactly once. The user must approve each replace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: {
            type: "string",
            description: "Exact substring to find. Not a regex.",
          },
          new_string: {
            type: "string",
            description: "Replacement. May be empty.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
      execute: strReplace,
    },
    {
      name: "delete_file",
      description:
        "Delete a file inside the workspace. Directories are rejected. The user must approve each delete.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      execute: deleteFile,
    },
    {
      name: "run_command",
      description:
        "Run a program in the workspace directory. argv is an array: the program and its arguments. No shell. The user must approve each command.",
      parameters: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            description:
              "Program and arguments. First element is the executable. No shell.",
          },
        },
        required: ["argv"],
      },
      execute: runCommandTool,
    },
  ];
}
