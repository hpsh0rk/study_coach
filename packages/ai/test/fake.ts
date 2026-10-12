import { createAiLayer, type AiCallRecord, type ChatMessage } from "../src/index.ts";

/** An AI layer backed by a scripted OpenAI-compatible endpoint; records every request. */
export function fakeAi(replies: unknown[]) {
  const requests: ChatMessage[][] = [];
  const calls: AiCallRecord[] = [];
  let i = 0;
  const ai = createAiLayer({
    config: {
      load: async () => ({
        providers: [{ id: "p", kind: "custom", name: "Fake", baseUrl: "http://fake.test/v1", apiKey: "k", enabled: true }],
        routes: { default: { primary: { providerId: "p", model: "fake-1" } } },
      }),
    },
    meter: { record: async (r) => void calls.push(r) },
    allowStubFallback: false,
    fetch: async (_url, init) => {
      requests.push((JSON.parse(String(init.body)) as { messages: ChatMessage[] }).messages);
      const reply = replies[Math.min(i++, replies.length - 1)];
      return new Response(JSON.stringify({ model: "fake-1", choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    },
  });
  return { ai, requests, calls };
}
