import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  GEMINI_TTS_DEFAULT_MODEL,
  findGeminiAudio,
  ffprobeDuration,
  geminiPcmLayout,
  isContainerAudio,
  parseFfmpegDurationBanner,
  pickProvider,
  resolveVoiceId,
  synthesizeGemini,
  synthesizeOne,
  synthesizeHeygen,
  synthResult,
} from "./tts.mjs";

test("parseFfmpegDurationBanner reads ffmpeg's stderr Duration line", () => {
  const stderr = [
    "ffmpeg version 6.0",
    "Input #0, wav, from 'a.wav':",
    "  Duration: 00:00:03.42, bitrate: 705 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  assert.equal(parseFfmpegDurationBanner(stderr), 3.42);
});

test("parseFfmpegDurationBanner handles an hours component", () => {
  const stderr = "  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s";
  assert.equal(parseFfmpegDurationBanner(stderr), 3723.5);
});

test("parseFfmpegDurationBanner returns NaN when there is no Duration line", () => {
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("ffmpeg: command not found")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner(undefined)));
});

// Regression for the actual bug: ffprobeDuration used to collapse "ffprobe
// binary is missing" (ENOENT — the "essentials"-style Windows ffmpeg build
// with no ffprobe.exe) and "file is genuinely unreadable" into the same NaN,
// giving audio.mjs no way to tell "measure differently" from "give up".
//
// Builds an isolated PATH containing only a fake `ffmpeg` stub (no `ffprobe`
// at all) so ffprobeDuration's spawnSync("ffprobe", ...) call ENOENTs for
// real, then verifies it recovers the duration via the ffmpeg fallback
// instead of returning NaN.
test("ffprobeDuration falls back to ffmpeg when the ffprobe binary itself is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-ffprobe-fallback-"));
  const fakeFfmpeg = join(dir, "ffmpeg");
  writeFileSync(
    fakeFfmpeg,
    "#!/bin/sh\necho 'Duration: 00:00:02.50, start: 0.000000, bitrate: 128 kb/s' 1>&2\nexit 1\n",
  );
  chmodSync(fakeFfmpeg, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // only the fake ffmpeg resolves; no real ffprobe on this PATH
    assert.equal(ffprobeDuration("/does/not/matter.wav"), 2.5);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffprobeDuration returns NaN when neither ffprobe nor ffmpeg resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-no-binaries-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // empty directory — nothing resolves
    assert.ok(Number.isNaN(ffprobeDuration("/does/not/matter.wav")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeOne(elevenlabs) creates the output dir before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-el-mkdir-"));
  const wavAbs = join(dir, "assets", "voice", "line-0.wav"); // nested, not yet created
  const savedKey = process.env.ELEVENLABS_API_KEY;
  try {
    // Unset the key so the Python side fails fast — the mkdir must run before
    // the spawn regardless, which is what this guards.
    delete process.env.ELEVENLABS_API_KEY;
    await synthesizeOne({
      provider: "elevenlabs",
      text: "hi",
      voiceId: "v",
      wavAbs,
      hyperframesDir: dir,
    });
    assert.ok(existsSync(dirname(wavAbs)), "output directory should be created");
  } finally {
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeHeygen surfaces a thrown HTTP error (e.g. 402) instead of swallowing it", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => {
        throw new Error("HeyGen POST /voices/speech → HTTP 402\nplan_upgrade_required");
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /402/);
  assert.match(res.error, /plan_upgrade_required/);
});

test("synthesizeHeygen surfaces a failed audio_url fetch with its status", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
      fetch: async () => ({ ok: false, status: 403 }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 403/);
});

test("synthesizeHeygen reports a missing audio_url", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    { heygenAuthHeaders: () => ({}), heygenJSON: async () => ({}) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio_url/);
});

