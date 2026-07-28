let rnnoiseInstance = null;
let audioContext = null;
let denoiseState = null;
let rawStream = null;
let destroyed = false;

const RNNOISE_RATE = 16000;
const FRAME_SIZE = 480; // rnnoise frame size at 16kHz

async function loadRnnoise() {
  const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
  return await Rnnoise.load();
}

async function ensureRnnoise() {
  if (!rnnoiseInstance) {
    rnnoiseInstance = await loadRnnoise();
  }
  return rnnoiseInstance;
}

async function createNoiseSuppressedStream(inputStream) {
  await ensureRnnoise();

  const inputSettings = inputStream.getAudioTracks()[0]?.getSettings?.();
  const inputRate = inputSettings?.sampleRate || 48000;
  const ratio = inputRate / RNNOISE_RATE;

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(inputStream);
  const dest = ctx.createMediaStreamDestination();

  const ds = rnnoiseInstance.createDenoiseState();
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  let inputBuf = [];
  let outputBuf = [];
  destroyed = false;
  rawStream = inputStream;

  // High-pass filter state (removes DC offset and rumble below ~40Hz)
  let hpPrevIn = 0, hpPrevOut = 0;
  const hpAlpha = 0.995; // ~40Hz cutoff at 48kHz

  // Noise gate state
  let gateLevel = 0;
  const gateThreshold = 0.004; // -48dB
  const gateAttack = 0.5;
  const gateRelease = 0.1;

  processor.onaudioprocess = (event) => {
    if (destroyed) return;
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    const len = input.length;

    // 1. High-pass filter + push to input buffer
    for (let i = 0; i < len; i++) {
      const hp = input[i] - hpPrevIn + hpAlpha * hpPrevOut;
      hpPrevIn = input[i];
      hpPrevOut = hp;
      inputBuf.push(hp);
    }

    // 2. Process through RNNoise in 480-sample frames at 16kHz
    //    Resample from input rate to 16kHz via decimation
    while (inputBuf.length >= FRAME_SIZE * ratio) {
      const raw = inputBuf.splice(0, FRAME_SIZE * ratio);
      const frame = new Float32Array(FRAME_SIZE);

      if (ratio >= 1 && Number.isInteger(ratio)) {
        // Simple integer decimation: average groups of `ratio` samples
        for (let i = 0; i < FRAME_SIZE; i++) {
          let sum = 0;
          for (let j = 0; j < ratio; j++) {
            sum += raw[i * ratio + j];
          }
          frame[i] = sum / ratio;
        }
      } else {
        for (let i = 0; i < FRAME_SIZE; i++) {
          const srcIdx = Math.min(Math.round(i * ratio), raw.length - 1);
          frame[i] = raw[srcIdx];
        }
      }

      ds.processFrame(frame);

      // Upsample back: interpolate back to original rate
      if (ratio >= 1 && Number.isInteger(ratio)) {
        for (let i = 0; i < FRAME_SIZE; i++) {
          const val = frame[i];
          for (let j = 0; j < ratio; j++) {
            outputBuf.push(val);
          }
        }
      } else {
        for (let i = 0; i < FRAME_SIZE * ratio; i++) {
          const srcIdx = Math.min(Math.floor(i / ratio), FRAME_SIZE - 1);
          const frac = (i / ratio) - srcIdx;
          const nextIdx = Math.min(srcIdx + 1, FRAME_SIZE - 1);
          const interpolated = frame[srcIdx] + (frame[nextIdx] - frame[srcIdx]) * frac;
          outputBuf.push(interpolated);
        }
      }
    }

    // 3. Noise gate + write to output
    const toWrite = Math.min(outputBuf.length, len);
    for (let i = 0; i < toWrite; i++) {
      const abs = Math.abs(outputBuf[i]);
      gateLevel = abs > gateLevel
        ? gateLevel + gateAttack * (abs - gateLevel)
        : gateLevel + gateRelease * (abs - gateLevel);

      if (gateLevel < gateThreshold) {
        output[i] = 0;
      } else {
        output[i] = outputBuf[i];
      }
    }
    outputBuf.splice(0, toWrite);

    for (let i = toWrite; i < len; i++) {
      output[i] = 0;
    }
  };

  source.connect(processor);
  processor.connect(dest);

  audioContext = ctx;
  denoiseState = ds;

  return dest.stream;
}

function destroyNoiseSuppressedStream() {
  destroyed = true;
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (rawStream) {
    rawStream.getTracks().forEach(t => t.stop());
    rawStream = null;
  }
  if (denoiseState) {
    denoiseState.destroy();
    denoiseState = null;
  }
}

module.exports = { createNoiseSuppressedStream, destroyNoiseSuppressedStream, ensureRnnoise };
