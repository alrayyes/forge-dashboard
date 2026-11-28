// The API's request and response shapes, by their schema name in
// api/openapi.yaml. Don't write a copy of one by hand (#5182).
import type { components } from './api-schema.js';

export type Schema<Name extends keyof components['schemas']> =
  components['schemas'][Name];
