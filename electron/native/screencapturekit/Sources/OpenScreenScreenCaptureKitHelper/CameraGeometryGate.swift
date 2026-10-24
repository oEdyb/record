/// Decides what happens to each camera frame by whether it has the configured native size.
/// Frames at any other size are dropped; the first one of a run and the first native frame
/// after it are the moments worth reporting.
struct CameraGeometryGate {
	enum Decision: Equatable {
		case forward
		case forwardAfterGap(dropped: Int)
		case dropStartingGap
		case drop
	}

	private var dropped = 0

	mutating func admit(native: Bool) -> Decision {
		if native {
			defer { dropped = 0 }
			return dropped > 0 ? .forwardAfterGap(dropped: dropped) : .forward
		}
		dropped += 1
		return dropped == 1 ? .dropStartingGap : .drop
	}
}
