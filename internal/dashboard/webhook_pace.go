package dashboard

import "time"

// webhookShare is the part of an hourly GraphQL budget that the webhook
// refreshes of one repo may spend. The debounce limits how many run, which
// says nothing about what they add up to when each one is dear.
const webhookShare = 0.10

// webhookPause is how long one repo's webhook refreshes rest after one that
// cost points, so that they spend no more than webhookShare of limit an hour.
// It is zero when either figure is unknown.
func webhookPause(points, limit int) time.Duration {
	if points <= 0 || limit <= 0 {
		return 0
	}

	return time.Duration(float64(points) / (float64(limit) * webhookShare) * float64(time.Hour))
}

// chargeWebhook adds the points that a webhook's read of the repo cost to what
// its next one waits for, counting from started, when the read began.
func (a *Aggregator) chargeWebhook(forge Forge, owner, name, key string, started time.Time, points int) {
	graphQL := a.budgets(a.Get(), forge, owner, name)[0]
	if graphQL == nil {
		return
	}
	a.debounce.charge(key, started, webhookPause(points, graphQL.Limit))
}
