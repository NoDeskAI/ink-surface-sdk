export const CLASSROOM_AUDIO_WORKLET_SOURCE = `
class InkLoopClassroomAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = []; this.sampleCount = 0;
    this.port.onmessage = (event) => { if (event.data && event.data.type === 'flush') this.flush(true); };
  }
  flush(final) {
    if (this.sampleCount > 0) {
      const output = new Float32Array(this.sampleCount); let offset = 0;
      for (const chunk of this.buffer) { output.set(chunk, offset); offset += chunk.length; }
      this.port.postMessage({ type: 'samples', samples: output, sampleRate }, [output.buffer]);
      this.buffer = []; this.sampleCount = 0;
    }
    if (final) this.port.postMessage({ type: 'flushed' });
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    this.buffer.push(new Float32Array(input)); this.sampleCount += input.length;
    if (this.sampleCount >= sampleRate * 0.5) {
      this.flush(false);
    }
    return true;
  }
}
registerProcessor('inkloop-classroom-audio', InkLoopClassroomAudioProcessor);
`;

export function classroomAudioWorkletUrl(): string {
  return URL.createObjectURL(new Blob([CLASSROOM_AUDIO_WORKLET_SOURCE], { type: 'text/javascript' }));
}
