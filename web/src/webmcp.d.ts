// Augments the ambient DOM types with WebMCP's document.modelContext --
// not yet part of lib.dom.d.ts (the spec is still an Origin Trial as of
// this writing). A triple-slash reference here, not "types" in
// tsconfig.json's compilerOptions: setting that array replaces the
// default "include everything under @types" behavior rather than adding
// to it, which would drop @types/node.
/// <reference types="webmcp-types" />
