package dashboard

import "time"

// ClaimKind is what a row is about to claim: a conflict flag, any other fact
// the forge reports (behind, checks, merge status, auto-merge), or whether a
// control may be offered.
type ClaimKind string

const (
	// ClaimConflict is a conflict flag.
	ClaimConflict ClaimKind = "conflict"
	// ClaimState is any other fact the forge reports.
	ClaimState ClaimKind = "state"
	// ClaimAction is whether a control may be offered.
	ClaimAction ClaimKind = "action"
)

// ClaimTrust is how far a row's claim can be trusted.
type ClaimTrust string

const (
	// ClaimConfirmed means the forge answered.
	ClaimConfirmed ClaimTrust = "confirmed"
	// ClaimCarriedOver means the forge can't be asked, so the row is an
	// earlier answer.
	ClaimCarriedOver ClaimTrust = "carried_over"
	// ClaimUnknown means the forge answered but has not said (an
	// unconfirmed conflict).
	ClaimUnknown ClaimTrust = "unknown"
)

// RowClaim is what a row may claim given its forge's health.
type RowClaim struct {
	State ClaimTrust
	// Since is when the rows on show were read, when known.
	Since *time.Time
	// ActionsOpen is false while the forge can't be asked. A spent request
	// budget is a separate question (RateLimitedUntil), not a claim about the
	// data's age.
	ActionsOpen bool
	// Reason says why the claim is not confirmed; empty when it is.
	Reason string
}

// ClaimOf is the one place the server decides what a row may claim while its
// forge is unreachable, so no caller reads Reachable, Starting or StaleSince
// for that itself (#3968). It reads the forge's health and never its name, so
// a row from any forge gets the same answer. answered is false when the forge
// has not said, which only a conflict can be. The web's rowClaim
// (web/src/lib/row-claim.ts) is the same rule.
func ClaimOf(kind ClaimKind, h ForgeHealth, answered bool) RowClaim {
	if !h.Reachable || h.Starting {
		return carriedOver(h.StaleSince)
	}
	if kind == ClaimConflict && !answered {
		return RowClaim{
			State:       ClaimUnknown,
			ActionsOpen: true,
			Reason:      "The forge hasn't confirmed it.",
		}
	}

	return RowClaim{State: ClaimConfirmed, ActionsOpen: true}
}

// ClaimOfRow is ClaimOf for a row that carries its own since-time (a main
// branch row or a repo, StaleSince): a row with one is an earlier answer, with
// the words and since-time ClaimOf gives a forge that can't be asked. No
// caller tests a row's StaleSince for that itself (#3993).
func ClaimOfRow(kind ClaimKind, since *time.Time) RowClaim {
	if since != nil {
		return carriedOver(since)
	}

	return ClaimOf(kind, ForgeHealth{Reachable: true}, true)
}

func carriedOver(since *time.Time) RowClaim {
	return RowClaim{
		State:       ClaimCarriedOver,
		Since:       since,
		ActionsOpen: false,
		Reason:      "The forge can't be asked right now, so this is an earlier answer and no action can run until it can.",
	}
}
