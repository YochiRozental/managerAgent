/**
 * תמלול עברית (Whisper) — כבוי כברירת מחדל (ENABLE_VOICE_TRANSCRIPTION).
 *
 * כל הספריות הכבדות (@huggingface/transformers → onnxruntime, ffmpeg, wavefile) נטענות
 * ב-import דינמי בתוך transcribeHebrew — כלומר **רק אם באמת מתמללים**. כשהתמלול כבוי,
 * onnxruntime לא נטען כלל (הוא שומר עשרות GB של virtual memory ומכביד על שרת קטן).
 */

import { logger } from "../../utils/logger.js";

const MODEL = "Xenova/whisper-small";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriberPromise: Promise<any> | null = null;
let ffmpegConfigured = false;

async function getTranscriber(): Promise<(audio: Float32Array, opts: unknown) => Promise<unknown>> {
  if (!transcriberPromise) {
    logger.info(`טוען מודל תמלול (${MODEL})... בפעם הראשונה זה מוריד את המודל ולוקח זמן`);
    const { pipeline } = await import("@huggingface/transformers");
    transcriberPromise = pipeline("automatic-speech-recognition", MODEL);
  }
  return transcriberPromise as Promise<(audio: Float32Array, opts: unknown) => Promise<unknown>>;
}

async function convertToWav(inputPath: string): Promise<string> {
  const [{ default: ffmpeg }, ffmpegStatic] = await Promise.all([
    import("fluent-ffmpeg"),
    import("ffmpeg-static"),
  ]);
  if (!ffmpegConfigured) {
    const ffmpegPath = (ffmpegStatic.default ?? ffmpegStatic) as unknown as string;
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpegConfigured = true;
  }
  const outputPath = `${inputPath.replace(/\.[^.]+$/, "")}.wav`;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

export async function transcribeHebrew(audioFilePath: string): Promise<string> {
  const fs = await import("node:fs");
  const { default: wavefile } = await import("wavefile");
  const wavPath = await convertToWav(audioFilePath);
  try {
    const buffer = fs.readFileSync(wavPath);
    const wav = new wavefile.WaveFile(buffer);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    const rawSamples = wav.getSamples() as unknown as Float32Array | Float32Array[];
    const audioData: Float32Array = Array.isArray(rawSamples) ? rawSamples[0]! : rawSamples;

    const transcriber = await getTranscriber();
    const output = (await transcriber(audioData, { language: "hebrew", task: "transcribe" })) as
      | { text?: string }
      | { text?: string }[];
    const result = Array.isArray(output) ? output[0] : output;
    return (result?.text ?? "").trim();
  } finally {
    fs.unlink(wavPath, () => {});
  }
}
