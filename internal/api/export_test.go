package api

// What the external tests (package api_test) may reach of the package's
// unexported parsers, for fuzzing them without widening the real API.
var (
	RepoFromPayload = repoFromPayload
	ValidSignature  = validSignature

	NewStaticHandler = newStaticHandler
)
