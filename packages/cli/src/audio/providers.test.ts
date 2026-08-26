import { describe, expect, it } from "vitest";
import { decideMusic, decideVoice, KOKORO_PIP, MUSICGEN_PIP } from "./providers.js";

describe("decideVoice — mirrors the skill's heygen → elevenlabs → gemini → kokoro order", () => {
  const none = { hasHeygen: false, elevenlabs: false, gemini: false, kokoro: true };

  it("prefers HeyGen when configured", () => {
    const r = decideVoice({ hasHeygen: true, elevenlabs: true, gemini: true, kokoro: true });
    expect(r.engine).toBe("heygen");
    expect(r.ready).toBe(true);
  });

  it("falls to ElevenLabs only when key + module are both present", () => {
    expect(decideVoice({ ...none, elevenlabs: true }).engine).toBe("elevenlabs");
  });

  it("keeps ElevenLabs ahead of Gemini when both keys are set", () => {
    expect(decideVoice({ ...none, elevenlabs: true, gemini: true }).engine).toBe("elevenlabs");
  });

  it("falls to Gemini when its key is the only cloud credential", () => {
    const r = decideVoice({ ...none, gemini: true });
    expect(r.engine).toBe("gemini");
    expect(r.label).toBe("Gemini TTS");
    expect(r.local).toBe(false);
    expect(r.ready).toBe(true);
    expect(r.setupHint).toBeUndefined();
  });

  it("falls to Kokoro when no cloud provider is usable", () => {
    expect(decideVoice(none).engine).toBe("kokoro");
  });

  it("flags Kokoro as not-ready with a pip hint when deps are missing", () => {
    const r = decideVoice({ ...none, kokoro: false });
    expect(r.engine).toBe("kokoro");
    expect(r.ready).toBe(false);
    expect(r.setupHint).toBe(KOKORO_PIP);
  });

  it("omits the hint when Kokoro is ready", () => {
    expect(decideVoice(none).setupHint).toBeUndefined();
  });
});

describe("decideMusic — mirrors the skill's heygen → lyria → musicgen order", () => {
  it("prefers HeyGen, then Lyria, then MusicGen", () => {
    expect(decideMusic({ hasHeygen: true, lyria: true, musicgen: true }).engine).toBe("heygen");
    expect(decideMusic({ hasHeygen: false, lyria: true, musicgen: true }).engine).toBe("lyria");
    expect(decideMusic({ hasHeygen: false, lyria: false, musicgen: true }).engine).toBe("musicgen");
  });

  it("flags MusicGen as not-ready with a pip hint when deps are missing", () => {
    const r = decideMusic({ hasHeygen: false, lyria: false, musicgen: false });
    expect(r.engine).toBe("musicgen");
    expect(r.ready).toBe(false);
    expect(r.setupHint).toBe(MUSICGEN_PIP);
  });
});
