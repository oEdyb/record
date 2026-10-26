//! Bounded PCM storage with discontinuities measured on the producer's clock.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Default)]
struct QueuedAudio {
    samples: VecDeque<f32>,
    clock: Option<AudioClock>,
    clock_reanchored: bool,
}

/// Anchor the cursor once, then advance by exact PCM frames. Buffer-cycle
/// jitter must not move the anchor backward and manufacture silence each cycle.
#[derive(Debug)]
struct AudioClock {
    anchor_ns: u64,
    frames: u64,
    last_cycle_ns: u64,
}

impl AudioClock {
    fn expected_ns(&self, rate: usize) -> u64 {
        self.anchor_ns
            .saturating_add((u128::from(self.frames) * 1_000_000_000 / rate as u128) as u64)
    }
}

const CLOCK_JITTER_NS: u64 = 2_000_000;

pub struct AudioDrain {
    pub dropped_samples: u64,
    pub cycle_ns: Option<u64>,
    pub clock_reanchored: bool,
}

/// Keep the latest PCM when encoding stalls. Missing intervals enter as silence;
/// overflow is counted so the consumer restores any prefix that cannot fit here.
#[derive(Debug)]
pub struct AudioRing {
    inner: Mutex<QueuedAudio>,
    capacity: usize,
    sample_rate: usize,
    channels: usize,
    dropped: AtomicU64,
}

impl AudioRing {
    pub fn new(seconds: usize, sample_rate: usize, channels: usize) -> Self {
        Self {
            inner: Mutex::new(QueuedAudio::default()),
            capacity: seconds * sample_rate * channels,
            sample_rate,
            channels,
            dropped: AtomicU64::new(0),
        }
    }

    /// Cycle times travel with each buffer, so delayed callback execution does
    /// not turn a retained buffer into fresh audio. A zero clock is unavailable.
    pub fn push_at(&self, samples: &[f32], cycle_ns: u64) {
        let Ok(mut queued) = self.inner.lock() else {
            self.dropped
                .fetch_add(samples.len() as u64, Ordering::Relaxed);
            return;
        };
        if cycle_ns == 0 {
            queued.clock = None;
        } else {
            if queued.clock.is_none() {
                queued.clock_reanchored = true;
            }
            let mut clock = queued.clock.take().unwrap_or(AudioClock {
                anchor_ns: cycle_ns,
                frames: 0,
                last_cycle_ns: cycle_ns,
            });
            if cycle_ns < clock.last_cycle_ns {
                queued.clock_reanchored = true;
                clock.anchor_ns = cycle_ns;
                clock.frames = 0;
            }
            let gap = cycle_ns.saturating_sub(clock.expected_ns(self.sample_rate));
            if gap > CLOCK_JITTER_NS {
                let frames =
                    (u128::from(gap) * self.sample_rate as u128 + 500_000_000) / 1_000_000_000;
                let frames = usize::try_from(frames).unwrap_or(usize::MAX / self.channels);
                self.silence(&mut queued.samples, frames * self.channels);
                clock.frames = clock.frames.saturating_add(frames as u64);
            }
            clock.frames = clock
                .frames
                .saturating_add((samples.len() / self.channels) as u64);
            clock.last_cycle_ns = cycle_ns;
            queued.clock = Some(clock);
        }
        self.append(&mut queued.samples, samples);
    }

    fn silence(&self, queue: &mut VecDeque<f32>, samples: usize) {
        // Long device outages consume at most the ring's normal PCM capacity.
        let omitted = samples.saturating_sub(self.capacity);
        if omitted > 0 {
            self.dropped
                .fetch_add((queue.len() + omitted) as u64, Ordering::Relaxed);
            queue.clear();
        }
        queue.resize(queue.len() + samples.min(self.capacity), 0.0);
        self.trim(queue);
    }

    fn append(&self, queue: &mut VecDeque<f32>, samples: &[f32]) {
        if samples.len() > self.capacity {
            self.dropped.fetch_add(
                (queue.len() + samples.len() - self.capacity) as u64,
                Ordering::Relaxed,
            );
            queue.clear();
            queue.extend(samples[samples.len() - self.capacity..].iter().copied());
            return;
        }
        queue.extend(samples.iter().copied());
        self.trim(queue);
    }

