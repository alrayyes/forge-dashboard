package api

import (
	"net/http"
	"unicode/utf8"
)

// The bounds api/openapi.yaml states as maxLength and maximum on each request
// schema (#1008, OWASP API4). They are generous for real values and small
// enough that no field can fill the database; request_field_limits_test.go
// sends the spec's own numbers, so a change to one side fails there.
const (
	maxUsernameLen     = 64
	maxDisplayNameLen  = 100
	maxInviteTokenLen  = 256
	maxForgeTokenLen   = 512
	maxForgeURLLen     = 2048
	maxLabelLen        = 100
	maxTimezoneLen     = 64
	maxRepoFullNameLen = 255

	// maxPullRequestNumber is the largest int32: no forge numbers a pull
	// request higher.
	maxPullRequestNumber = 2147483647
	// maxInstallationID is the largest integer a JSON number carries exactly
	// in a browser.
	maxInstallationID = 9007199254740991
)

// bound is one string a request carried, and the longest it may be.
type bound struct {
	field string
	value string
	max   int
}

// overBound answers 400 naming the first of bounds whose value is over its
// limit, and reports whether it did. Length counts characters, as the spec's
// maxLength does.
func overBound(w http.ResponseWriter, bounds ...bound) bool {
	for _, b := range bounds {
		if utf8.RuneCountInString(b.value) > b.max {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody(b.field, b.field+" is too long"))

			return true
		}
	}

	return false
}
