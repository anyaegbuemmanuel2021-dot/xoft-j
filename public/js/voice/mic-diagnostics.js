/** Classify microphone input for a short, non-invasive startup diagnostic. */
export function classifyMicInput({ peakRms = 0, speechEvents = 0, threshold = 0.003 } = {}) {
  const peak = Number.isFinite(Number(peakRms)) ? Math.max(0, Number(peakRms)) : 0;
  const starts = Math.max(0, Number(speechEvents) || 0);
  if (starts > 0) return { status: 'speech', message: 'microphone input and speech detection are working' };
  if (peak < 0.0008) return { status: 'silent', message: 'no microphone signal detected; check input permission and selected device' };
  if (peak < Math.max(0.001, Number(threshold) || 0.003)) return { status: 'quiet', message: 'microphone signal is very quiet; move closer and check the input volume' };
  return { status: 'signal', message: 'audio signal is present; no speech event yet, so speak clearly to test the speech gate' };
}