test("synthesizeHeygen reports wav transcode failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-tts-test-"));
  try {
    const res = await synthesizeHeygen(
      { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: join(dir, "voice.wav") },
      {
        heygenAuthHeaders: () => ({}),
        heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
        transcodeToWav: () => false,
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "wav transcode failed (ffmpeg)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthResult names a non-zero subprocess exit", () => {
  const res = synthResult({ status: 2 }, "/tmp/none.wav", "kokoro (npx hyperframes tts)");
  assert.equal(res.ok, false);
  assert.match(res.error, /kokoro .* exited with status 2/);
});

// ── Gemini provider ───────────────────────────────────────────────────────────
// pickProvider takes injectable availability probes so these never touch
// ~/.heygen, Python, or the real env.
const noneAvailable = {
  heygenAvailable: () => false,
  elevenlabsAvailable: () => false,
  geminiAvailable: () => false,
};

test("pickProvider auto-selects gemini when only a Gemini key is configured", () => {
  assert.equal(pickProvider(null, { ...noneAvailable, geminiAvailable: () => true }), "gemini");
});

test("pickProvider keeps ElevenLabs ahead of Gemini when both are configured", () => {
  const both = { ...noneAvailable, elevenlabsAvailable: () => true, geminiAvailable: () => true };
  assert.equal(pickProvider(null, both), "elevenlabs");
});

test("pickProvider still falls through to kokoro when no cloud key is set", () => {
  assert.equal(pickProvider(null, noneAvailable), "kokoro");
});

test("pickProvider honors an explicit gemini choice and names the missing key", () => {
  assert.equal(pickProvider("gemini", { ...noneAvailable, geminiAvailable: () => true }), "gemini");
  assert.throws(() => pickProvider("gemini", noneAvailable), /GEMINI_API_KEY.*GOOGLE_API_KEY/);
});

test("pickProvider lists gemini among the valid providers when rejecting an unknown one", () => {
  assert.throws(
    () => pickProvider("polly", noneAvailable),
    /heygen \| elevenlabs \| gemini \| kokoro/,
  );
});

test("resolveVoiceId defaults gemini to Kore and honors a pinned voice", async () => {
  assert.equal(await resolveVoiceId({ provider: "gemini" }), "Kore");
  assert.equal(await resolveVoiceId({ provider: "gemini", userVoice: "Puck" }), "Puck");
});

test("findGeminiAudio returns the last audio block of the last model_output step", () => {
  const payload = {
    steps: [
      { type: "user_input", content: [{ type: "text", text: "hi" }] },
      { type: "model_output", content: [{ type: "audio", data: "old" }] },
      {
        type: "model_output",
        content: [
          { type: "text", text: "…" },
          { type: "audio", data: "new" },
        ],
      },
    ],
  };
  assert.equal(findGeminiAudio(payload).data, "new");
});

test("findGeminiAudio accepts the legacy outputs[] alias and SDK-shaped output_audio", () => {
  const legacy = { outputs: [{ type: "model_output", content: [{ type: "audio", data: "x" }] }] };
  assert.equal(findGeminiAudio(legacy).data, "x");
  assert.equal(findGeminiAudio({ output_audio: { type: "audio", data: "y" } }).data, "y");
});

test("findGeminiAudio returns null when there is no audio block", () => {
  const textOnly = { steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }] };
  assert.equal(findGeminiAudio(textOnly), null);
  assert.equal(findGeminiAudio({}), null);
  assert.equal(findGeminiAudio(null), null);
});

test("geminiPcmLayout prefers explicit fields, then the mime rate param, then 24 kHz mono", () => {
  assert.deepEqual(geminiPcmLayout({ sample_rate: 16000, channels: 2 }), {
    sampleRate: 16000,
    channels: 2,
  });
  assert.deepEqual(geminiPcmLayout({ mime_type: "audio/L16;codec=pcm;rate=22050" }), {
    sampleRate: 22050,
    channels: 1,
  });
  assert.deepEqual(geminiPcmLayout({ mime_type: "audio/l16" }), { sampleRate: 24000, channels: 1 });
});

test("isContainerAudio recognises container mime types and RIFF/ID3 magic, not bare PCM", () => {
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
  assert.equal(isContainerAudio({ mime_type: "audio/wav" }, pcm), true);
  assert.equal(isContainerAudio({ mime_type: "audio/mp3" }, pcm), true);
  assert.equal(isContainerAudio({}, Buffer.from("RIFF....WAVE")), true);
  assert.equal(isContainerAudio({}, Buffer.from("ID3\x04....")), true);
  assert.equal(isContainerAudio({ mime_type: "audio/l16;rate=24000" }, pcm), false);
  assert.equal(isContainerAudio({}, pcm), false);
});

