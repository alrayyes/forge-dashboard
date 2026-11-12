// Package memlimit reads the container's cgroup memory limit and, when the
// operator has not set GOMEMLIMIT, gives the Go runtime a soft limit just under
// it. Without one the garbage collector only runs when the heap doubles, which
// is how a 64 MiB container ends up OOM-killed during the first full refresh
// (#3554).
package memlimit

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
)

// softLimitPercent is how much of the cgroup limit the Go heap may use. The
// rest is headroom for stacks, cgo-free runtime overhead and the SQLite pages
// the soft limit does not count.
const softLimitPercent = 90

// cgroupRoot is where a container sees its own cgroup.
const cgroupRoot = "/sys/fs/cgroup"

// v1Unlimited is the page-rounded "no limit" value cgroup v1 reports. Anything
// at or above half of the int64 range is treated as no limit.
const v1Unlimited = math.MaxInt64 / 2

// Report says what Apply found and did, for the first log line.
type Report struct {
	// CgroupBytes is the cgroup limit, 0 when there is none.
	CgroupBytes int64
	// GoBytes is the soft limit in force after Apply, math.MaxInt64 when none.
	GoBytes int64
	// AutoSet is true when Apply derived GoBytes from the cgroup limit.
	AutoSet bool
}

// CgroupLimit reads the memory limit under root, trying cgroup v2 then v1.
// It reports false when there is no limit or the file is unreadable.
func CgroupLimit(root string) (int64, bool) {
	for _, rel := range []string{"memory.max", filepath.Join("memory", "memory.limit_in_bytes")} {
		raw, err := os.ReadFile(filepath.Join(root, rel)) //nolint:gosec // root is the cgroup mount or a test directory, rel a constant
		if err != nil {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		if err != nil || n <= 0 || n >= v1Unlimited {
			return 0, false
		}

		return n, true
	}

	return 0, false
}

// SoftLimit is the Go soft limit to set: 90% of the cgroup limit, when there is
// one and GOMEMLIMIT (goMemLimitEnv) is unset. An operator's own value wins.
func SoftLimit(cgroup int64, hasCgroup bool, goMemLimitEnv string) (int64, bool) {
	if !hasCgroup || goMemLimitEnv != "" {
		return 0, false
	}

	// Split so a limit near the int64 range cannot overflow the multiply.
	return cgroup/100*softLimitPercent + cgroup%100*softLimitPercent/100, true
}

// Apply detects the cgroup limit and sets the Go soft limit by the rule in
// SoftLimit.
func Apply() Report {
	return apply(cgroupRoot, os.Getenv, debug.SetMemoryLimit)
}

func apply(root string, getenv func(string) string, setLimit func(int64) int64) Report {
	cg, has := CgroupLimit(root)
	r := Report{CgroupBytes: cg}
	if soft, ok := SoftLimit(cg, has, getenv("GOMEMLIMIT")); ok {
		setLimit(soft)
		r.AutoSet = true
	}
	r.GoBytes = setLimit(-1)

	return r
}

// Attrs are the slog attributes for the first log line.
func (r Report) Attrs() []any {
	source := "default"
	switch {
	case r.AutoSet:
		source = "cgroup-90pct"
	case r.GoBytes != math.MaxInt64:
		source = "GOMEMLIMIT"
	}

	return []any{
		"cgroupMemoryLimit", format(r.CgroupBytes),
		"goMemoryLimit", format(r.GoBytes),
		"goMemoryLimitSource", source,
	}
}

func format(n int64) string {
	if n <= 0 || n == math.MaxInt64 {
		return "none"
	}

	return fmt.Sprintf("%dMiB", n>>20)
}
