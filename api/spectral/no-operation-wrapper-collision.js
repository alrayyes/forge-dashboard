// oapi-codegen (client mode) emits a response wrapper type named
// <PascalCase operationId> + Response. A schema with the same
// name makes the generated file declare it twice (#4943).
// Request bodies are aliased as <Op>JSONRequestBody, so <Op>Request schemas are safe.
const SUFFIXES = ['Response'];

const pascal = (id) => id.charAt(0).toUpperCase() + id.slice(1);

module.exports = (schemas, _opts, context) => {
  const paths = context.document.data.paths ?? {};
  const taken = new Set();
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item ?? {})) {
      if (op && typeof op === 'object' && typeof op.operationId === 'string') {
        for (const s of SUFFIXES) taken.add(pascal(op.operationId) + s);
      }
    }
  }
  const results = [];
  for (const name of Object.keys(schemas ?? {})) {
    if (taken.has(name)) {
      results.push({
        message: `Schema "${name}" collides with the generated wrapper type for an operation. Rename the schema (#4943).`,
        path: [...context.path, name],
      });
    }
  }
  return results;
};
