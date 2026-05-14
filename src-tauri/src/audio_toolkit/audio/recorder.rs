use std::{
    io::Error,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SizedSample,
};

use crate::audio_toolkit::{
    audio::{AudioVisualiser, FrameResampler},
    constants,
    vad::{self, VadFrame},
    VoiceActivityDetector,
};

enum Cmd {
    Start,
    Stop(mpsc::Sender<Vec<f32>>),
    Shutdown,
}

pub struct AudioRecorder {
    device: Option<Device>,
    cmd_tx: Option<mpsc::Sender<Cmd>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
}

impl AudioRecorder {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(AudioRecorder {
            device: None,
            cmd_tx: None,
            worker_handle: None,
            vad: None,
            level_cb: None,
        })
    }

    pub fn with_vad(mut self, vad: Box<dyn VoiceActivityDetector>) -> Self {
        self.vad = Some(Arc::new(Mutex::new(vad)));
        self
    }

    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    pub fn open(&mut self, device: Option<Device>) -> Result<(), Box<dyn std::error::Error>> {
        if self.worker_handle.is_some() {
            return Ok(()); // already open
        }

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| Error::new(std::io::ErrorKind::NotFound, "No input device found"))?,
        };

        let thread_device = device.clone();
        let vad = self.vad.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();

        let worker = std::thread::spawn(move || {
            let config = AudioRecorder::get_preferred_config(&thread_device)
                .expect("failed to fetch preferred config");

            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;

            log::info!(
                "Using device: {:?}\nSample rate: {}\nChannels: {}\nFormat: {:?}",
                thread_device.name(),
                sample_rate,
                channels,
                config.sample_format()
            );

            let stream = match config.sample_format() {
                cpal::SampleFormat::U8 => {
                    AudioRecorder::build_stream::<u8>(&thread_device, &config, sample_tx, channels)
                        .unwrap()
                }
                cpal::SampleFormat::I8 => {
                    AudioRecorder::build_stream::<i8>(&thread_device, &config, sample_tx, channels)
                        .unwrap()
                }
                cpal::SampleFormat::I16 => {
                    AudioRecorder::build_stream::<i16>(&thread_device, &config, sample_tx, channels)
                        .unwrap()
                }
                cpal::SampleFormat::I32 => {
                    AudioRecorder::build_stream::<i32>(&thread_device, &config, sample_tx, channels)
                        .unwrap()
                }
                cpal::SampleFormat::F32 => {
                    AudioRecorder::build_stream::<f32>(&thread_device, &config, sample_tx, channels)
                        .unwrap()
                }
                _ => panic!("unsupported sample format"),
            };

            stream.play().expect("failed to start stream");

            // keep the stream alive while we process samples
            run_consumer(sample_rate, vad, sample_rx, cmd_rx, level_cb);
            // stream is dropped here, after run_consumer returns
        });

        self.device = Some(device);
        self.cmd_tx = Some(cmd_tx);
        self.worker_handle = Some(worker);

        Ok(())
    }

    pub fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Start)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Stop(resp_tx))?;
        }
        Ok(resp_rx.recv()?) // wait for the samples
    }

    pub fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        self.device = None;
        Ok(())
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sample_tx: mpsc::Sender<Vec<f32>>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            output_buffer.clear();

            if channels == 1 {
                // Direct conversion without intermediate Vec
                output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
            } else {
                // Convert to mono directly
                let frame_count = data.len() / channels;
                output_buffer.reserve(frame_count);

                for frame in data.chunks_exact(channels) {
                    let mono_sample = frame
                        .iter()
                        .map(|&sample| sample.to_sample::<f32>())
                        .sum::<f32>()
                        / channels as f32;
                    output_buffer.push(mono_sample);
                }
            }

            if sample_tx.send(output_buffer.clone()).is_err() {
                log::error!("Failed to send samples");
            }
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Stream error: {}", err),
            None,
        )
    }

    fn get_preferred_config(
        device: &cpal::Device,
    ) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
        let supported_configs = device.supported_input_configs()?;
        let mut best_config: Option<cpal::SupportedStreamConfigRange> = None;

        // Try to find a config that supports 16kHz, prioritizing better formats
        for config_range in supported_configs {
            if config_range.min_sample_rate().0 <= constants::WHISPER_SAMPLE_RATE
                && config_range.max_sample_rate().0 >= constants::WHISPER_SAMPLE_RATE
            {
                match best_config {
                    None => best_config = Some(config_range),
                    Some(ref current) => {
                        // Prioritize F32 > I16 > I32 > others
                        let score = |fmt: cpal::SampleFormat| match fmt {
                            cpal::SampleFormat::F32 => 4,
                            cpal::SampleFormat::I16 => 3,
                            cpal::SampleFormat::I32 => 2,
                            _ => 1,
                        };

                        if score(config_range.sample_format()) > score(current.sample_format()) {
                            best_config = Some(config_range);
                        }
                    }
                }
            }
        }

        if let Some(config) = best_config {
            return Ok(config.with_sample_rate(cpal::SampleRate(constants::WHISPER_SAMPLE_RATE)));
        }

        // If no config supports 16kHz, fall back to default
        Ok(device.default_input_config()?)
    }
}

