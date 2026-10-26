//! PCM and missing intervals share one timeline without allocating the silence.
use std::collections::VecDeque;

enum Run {
    Samples(VecDeque<f32>),
    Silence(usize),
}

#[derive(Default)]
pub struct AudioQueue {
    runs: VecDeque<Run>,
    len: usize,
}

impl AudioQueue {
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn clear(&mut self) {
        self.runs.clear();
        self.len = 0;
    }
    pub fn silence(&mut self, samples: usize) {
        if samples == 0 {
            return;
        }
        if let Some(Run::Silence(last)) = self.runs.back_mut() {
            *last += samples;
        } else {
            self.runs.push_back(Run::Silence(samples));
        }
        self.len += samples;
    }
    pub fn push(&mut self, samples: Vec<f32>) {
        if samples.is_empty() {
            return;
        }
        self.len += samples.len();
        self.runs.push_back(Run::Samples(samples.into()));
    }
    /// Add the next samples to a bounded mix block; absent input stays silent.
    pub fn mix_into(&mut self, output: &mut [f32], gain: f32) {
        let mut offset = 0;
        while offset < output.len() {
            let Some(run) = self.runs.front_mut() else {
                break;
            };
            let (count, empty) = match run {
                Run::Samples(samples) => {
                    let count = samples.len().min(output.len() - offset);
                    for (out, sample) in output[offset..offset + count]
                        .iter_mut()
                        .zip(samples.drain(..count))
                    {
                        *out += sample * gain;
                    }
                    (count, samples.is_empty())
                }
                Run::Silence(samples) => {
                    let count = (*samples).min(output.len() - offset);
                    *samples -= count;
                    (count, *samples == 0)
                }
            };
            offset += count;
            self.len -= count;
            if empty {
                self.runs.pop_front();
            }
        }
    }
}
