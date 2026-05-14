use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

const RELATIVE_GATE_DB: f32 = 6.0;
const RELATIVE_SPAN_DB: f32 = 24.0;
const CURVE_POWER: f32 = 1.05;
const ATTACK_ALPHA: f32 = 0.52;
const RELEASE_ALPHA: f32 = 0.46;
const NOISE_ALPHA: f32 = 0.06;

pub struct AudioVisualiser {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bucket_ranges: Vec<(usize, usize)>,
    fft_input: Vec<Complex32>,
    noise_floor: Vec<f32>,
    last_levels: Vec<f32>,
    buffer: Vec<f32>,
    window_size: usize,
    buckets: usize,
}

impl AudioVisualiser {
    pub fn new(
        sample_rate: u32,
        window_size: usize,
        buckets: usize,
        freq_min: f32,
        freq_max: f32,
    ) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(window_size);

        // Pre-compute Hann window
        let window: Vec<f32> = (0..window_size)
            .map(|i| {
                0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / window_size as f32).cos())
            })
            .collect();

        // Pre-compute bucket frequency ranges
        let nyquist = sample_rate as f32 / 2.0;
        let freq_min = freq_min.min(nyquist);
        let freq_max = freq_max.min(nyquist);

        let mut bucket_ranges = Vec::with_capacity(buckets);

        for b in 0..buckets {
            // Use logarithmic spacing for better perceptual representation
            let log_start = (b as f32 / buckets as f32).powi(2);
            let log_end = ((b + 1) as f32 / buckets as f32).powi(2);

            let start_hz = freq_min + (freq_max - freq_min) * log_start;
            let end_hz = freq_min + (freq_max - freq_min) * log_end;

            let start_bin = ((start_hz * window_size as f32) / sample_rate as f32) as usize;
            let mut end_bin = ((end_hz * window_size as f32) / sample_rate as f32) as usize;

            // Ensure each bucket has at least one bin
            if end_bin <= start_bin {
                end_bin = start_bin + 1;
            }

            // Clamp to valid range
            let start_bin = start_bin.min(window_size / 2);
            let end_bin = end_bin.min(window_size / 2);

            bucket_ranges.push((start_bin, end_bin));
        }

        Self {
            fft,
            window,
            bucket_ranges,
            fft_input: vec![Complex32::new(0.0, 0.0); window_size],
            noise_floor: vec![-58.0; buckets],
            last_levels: vec![0.0; buckets],
            buffer: Vec::with_capacity(window_size * 2),
            window_size,
            buckets,
        }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        // Add new samples to buffer
        self.buffer.extend_from_slice(samples);

        // Only process if we have enough samples
        if self.buffer.len() < self.window_size {
            return None;
        }

        // Keep only the newest analysis window. Some devices prepend short
        // silent sections to each callback chunk; using the latest window is
        // more robust than repeatedly sampling the oldest buffered slice.
        if self.buffer.len() > self.window_size {
            let drop_count = self.buffer.len() - self.window_size;
            self.buffer.drain(..drop_count);
        }

        let window_samples = &self.buffer[..self.window_size];

        // Remove DC component
        let mean = window_samples.iter().sum::<f32>() / self.window_size as f32;

        // Apply window function and prepare FFT input
        for (i, &sample) in window_samples.iter().enumerate() {
            let windowed_sample = (sample - mean) * self.window[i];
            self.fft_input[i] = Complex32::new(windowed_sample, 0.0);
        }

        // Perform FFT
        self.fft.process(&mut self.fft_input);

        // Compute power spectrum and bucket levels
        let mut buckets = vec![0.0; self.buckets];

        for (bucket_idx, &(start_bin, end_bin)) in self.bucket_ranges.iter().enumerate() {
            if start_bin >= end_bin || end_bin > self.fft_input.len() / 2 {
                continue;
            }

            // Calculate average power in this frequency range
            let mut power_sum = 0.0;
            for bin_idx in start_bin..end_bin {
                let magnitude = self.fft_input[bin_idx].norm();
                power_sum += magnitude * magnitude;
            }

            let avg_power = power_sum / (end_bin - start_bin) as f32;

            // Convert to dB with proper scaling
            let db = if avg_power > 1e-12 {
                20.0 * (avg_power.sqrt() / self.window_size as f32).log10()
            } else {
                -80.0 // Very low floor for zero power
            };

            // Adapt noise floor only when the bucket is near quiet.
            if db < self.noise_floor[bucket_idx] + 18.0 {
                self.noise_floor[bucket_idx] =
                    NOISE_ALPHA * db + (1.0 - NOISE_ALPHA) * self.noise_floor[bucket_idx];
            }

            // Map strictly relative to each bucket's adaptive floor to avoid persistent
            // stationary tones pinning bars high.
            let relative = ((db - self.noise_floor[bucket_idx] - RELATIVE_GATE_DB)
                / RELATIVE_SPAN_DB)
                .clamp(0.0, 1.0);
            let mut mapped = relative.powf(CURVE_POWER).clamp(0.0, 1.0);
            if mapped < 0.04 {
                mapped = 0.0;
            }

            let prev = self.last_levels[bucket_idx];
            let alpha = if mapped >= prev {
                ATTACK_ALPHA
            } else {
                RELEASE_ALPHA
            };
            let smoothed = prev + (mapped - prev) * alpha;
            self.last_levels[bucket_idx] = smoothed;
            buckets[bucket_idx] = smoothed;
        }

        // Apply light smoothing to reduce jitter
        if buckets.len() > 2 {
            for i in 1..buckets.len() - 1 {
                buckets[i] = buckets[i] * 0.7 + buckets[i - 1] * 0.15 + buckets[i + 1] * 0.15;
            }
        }

        Some(buckets)
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.noise_floor.fill(-58.0);
        self.last_levels.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::AudioVisualiser;

    fn max_level(levels: &[f32]) -> f32 {
        levels
            .iter()
            .copied()
            .fold(0.0_f32, |acc, value| acc.max(value))
    }

    #[test]
    fn feed_uses_latest_samples_when_chunk_has_leading_silence() {
        let sample_rate = 16_000_u32;
        let mut visualiser = AudioVisualiser::new(sample_rate, 512, 16, 120.0, 6000.0);

        let mut chunk = vec![0.0_f32; 1024];
        for i in 512..1024 {
            let t = (i - 512) as f32 / sample_rate as f32;
            chunk[i] = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.8;
        }

        let levels = visualiser
            .feed(&chunk)
            .expect("visualiser should emit levels when enough samples are present");

        assert!(
            max_level(&levels) > 0.05,
            "expected visible activity for trailing tone chunk, got {:?}",
            levels
        );
    }

    #[test]
    fn feed_silence_stays_low_after_warmup() {
        let sample_rate = 16_000_u32;
        let mut visualiser = AudioVisualiser::new(sample_rate, 512, 16, 120.0, 6000.0);
        let silence = vec![0.0_f32; 512];
        let mut last_levels = vec![0.0_f32; 16];

        for _ in 0..30 {
            if let Some(levels) = visualiser.feed(&silence) {
                last_levels = levels;
            }
        }

        assert!(
            max_level(&last_levels) < 0.08,
            "expected near-idle bars for silence, got {:?}",
            last_levels
        );
    }

    #[test]
    fn feed_loud_then_silence_drops_back_down() {
        let sample_rate = 16_000_u32;
        let mut visualiser = AudioVisualiser::new(sample_rate, 512, 16, 120.0, 6000.0);
        let mut tone = vec![0.0_f32; 512];
        let silence = vec![0.0_f32; 512];
        for i in 0..tone.len() {
            let t = i as f32 / sample_rate as f32;
            tone[i] = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.85;
        }

        // Warm tone input so levels rise.
        for _ in 0..6 {
            let _ = visualiser.feed(&tone);
        }

        let mut decayed_levels = vec![1.0_f32; 16];
        for _ in 0..24 {
            if let Some(levels) = visualiser.feed(&silence) {
                decayed_levels = levels;
            }
        }

        assert!(
            max_level(&decayed_levels) < 0.12,
            "expected bars to decay after silence, got {:?}",
            decayed_levels
        );
    }
}