fn run_consumer(
    in_sample_rate: u32,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    sample_rx: mpsc::Receiver<Vec<f32>>,
    cmd_rx: mpsc::Receiver<Cmd>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
) {
    let mut frame_resampler = FrameResampler::new(
        in_sample_rate as usize,
        constants::WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(30),
    );

    let mut processed_samples = Vec::<f32>::new();
    let mut recording = false;

    // ---------- spectrum visualisation setup ---------------------------- //
    const BUCKETS: usize = 16;
    const WINDOW_SIZE: usize = 512;
    // Lower gate so typical speaking volumes (especially on quieter mics) still register.
    const RMS_GATE_THRESHOLD: f32 = 0.09;
    const RMS_SPEECH_FULL_SCALE: f32 = 0.72;
    // Keep this range broad enough to survive OS-level mic DSP changes while
    // still emphasizing spoken voice energy.
    const VISUAL_FREQ_MIN_HZ: f32 = 120.0;
    const VISUAL_FREQ_MAX_HZ: f32 = 6000.0;
    let mut visualizer = AudioVisualiser::new(
        in_sample_rate,
        WINDOW_SIZE,
        BUCKETS,
        VISUAL_FREQ_MIN_HZ,
        VISUAL_FREQ_MAX_HZ,
    );

    fn compute_rms_loudness(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }

        let mean_square = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
        let rms = mean_square.sqrt();
        if rms <= 1e-7 {
            return 0.0;
        }

        let db = 20.0 * rms.log10();
        // Map practical speech loudness so room noise sits near zero while
        // conversational speech still registers.
        ((db + 62.0) / 36.0).clamp(0.0, 1.0).powf(1.25)
    }

    fn blend_meter_levels(levels: &mut [f32], rms_loudness: f32) {
        if levels.is_empty() {
            return;
        }

        let gated_rms = if rms_loudness > RMS_GATE_THRESHOLD {
            ((rms_loudness - RMS_GATE_THRESHOLD) / (1.0 - RMS_GATE_THRESHOLD)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let speech_weight = (gated_rms / RMS_SPEECH_FULL_SCALE).clamp(0.0, 1.0);
        let floor = gated_rms * (0.008 + speech_weight * 0.055);

        for level in levels.iter_mut() {
            let spectrum = (*level).clamp(0.0, 1.0);
            let spectrum_mix = 0.18 + speech_weight * 0.62;
            let rms_mix = 0.24 + speech_weight * 0.2;
            let blended = spectrum * spectrum_mix + gated_rms * rms_mix;
            let quiet_scaled = if speech_weight < 0.12 {
                blended * 0.10
            } else if speech_weight < 0.24 {
                blended * 0.30
            } else {
                blended
            };
            *level = quiet_scaled.max(floor).clamp(0.0, 1.0);
        }

        // If RMS indicates no speech, aggressively collapse residual spectrum energy.
        if speech_weight < 0.08 {
            for level in levels.iter_mut() {
                *level *= 0.35;
                if *level < 0.012 {
                    *level = 0.0;
                }
            }
        }
    }

    fn build_rms_fallback_levels(rms_loudness: f32, buckets: usize) -> Vec<f32> {
        if buckets == 0 {
            return Vec::new();
        }

        let gated_rms = if rms_loudness > RMS_GATE_THRESHOLD {
            ((rms_loudness - RMS_GATE_THRESHOLD) / (1.0 - RMS_GATE_THRESHOLD)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let shaped_rms = gated_rms.powf(0.95);

        // Center-emphasized contour so fallback does not look like a flat block.
        let denom = (buckets.saturating_sub(1)).max(1) as f32;
        (0..buckets)
            .map(|i| {
                let x = i as f32 / denom;
                let centered = 1.0 - ((x - 0.5).abs() * 1.6);
                (shaped_rms * 0.82 * centered.clamp(0.3, 1.0)).clamp(0.0, 1.0)
            })
            .collect()
    }

    fn handle_frame(
        samples: &[f32],
        recording: bool,
        vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
        out_buf: &mut Vec<f32>,
    ) -> bool {
        if !recording {
            return false;
        }

        if let Some(vad_arc) = vad {
            let mut det = vad_arc.lock().unwrap();
            match det.push_frame(samples).unwrap_or(VadFrame::Speech(samples)) {
                VadFrame::Speech(buf) => {
                    out_buf.extend_from_slice(buf);
                    true
                }
                VadFrame::Noise => false,
            }
        } else {
            out_buf.extend_from_slice(samples);
            true
        }
    }

    fn dampen_silence_levels(levels: &mut [f32]) {
        for level in levels.iter_mut() {
            *level *= 0.14;
            if *level < 0.02 {
                *level = 0.0;
            }
        }
    }

    let mut speech_hold_frames: usize = 0;
    const SPEECH_HOLD_FRAMES: usize = 1;
    const SILENCE_FORCE_THRESHOLD: f32 = 0.11;

    fn meter_stats(levels: &[f32]) -> (f32, f32, usize) {
        if levels.is_empty() {
            return (0.0, 0.0, 0);
        }
        let mut max = 0.0_f32;
        let mut sum = 0.0_f32;
        let mut nonzero = 0_usize;
        for &v in levels {
            let value = v.clamp(0.0, 1.0);
            max = max.max(value);
            sum += value;
            if value > 0.001 {
                nonzero += 1;
            }
        }
        (max, sum / levels.len() as f32, nonzero)
    }

    let mut last_meter_log_at = Instant::now();
    let mut meter_logged_once = false;
    let mut last_high_level_at: Option<Instant> = None;

    loop {
        let raw = match sample_rx.recv() {
            Ok(s) => s,
            Err(_) => break, // stream closed
        };

        // ---------- existing pipeline ------------------------------------ //
        let mut speech_in_chunk = false;
        frame_resampler.push(&raw, &mut |frame: &[f32]| {
            if handle_frame(frame, recording, &vad, &mut processed_samples) {
                speech_in_chunk = true;
            }
        });
        if speech_in_chunk {
            speech_hold_frames = SPEECH_HOLD_FRAMES;
        } else {
            speech_hold_frames = speech_hold_frames.saturating_sub(1);
        }

        // ---------- spectrum processing ---------------------------------- //
        let rms_loudness = compute_rms_loudness(&raw);
        let raw_abs_max = raw
            .iter()
            .copied()
            .map(f32::abs)
            .fold(0.0_f32, |acc, v| acc.max(v));
        // For the visual meter, rely on RMS (not VAD) so quiet speech still shows up.
        let should_dampen = recording && rms_loudness < SILENCE_FORCE_THRESHOLD;
        let mut used_fft = false;
        let (mut max_level, mut avg_level, mut nonzero_buckets) = (0.0_f32, 0.0_f32, 0_usize);
        if let Some(mut buckets) = visualizer.feed(&raw) {
            used_fft = true;
            blend_meter_levels(&mut buckets, rms_loudness);
            if should_dampen {
                dampen_silence_levels(&mut buckets);
            }
            (max_level, avg_level, nonzero_buckets) = meter_stats(&buckets);
            if let Some(cb) = &level_cb {
                cb(buckets);
            }
        } else if let Some(cb) = &level_cb {
            // Robust fallback when FFT windowing does not yield a frame for this callback.
            let mut fallback = build_rms_fallback_levels(rms_loudness, BUCKETS);
            if should_dampen {
                dampen_silence_levels(&mut fallback);
            }
            (max_level, avg_level, nonzero_buckets) = meter_stats(&fallback);
            cb(fallback);
        }

        if recording
            && (!meter_logged_once || last_meter_log_at.elapsed() >= Duration::from_millis(450))
        {
            meter_logged_once = true;
            last_meter_log_at = Instant::now();

            // Track "stuck high" windows: sustained high meter despite low RMS.
            let inconsistent_high = rms_loudness < 0.09 && max_level > 0.55;
            if inconsistent_high {
                last_high_level_at.get_or_insert_with(Instant::now);
            } else {
                last_high_level_at = None;
            }

            let stuck_ms = last_high_level_at
                .as_ref()
                .map(|t| t.elapsed().as_millis())
                .unwrap_or(0);

            log::info!(
                "meter: rec={} fft={} speech_in_chunk={} hold_frames={} rms={:.3} raw_abs_max={:.3} dampen={} max={:.3} avg={:.3} nz={}/{} stuck_ms={}",
                recording,
                used_fft,
                speech_in_chunk,
                speech_hold_frames,
                rms_loudness,
                raw_abs_max,
                should_dampen,
                max_level,
                avg_level,
                nonzero_buckets,
                BUCKETS,
                stuck_ms
            );
        }

        // non-blocking check for a command
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Cmd::Start => {
                    processed_samples.clear();
                    recording = true;
                    visualizer.reset(); // Reset visualization buffer
                    speech_hold_frames = 0;
                    if let Some(v) = &vad {
                        v.lock().unwrap().reset();
                    }
                    if let Some(cb) = &level_cb {
                        cb(vec![0.0; BUCKETS]);
                    }
                    log::info!(
                        "meter: start (in_sample_rate={}Hz buckets={} window={})",
                        in_sample_rate,
                        BUCKETS,
                        WINDOW_SIZE
                    );
                }
                Cmd::Stop(reply_tx) => {
                    recording = false;

                    frame_resampler.finish(&mut |frame: &[f32]| {
                        // we still want to process the last few frames
                        let _ = handle_frame(frame, true, &vad, &mut processed_samples);
                    });

                    let _ = reply_tx.send(std::mem::take(&mut processed_samples));
                    speech_hold_frames = 0;
                    if let Some(cb) = &level_cb {
                        cb(vec![0.0; BUCKETS]);
                    }
                    log::info!("meter: stop");
                }
                Cmd::Shutdown => return,
            }
        }
    }
}
