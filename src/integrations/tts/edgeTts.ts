import fs from "node:fs";
import ffmpegPathImport from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const ffmpegPath = ffmpegPathImport as unknown as string;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const VOICE = "he-IL-HilaNeural";
const OUTPUT_DIR = "data/tts";

function convertToOggOpus(inputPath: string): Promise<string> {
  const outputPath = `${inputPath.replace(/\.[^.]+$/, "")}.ogg`;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("libopus")
      .audioChannels(1)
      .format("ogg")
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

/** Synthesizes Hebrew text to a WhatsApp-compatible ogg/opus voice note file. */
export async function synthesizeHebrewVoiceNote(text: string): Promise<string> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(OUTPUT_DIR, text);
  tts.close();

  const oggPath = await convertToOggOpus(audioFilePath);
  fs.unlink(audioFilePath, () => {});
  return oggPath;
}
