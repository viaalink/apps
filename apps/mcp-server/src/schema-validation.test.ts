/**
 * MCP Tool Schema Validation
 *
 * Prevents regressions like z.array(z.any()) which generates JSON Schema
 * without an `items` field — causing MCP clients to reject the schema.
 *
 * Two layers:
 *   1. Static source scan: bans known-bad Zod patterns in server.ts
 *   2. Dynamic schema check: validates generated JSON Schema structure
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const SERVER_PATH = join(import.meta.dir, "server.ts");

// ---------------------------------------------------------------------------
// 1. Static source analysis — ban patterns that produce invalid JSON Schema
// ---------------------------------------------------------------------------
describe("static source analysis", () => {
  const source = readFileSync(SERVER_PATH, "utf8");

  test("no z.array(z.any()) — produces array schema without items", () => {
    const matches = source.match(/z\.array\(\s*z\.any\(\)\s*\)/g);
    expect(matches).toBeNull();
  });

  test("no z.tuple() without elements — produces array schema without items", () => {
    const matches = source.match(/z\.tuple\(\s*\[\s*\]\s*\)/g);
    expect(matches).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Dynamic schema validation — verify JSON Schema structure is MCP-compliant
// ---------------------------------------------------------------------------

/**
 * Recursively walk a JSON Schema and collect violations.
 * MCP clients require:
 *   - type:array MUST have `items`
 *   - type:object MUST have `properties` or `additionalProperties`
 */
function validateJsonSchema(schema: any, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;

  // Check array without items
  if (schema.type === "array" && !("items" in schema)) {
    errors.push(`${path}: type=array missing 'items'`);
  }

  // Recurse into composite structures
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      errors.push(...validateJsonSchema(value, `${path}.${key}`));
    }
  }
  if (schema.items) {
    errors.push(...validateJsonSchema(schema.items, `${path}.items`));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    errors.push(...validateJsonSchema(schema.additionalProperties, `${path}.additionalProperties`));
  }
  if (schema.anyOf) {
    for (let i = 0; i < schema.anyOf.length; i++) {
      errors.push(...validateJsonSchema(schema.anyOf[i], `${path}.anyOf[${i}]`));
    }
  }
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++) {
      errors.push(...validateJsonSchema(schema.oneOf[i], `${path}.oneOf[${i}]`));
    }
  }
  if (schema.allOf) {
    for (let i = 0; i < schema.allOf.length; i++) {
      errors.push(...validateJsonSchema(schema.allOf[i], `${path}.allOf[${i}]`));
    }
  }

  return errors;
}

describe("JSON Schema compliance", () => {
  test("z.array(z.any()) is invalid — baseline sanity check", () => {
    const schema = zodToJsonSchema(z.array(z.any()));
    const errors = validateJsonSchema(schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("missing 'items'");
  });

  test("z.array(z.record(z.string(), z.any())) is valid — fixed pattern", () => {
    const schema = zodToJsonSchema(z.array(z.record(z.string(), z.any())));
    const errors = validateJsonSchema(schema);
    expect(errors).toEqual([]);
  });

  // Reproduce all tool input schemas from server.ts to verify they're valid.
  // These mirror the actual schemas in createMcpServer() — if server.ts changes,
  // update these too (the static check above catches the common failure mode).
  const toolSchemas: Record<string, z.ZodType> = {
    n8n_create_workflow: z.object({
      name: z.string(),
      nodes: z.array(z.record(z.string(), z.any())).optional(),
      connections: z.record(z.string(), z.any()).optional(),
    }),
    n8n_update_workflow: z.object({
      id: z.string(),
      name: z.string().optional(),
      nodes: z.array(z.record(z.string(), z.any())).optional(),
      connections: z.record(z.string(), z.any()).optional(),
      active: z.boolean().optional(),
    }),
    n8n_trigger_workflow: z.object({
      id: z.string(),
      data: z.record(z.any()).optional(),
    }),
  };

  for (const [name, zodSchema] of Object.entries(toolSchemas)) {
    test(`tool ${name} produces valid JSON Schema`, () => {
      const schema = zodToJsonSchema(zodSchema);
      const errors = validateJsonSchema(schema);
      expect(errors).toEqual([]);
    });
  }
});
