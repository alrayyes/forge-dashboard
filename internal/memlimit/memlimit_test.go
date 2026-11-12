package memlimit

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCgroupLimit(t *testing.T) {
	tests := []struct {
		name   string
		files  map[string]string
		want   int64
		wantOK bool
	}{
		{"v2 limit", map[string]string{"memory.max": "67108864\n"}, 67108864, true},
		{"v2 unlimited", map[string]string{"memory.max": "max\n"}, 0, false},
		{"v1 limit", map[string]string{"memory/memory.limit_in_bytes": "134217728\n"}, 134217728, true},
		{"v1 unlimited", map[string]string{"memory/memory.limit_in_bytes": "9223372036854771712\n"}, 0, false},
		{"no cgroup files", nil, 0, false},
		{"garbage", map[string]string{"memory.max": "lots"}, 0, false},
		{"zero", map[string]string{"memory.max": "0"}, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			for rel, c := range tt.files {
				writeFile(t, root, rel, c)
			}
			got, ok := CgroupLimit(root)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("CgroupLimit = %d, %v; want %d, %v", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

// The rule from #3554: with a cgroup limit and no GOMEMLIMIT, the Go soft
// limit is 90% of the cgroup limit.
func TestSoftLimit(t *testing.T) {
	tests := []struct {
		name        string
		cgroup      int64
		hasCgroup   bool
		env         string
		want        int64
		wantApplied bool
	}{
		{"90 percent of 64 MiB", 64 << 20, true, "", 60397977, true},
		{"90 percent of 1 GiB", 1 << 30, true, "", 966367641, true},
		{"GOMEMLIMIT set wins", 64 << 20, true, "40MiB", 0, false},
		{"no cgroup limit", 0, false, "", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, applied := SoftLimit(tt.cgroup, tt.hasCgroup, tt.env)
			if got != tt.want || applied != tt.wantApplied {
				t.Fatalf("SoftLimit = %d, %v; want %d, %v", got, applied, tt.want, tt.wantApplied)
			}
		})
	}
}

func TestApplySetsAndReports(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "memory.max", "67108864\n")
	var set int64 = -2 // -2: never set
	r := apply(root, func(string) string { return "" }, func(n int64) int64 {
		if n >= 0 {
			set = n
		}
		if set >= 0 {
			return set
		}

		return math.MaxInt64
	})
	if set != 60397977 {
		t.Fatalf("soft limit set = %d, want 60397977", set)
	}
	if r.CgroupBytes != 67108864 || r.GoBytes != 60397977 || !r.AutoSet {
		t.Fatalf("report = %+v", r)
	}
}

func TestApplyLeavesGOMEMLIMITAlone(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "memory.max", "67108864\n")
	called := false
	r := apply(root, func(k string) string {
		if k == "GOMEMLIMIT" {
			return "40MiB"
		}

		return ""
	}, func(n int64) int64 {
		if n >= 0 {
			called = true
		}

		return 40 << 20
	})
	if called || r.AutoSet || r.GoBytes != 40<<20 {
		t.Fatalf("called=%v report=%+v", called, r)
	}
}

func TestReportAttrs(t *testing.T) {
	r := Report{CgroupBytes: 67108864, GoBytes: 60397977, AutoSet: true}
	got := r.Attrs()
	want := []any{"cgroupMemoryLimit", "64MiB", "goMemoryLimit", "57MiB", "goMemoryLimitSource", "cgroup-90pct"}
	if len(got) != len(want) {
		t.Fatalf("attrs = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attrs[%d] = %v, want %v", i, got[i], want[i])
		}
	}
	none := Report{GoBytes: math.MaxInt64}.Attrs()
	if none[1] != "none" || none[3] != "none" || none[5] != "default" {
		t.Fatalf("unlimited attrs = %v", none)
	}
}
