import { type Cue } from "./protocol";

export function parseTtmlToCues(ttml: string): Cue[] {
  const doc = new DOMParser().parseFromString(ttml, "text/xml");

  const tt = doc.documentElement; // <tt ...>
  const tickRateAttr =
    tt.getAttribute("ttp:tickRate") || tt.getAttribute("tickRate") || "1";
  const tickRate = Number(tickRateAttr) || 1;

  const ps = Array.from(doc.getElementsByTagName("p"));

  const toSec = (v: string): number => {
    v = v.trim();
    if (v.endsWith("t")) return Number(v.slice(0, -1)) / tickRate; // ticks
    // fallback: "hh:mm:ss.mmm" 형태도 대비
    const m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return NaN;
  };

  return ps
    .map((p) => {
      const begin = p.getAttribute("begin");
      const end = p.getAttribute("end");
      if (!begin || !end) return null;

      const text = (p.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return null;

      const start = toSec(begin);
      const finish = toSec(end);
      if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;

      return { start, end: finish, text } satisfies Cue;
    })
    .filter((x): x is Cue => !!x);
}