// A canned Interactions response carrying `bytes` as inline base64 audio.
function geminiResponse(bytes, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      steps: [
        {
          type: "model_output",
          content: [{ type: "audio", data: Buffer.from(bytes).toString("base64"), ...extra }],
        },
      ],
    }),
  };
}

test("synthesizeGemini sends the documented single-speaker request and wraps the PCM reply", async () => {
  const calls = [];
  const wrapped = [];
  const res = await synthesizeGemini(
    { text: "Say warmly: hello", voiceId: "Kore", wavAbs: "/tmp/gemini/voice.wav" },
    {
      apiKey: () => "k-123",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return geminiResponse([1, 2, 3, 4], {
          mime_type: "audio/l16",
          sample_rate: 24000,
          channels: 1,
        });
      },
      pcmToWav: (bytes, sampleRate, channels, dest) => {
        wrapped.push({ bytes: [...bytes], sampleRate, channels, dest });
        return true;
      },
      transcodeToWav: () => assert.fail("PCM must not go through the container transcoder"),
    },
  );
  assert.deepEqual(res, { ok: true, words: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k-123");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, GEMINI_TTS_DEFAULT_MODEL);
  assert.equal(body.input, "Say warmly: hello");
  assert.deepEqual(body.response_format, { type: "audio" });
  assert.deepEqual(body.generation_config, { speech_config: [{ voice: "Kore" }] });
  assert.deepEqual(wrapped, [
    { bytes: [1, 2, 3, 4], sampleRate: 24000, channels: 1, dest: "/tmp/gemini/voice.wav" },
  ]);
});

test("synthesizeGemini honors a model override", async () => {
  let body;
  await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "k",
      model: "gemini-2.5-pro-preview-tts",
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return geminiResponse([0, 0]);
      },
      pcmToWav: () => true,
    },
  );
  assert.equal(body.model, "gemini-2.5-pro-preview-tts");
});

test("synthesizeGemini routes container audio through ffmpeg's format detection", async () => {
  let transcoded = null;
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "k",
      fetch: async () =>
        geminiResponse(Buffer.from("RIFF....WAVEfmt "), { mime_type: "audio/wav" }),
      transcodeToWav: (bytes) => {
        transcoded = Buffer.from(bytes).toString("latin1");
        return true;
      },
      pcmToWav: () => assert.fail("a wav container must not be re-wrapped as raw PCM"),
    },
  );
  assert.equal(res.ok, true);
  assert.match(transcoded, /^RIFF/);
});

test("synthesizeGemini fetches uri-delivered audio", async () => {
  const urls = [];
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "k",
      fetch: async (url) => {
        urls.push(url);
        if (url === "https://files.example/a.wav") {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            steps: [
              {
                type: "model_output",
                content: [
                  { type: "audio", uri: "https://files.example/a.wav", mime_type: "audio/wav" },
                ],
              },
            ],
          }),
        };
      },
      transcodeToWav: () => true,
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(urls.slice(1), ["https://files.example/a.wav"]);
});

test("synthesizeGemini surfaces Google's error message on a non-2xx", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "bad",
      fetch: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
          }),
      }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 400/);
  assert.match(res.error, /API key not valid/);
});

test("synthesizeGemini reports a reply with no audio block", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "k",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          steps: [{ type: "model_output", content: [{ type: "text", text: "…" }] }],
        }),
      }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio content/);
});

test("synthesizeGemini reports an ffmpeg wrap failure", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    { apiKey: () => "k", fetch: async () => geminiResponse([1, 2]), pcmToWav: () => false },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "wav transcode failed (ffmpeg)");
});

test("synthesizeGemini surfaces a thrown fetch error instead of swallowing it", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", wavAbs: "/tmp/x.wav" },
    {
      apiKey: () => "k",
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOTFOUND/);
});

test("synthesizeOne(gemini) fails fast with the key hint when no Gemini key is set", async () => {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const res = await synthesizeOne({
      provider: "gemini",
      text: "hi",
      voiceId: "Kore",
      wavAbs: "/tmp/never.wav",
      hyperframesDir: "/tmp",
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /GEMINI_API_KEY/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
