package imageproxy

// HoldResizeSlots takes n of the resize slots, as n running resizes would, and
// returns what gives them back.
func HoldResizeSlots(n int) (release func()) {
	for range n {
		resizeSlots <- struct{}{}
	}

	return func() {
		for range n {
			<-resizeSlots
		}
	}
}

// ResizeSlots is how many resizes may run at once.
const ResizeSlots = maxConcurrentResizes
