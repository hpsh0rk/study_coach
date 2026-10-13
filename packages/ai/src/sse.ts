/** Server-sent events from a fetch body: yields each event's `event` name and joined `data` lines. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) buffer += decoder.decode();
    let cut: RegExpExecArray | null;
    while ((cut = /\r?\n\r?\n/.exec(buffer))) {
      const ev = parse(buffer.slice(0, cut.index));
      buffer = buffer.slice(cut.index + cut[0].length);
      if (ev) yield ev;
    }
    if (done) {
      const ev = parse(buffer);
      if (ev) yield ev;
      return;
    }
  }
}
