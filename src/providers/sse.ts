export interface ServerSentEvent {
  event?: string;
  data: string;
}

/** Standards-compliant enough for CRLF, comments, split chunks and multi-line data. */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let firstLine = true;

  const consumeLine = (line: string): ServerSentEvent | undefined => {
    if (line === "") {
      if (dataLines.length === 0) {
        eventName = undefined;
        return undefined;
      }
      const event = { ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") };
      dataLines = [];
      eventName = undefined;
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    if (field === "event") eventName = value;
    return undefined;
  };

  const takeLine = (atEnd: boolean): string | undefined => {
    let boundary = -1;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] === "\n" || buffer[index] === "\r") {
        boundary = index;
        break;
      }
    }
    if (boundary < 0) return undefined;
    if (buffer[boundary] === "\r" && boundary === buffer.length - 1 && !atEnd) {
      return undefined;
    }
    const line = buffer.slice(0, boundary);
    const width = buffer[boundary] === "\r" && buffer[boundary + 1] === "\n" ? 2 : 1;
    buffer = buffer.slice(boundary + width);
    if (firstLine) {
      firstLine = false;
      return line.startsWith("\uFEFF") ? line.slice(1) : line;
    }
    return line;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const line = takeLine(false);
        if (line === undefined) break;
        const event = consumeLine(line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    while (true) {
      const line = takeLine(true);
      if (line === undefined) break;
      const event = consumeLine(line);
      if (event) yield event;
    }
    if (buffer) {
      let line = buffer;
      buffer = "";
      if (firstLine && line.startsWith("\uFEFF")) line = line.slice(1);
      firstLine = false;
      const event = consumeLine(line);
      if (event) yield event;
    }
    const finalEvent = consumeLine("");
    if (finalEvent) yield finalEvent;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

