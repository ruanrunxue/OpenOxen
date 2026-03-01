import type { SessionConfig } from "./types.ts";

const DEFAULT_LIMITS: Record<string, number> = {
  read_file: 50_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
  edit_file: 10_000,
  apply_patch: 10_000,
  write_file: 1_000,
  spawn_agent: 20_000,
};

const DEFAULT_MODES: Record<string, "head_tail" | "tail"> = {
  read_file: "head_tail",
  shell: "head_tail",
  grep: "tail",
  glob: "tail",
  edit_file: "tail",
  apply_patch: "tail",
  write_file: "tail",
  spawn_agent: "head_tail",
};

const DEFAULT_LINE_LIMITS: Record<string, number | null> = {
  shell: 256,
  grep: 200,
  glob: 500,
  read_file: null,
  edit_file: null,
  apply_patch: null,
  write_file: null,
  spawn_agent: null,
};

export function truncateOutput(output: string, maxChars: number, mode: "head_tail" | "tail"): string {
  if (output.length <= maxChars) {
    return output;
  }
  const removed = output.length - maxChars;
  if (mode === "tail") {
    return (
      `[WARNING: Tool output was truncated. First ${removed} characters were removed. ` +
      "The full output is available in the event stream.]\n\n" +
      output.slice(-maxChars)
    );
  }
  const half = Math.floor(maxChars / 2);
  return (
    output.slice(0, half) +
    `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. ` +
    "The full output is available in the event stream. If you need to see specific parts, " +
    "re-run the tool with more targeted parameters.]\n\n" +
    output.slice(-half)
  );
}

export function truncateLines(output: string, maxLines: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }
  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;
  return (
    lines.slice(0, headCount).join("\n") +
    `\n[... ${omitted} lines omitted ...]\n` +
    lines.slice(-tailCount).join("\n")
  );
}

function readLimit(config: Partial<SessionConfig> | undefined, tool: string): number {
  if (config?.tool_output_limits && tool in config.tool_output_limits) {
    return config.tool_output_limits[tool]!;
  }
  return DEFAULT_LIMITS[tool] ?? 20_000;
}

function readLineLimit(config: Partial<SessionConfig> | undefined, tool: string): number | null {
  if (config?.tool_line_limits && tool in config.tool_line_limits) {
    return config.tool_line_limits[tool] ?? null;
  }
  return DEFAULT_LINE_LIMITS[tool] ?? null;
}

export function truncateToolOutput(output: string, toolName: string, config?: Partial<SessionConfig>): string {
  const maxChars = readLimit(config, toolName);
  const mode = DEFAULT_MODES[toolName] ?? "tail";
  let result = truncateOutput(output, maxChars, mode);
  const lineLimit = readLineLimit(config, toolName);
  if (lineLimit && lineLimit > 0) {
    result = truncateLines(result, lineLimit);
  }
  return result;
}