    fn trim(&self, queue: &mut VecDeque<f32>) {
        let excess = queue.len().saturating_sub(self.capacity);
        queue.drain(..excess);
        self.dropped.fetch_add(excess as u64, Ordering::Relaxed);
    }

    pub fn drain_into(&self, out: &mut Vec<f32>) -> AudioDrain {
        let Ok(mut queued) = self.inner.lock() else {
            return AudioDrain {
                dropped_samples: self.dropped_samples(),
                cycle_ns: None,
                clock_reanchored: false,
            };
        };
        out.reserve(queued.samples.len());
        out.extend(queued.samples.drain(..));
        AudioDrain {
            // Snapshot loss and PCM under the same lock, before another push.
            dropped_samples: self.dropped_samples(),
            cycle_ns: queued
                .clock
                .as_ref()
                .map(|clock| clock.expected_ns(self.sample_rate)),
            clock_reanchored: std::mem::take(&mut queued.clock_reanchored),
        }
    }

    /// Audio before the video epoch and during Pause belongs to no clip.
    pub fn clear(&self) {
        if let Ok(mut queued) = self.inner.lock() {
            queued.samples.clear();
            queued.clock = None;
            queued.clock_reanchored = false;
            self.dropped.store(0, Ordering::Relaxed);
        }
    }

    pub fn dropped_samples(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn push_for_test(&self, samples: &[f32]) {
        self.push_at(samples, 0);
    }

    #[cfg(test)]
    pub fn push_at_for_test(&self, samples: &[f32], cycle_ns: u64) {
        self.push_at(samples, cycle_ns);
    }
}

#[cfg(test)]
mod tests {
    use super::AudioRing;

    #[test]
    fn gap_stays_between_old_and_new_samples_in_one_drain() {
        let ring = AudioRing::new(2, 10, 2);
        ring.push_at(&[0.25; 2], 1_000_000_000);
        ring.push_at(&[0.75; 2], 1_400_000_000);
        let mut samples = Vec::new();
        let drained = ring.drain_into(&mut samples);
        assert_eq!(
            samples,
            [0.25, 0.25, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.75, 0.75]
        );
        assert_eq!(drained.dropped_samples, 0);
    }

    #[test]
    fn long_gap_is_bounded_and_its_omitted_prefix_is_counted() {
        let ring = AudioRing::new(2, 10, 2);
        ring.push_at(&[0.25; 2], 1_000_000_000);
        ring.push_at(&[0.75; 2], 61_000_000_000);
        let mut samples = Vec::new();
        let drained = ring.drain_into(&mut samples);
        assert_eq!(samples.len(), 40);
        assert!(samples[..38].iter().all(|sample| *sample == 0.0));
        assert_eq!(&samples[38..], &[0.75; 2]);
        assert_eq!(drained.dropped_samples, 1162);
    }

    #[test]
    fn pause_clear_does_not_restore_the_paused_gap() {
        let ring = AudioRing::new(2, 10, 2);
        ring.push_at(&[0.25; 2], 1_000_000_000);
        ring.clear();
        ring.push_at(&[0.75; 2], 61_000_000_000);
        let mut samples = Vec::new();
        let drained = ring.drain_into(&mut samples);
        assert_eq!(samples, [0.75; 2]);
        assert_eq!(drained.dropped_samples, 0);
    }

    #[test]
    fn alternating_clock_jitter_never_stretches_continuous_pcm() {
        let ring = AudioRing::new(2, 48_000, 2);
        let mut samples = Vec::new();
        for block in 0_u64..6_000 {
            let jitter = if block % 2 == 0 { 0 } else { 100_000 };
            ring.push_at(&[0.25; 960], 1_000_000_000 + block * 10_000_000 + jitter);
            let drained = ring.drain_into(&mut samples);
            assert_eq!(drained.dropped_samples, 0);
        }
        assert_eq!(samples.len(), 60 * 48_000 * 2);
        assert!(samples.iter().all(|sample| *sample == 0.25));
    }

    #[test]
    fn unavailable_or_reset_clock_never_creates_a_wrapped_gap() {
        let ring = AudioRing::new(2, 10, 2);
        for clock in [61_000_000_000, 1_000_000_000, 0, 81_000_000_000] {
            ring.push_at(&[0.25; 2], clock);
        }
        let mut samples = Vec::new();
        let drained = ring.drain_into(&mut samples);
        assert_eq!(samples, [0.25; 8]);
        assert_eq!(drained.dropped_samples, 0);
    }
}
