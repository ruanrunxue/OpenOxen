import type { RegisteredTool, ToolDefinition, ToolRegistry } from "./types.ts";

function validateSchema(definition: ToolDefinition): void {
  const rootType = (definition.parameters as { type?: string })?.type;
  if (rootType && rootType !== "object") {
    throw new Error(`Tool schema for ${definition.name} must use object root`);
  }
}

export class DefaultToolRegistry implements ToolRegistry {
  #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    validateSchema(tool.definition);
    this.#tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((t) => t.definition);
  }

  names(): string[] {
    return [...this.#tools.keys()];
  }
}

export function validateToolArguments(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): { valid: boolean; error?: string } {
  const schema = definition.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in args)) {
      return { valid: false, error: `Missing required argument: ${key}` };
    }
  }
  if (schema.properties) {
    for (const [key, value] of Object.entries(args)) {
      const expected = schema.properties[key]?.type;
      if (!expected) {
        continue;
      }
      if (expected === "integer" && typeof value !== "number") {
        return { valid: false, error: `Argument ${key} must be integer` };
      }
      if (expected === "string" && typeof value !== "string") {
        return { valid: false, error: `Argument ${key} must be string` };
      }
      if (expected === "boolean" && typeof value !== "boolean") {
        return { valid: false, error: `Argument ${key} must be boolean` };
      }
      if (expected === "object" && (typeof value !== "object" || value === null)) {
        return { valid: false, error: `Argument ${key} must be object` };
      }
    }
  }
  return { valid: true };
}

