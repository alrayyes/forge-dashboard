package api

import (
	// The distroless image ships no zone database, so validating a time zone
	// name (#996) needs it compiled in.
	_ "time/tzdata"
)
