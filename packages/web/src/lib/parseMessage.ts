export type InlineSeg =
  | { kind: "text"; text: string }
  | { kind: "mention"; id: string }
  | { kind: "code"; text: string }
  | { kind: "file"; path: string };

export type Block =
  | { kind: "para"; segments: InlineSeg[] }
  | { kind: "codeblock"; lines: string[] };

const FILE_RE = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,8}(?::\d+)?/;
const MENTION_RE = /@([\w-]+)/;
const CODE_RE = /`([^`]+)`/;

function parseInline(text: string, known: Set<string>): InlineSeg[] {
  const segs: InlineSeg[] = [];
  let rest = text;
  while (rest.length > 0) {
    const code = CODE_RE.exec(rest);
    const file = FILE_RE.exec(rest);
    const mention = MENTION_RE.exec(rest);
    const cands = [
      code && { idx: code.index, len: code[0].length, seg: { kind: "code", text: code[1] } as InlineSeg },
      file && { idx: file.index, len: file[0].length, seg: { kind: "file", path: file[0] } as InlineSeg },
      mention && known.has(mention[1])
        ? { idx: mention.index, len: mention[0].length, seg: { kind: "mention", id: mention[1] } as InlineSeg }
        : null,
    ].filter(Boolean) as Array<{ idx: number; len: number; seg: InlineSeg }>;

    if (cands.length === 0) {
      segs.push({ kind: "text", text: rest });
      break;
    }
    const next = cands.reduce((a, b) => (b.idx < a.idx ? b : a));
    if (next.idx > 0) segs.push({ kind: "text", text: rest.slice(0, next.idx) });
    segs.push(next.seg);
    rest = rest.slice(next.idx + next.len);
  }
  return segs;
}

export function parseMessageBody(body: string, knownAgentIds: string[]): Block[] {
  const known = new Set(knownAgentIds);
  const blocks: Block[] = [];
  const parts = body.split(/```/);
  parts.forEach((part, i) => {
    const fenced = i % 2 === 1;
    if (fenced) {
      const lines = part.replace(/^\n/, "").replace(/\n$/, "").split("\n");
      blocks.push({ kind: "codeblock", lines });
    } else if (part.trim().length > 0) {
      for (const line of part.split("\n")) {
        if (line.trim().length === 0) continue;
        blocks.push({ kind: "para", segments: parseInline(line, known) });
      }
    }
  });
  return blocks;
}
