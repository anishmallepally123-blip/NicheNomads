// Runs the Niche model (Qwen3 0.6B) off the main thread so the viewer stays
// smooth while it downloads and while it writes an answer. The weights come
// from Hugging Face the first time and are kept in the browser's cache after
// that, so later visits load from disk.
import { pipeline, TextStreamer, type TextGenerationPipeline } from "@huggingface/transformers";

const MODEL = "onnx-community/Qwen3-0.6B-ONNX";

type Msg = { role: "system" | "user" | "assistant"; content: string };
type In = { type: "load" } | { type: "ask"; id: number; messages: Msg[]; maxTokens: number };

let gen: Promise<TextGenerationPipeline> | null = null;

async function load(): Promise<TextGenerationPipeline> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const webgpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null));
  postMessage({ type: "device", device: webgpu ? "webgpu" : "wasm" });
  // q4f16 is the smallest file and fast on a GPU. Without WebGPU we fall back
  // to plain WebAssembly on the CPU, which needs the q4 file and is slower.
  return (await pipeline("text-generation", MODEL, {
    device: webgpu ? "webgpu" : "wasm",
    dtype: webgpu ? "q4f16" : "q4",
    progress_callback: (p) => {
      if (p.status === "progress_total") postMessage({ type: "progress", loaded: p.loaded, total: p.total });
    },
  })) as TextGenerationPipeline;
}

/** Qwen3 can "think" before answering; we switch that off, and strip any leftovers. */
const clean = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    gen ??= load();
    const g = await gen;
    if (m.type === "load") return postMessage({ type: "ready" });
    let text = "";
    const streamer = new TextStreamer(g.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (t: string) => {
        text += t;
        postMessage({ type: "token", id: m.id, text: clean(text) });
      },
    });
    const out = await g(m.messages, {
      max_new_tokens: m.maxTokens,
      do_sample: false,
      repetition_penalty: 1.1,
      streamer,
      tokenizer_encode_kwargs: { enable_thinking: false },
    });
    const chat = out[0].generated_text as Msg[];
    const last = chat[chat.length - 1];
    postMessage({ type: "done", id: m.id, text: clean(last?.content ?? text) });
  } catch (err) {
    if (m.type === "load") gen = null; // let a later click try again
    postMessage({ type: "error", id: m.type === "ask" ? m.id : undefined, error: String((err as Error)?.message ?? err) });
  }
};
