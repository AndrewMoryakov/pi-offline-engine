// A tool whose parameters are `{ type: "object", anyOf: [...] }` with no
// top-level `properties` loses every argument through ik_llama.cpp's tool-call
// parser: the model writes `<parameter=path>...` correctly, and the server
// returns `arguments: {}`. pi-lean-edit's edit schema has exactly that shape,
// so a local model behind llama-server could never call it.
//
// flattenObjectUnion merges the variants into one object schema: every
// property any variant declares, and as required only what all of them
// require. Array items are flattened the same way. The result accepts
// combinations no single variant allowed; the tool has to reject those at run
// time, which pi-lean-edit does (normalizeEdits).
// Spec: docs/HYBRID_EDIT_V0.md HE-11.
export function flattenObjectUnion(schema) {
  if (!isObject(schema)) return schema;
  let result = schema;
  if (Array.isArray(schema.anyOf) && schema.properties === undefined && schema.anyOf.every(isObjectVariant)) {
    const { anyOf, ...rest } = schema;
    const properties = {};
    for (const variant of anyOf) {
      for (const [key, value] of Object.entries(variant.properties ?? {})) {
        if (!(key in properties)) properties[key] = value;
      }
    }
    const required = anyOf
      .map((variant) => new Set(variant.required ?? []))
      .reduce((common, set) => new Set([...common].filter((key) => set.has(key))));
    result = { ...rest, type: "object", properties, required: [...required] };
    if (anyOf.every((variant) => variant.additionalProperties === false)) result.additionalProperties = false;
  }
  if (isObject(result.properties)) {
    result = {
      ...result,
      properties: Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, flattenObjectUnion(value)]))
    };
  }
  if (isObject(result.items)) result = { ...result, items: flattenObjectUnion(result.items) };
  return result;
}

// pi-lean-edit registers `edit` with the union schema; hand the model the flat
// one under whatever name the tool ends up with.
export function flattenLeanEditTool(tool) {
  if (!tool || tool.name !== "edit" || !isObject(tool.parameters)) return tool;
  return { ...tool, parameters: flattenObjectUnion(tool.parameters) };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectVariant(variant) {
  return isObject(variant) && (variant.type === undefined || variant.type === "object") && isObject(variant.properties ?? {});
}
