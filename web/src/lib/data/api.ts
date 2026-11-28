// The API's request and response shapes, by their schema name in
// api/openapi.yaml. Don't write a copy of one by hand (#5182).
import type { components } from './api-schema.js';

export type Schema<Name extends keyof components['schemas']> =
  components['schemas'][Name];

// For code that checks every value before using it: the contract's field
// names, so a rename fails the type check, with nothing promised about what
// arrived under them.
export type Unchecked<Name extends keyof components['schemas']> = Partial<
  Record<keyof Schema<Name>, unknown>
>;
