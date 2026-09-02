import fs from "node:fs";
import ffmpegPathImport from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import wavefile from "wavefile";
import { logger } from "../../utils/logger.js";

const ffmpegPath = ffmpegPathImport as unknown as string;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const MODEL = "Xenova/whisper-small";

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    logger.info(`טוען מודל תמלול (${MODEL})... בפעם הראשונה זה מוריד את המודל ולוקח זמן`);
    transcriberPromise = pipeline("automatic-speech-recognition", MODEL);
  }
  return transcriberPromise;
}

function convertToWav(inputPath: string): Promise<string> {
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
  const wavPath = await convertToWav(audioFilePath);
  try {
    const buffer = fs.readFileSync(wavPath);
    const wav = new wavefile.WaveFile(buffer);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    const rawSamples = wav.getSamples() as unknown as Float32Array | Float32Array[];
    const audioData: Float32Array = Array.isArray(rawSamples) ? rawSamples[0]! : rawSamples;

    const transcriber = await getTranscriber();
    const output = await transcriber(audioData, { language: "hebrew", task: "transcribe" });
    const result = Array.isArray(output) ? output[0] : output;
    return (result?.text ?? "").trim();
  } finally {
    fs.unlink(wavPath, () => {});
  }
}
