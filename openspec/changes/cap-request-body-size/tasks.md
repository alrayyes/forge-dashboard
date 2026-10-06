## 1. The body cap

- [x] 1.1 Describe the cap in the spec
- [x] 1.2 Failing Go tests: over the cap is 413, an ordinary body passes, webhooks keep their own cap
- [x] 1.3 `limitRequestBody` at the mux

## 2. Field bounds (separate pull requests)

- [x] 2.1 `maxLength`, `maximum` and `maxItems` on every request schema, enforced with a field error
- [x] 2.2 Switch the Spectral limit rules on for request bodies
