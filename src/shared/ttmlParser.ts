// src/shared/ttmlParser.ts

export type Cue = {
  start: number;
  end: number;
  text: string;
};

export type TtmlMeta = {
  lang?: string;
  tickRate: number;
  timeBase?: string;
  contentProfiles?: string;

  // Netflix metadata (optional)
  nttm?: Record<string, string>;
};

export type TtmlRegion = {
  id: string;
  displayAlign?: string; // before/after/center
  origin?: string;       // "10.000% 10.000%"
  extent?: string;       // "80.000% 80.000%"

  // Parsed numeric values (percent-based)
  originX?: number; // 0~100
  originY?: number; // 0~100
  extentW?: number; // 0~100
  extentH?: number; // 0~100
};

export type TtmlStyle = {
  id: string;
  fontStyle?: string;   // italic
  fontWeight?: string;  // normal/bold
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  textAlign?: string;
  textOutline?: string;
  writingMode?: string;
  opacity?: string;
  showBackground?: string;
  displayAlign?: string;
  origin?: string;
  extent?: string;
};

export type TtmlCue = Cue & {
  id?: string;          // xml:id
  region?: string;      // region0/region1
  style?: string;       // style0/style1
  raw?: string;         // optional: 원문 텍스트(디버깅)

  // Resolved region coordinates (for ordering/visualization)
  regionX?: number; // originX
  regionY?: number; // originY
};

export type TtmlDocument = {
  meta: TtmlMeta;
  regions: Record<string, TtmlRegion>;
  styles: Record<string, TtmlStyle>;
  cues: TtmlCue[];
};

export type TtmlSubtitle = {
  cues: TtmlCue[];
  styles: Record<string, TtmlStyle>;
}

export function parseTtml(ttml: string): TtmlDocument {
  const doc = new DOMParser().parseFromString(ttml, "text/xml");

  // 파싱 에러 방어
  const parseError = doc.getElementsByTagName("parsererror")?.[0];
  if (parseError) {
    return {
      meta: { tickRate: 1 },
      regions: {},
      styles: {},
      cues: [],
    };
  }

  const tt = doc.documentElement; // <tt ...>

  // ---- meta ----
  const tickRateAttr =
    tt.getAttribute("ttp:tickRate") || tt.getAttribute("tickRate") || "1";
  const tickRate = Number(tickRateAttr) || 1;

  const meta: TtmlMeta = {
    tickRate,
    lang: tt.getAttribute("xml:lang") || undefined,
    timeBase: tt.getAttribute("ttp:timeBase") || tt.getAttribute("timeBase") || undefined,
    contentProfiles:
      tt.getAttribute("ttp:contentProfiles") ||
      tt.getAttribute("contentProfiles") ||
      undefined,
  };

  // Netflix <metadata ...> 속성들 긁어오기 (nttm:* 전부)
  const metadataEl = doc.getElementsByTagName("metadata")?.[0];
  if (metadataEl) {
    const nttm: Record<string, string> = {};
    for (const a of Array.from(metadataEl.attributes)) {
      // 예: nttm:movieID, nttm:textType, nttm:uuid ...
      if (a.name.startsWith("nttm:")) nttm[a.name] = a.value;
    }
    if (Object.keys(nttm).length > 0) meta.nttm = nttm;
  }

  // ---- layout/regions ----
  // Regions are stored in two forms:
  // - raw strings (origin/extent) as provided by TTML
  // - parsed numeric percent pairs (originX/originY/extentW/extentH) for easy ordering & visualization
  const parsePercentPair = (v?: string): { a: number; b: number } | null => {
    if (!v) return null;
    const parts = v.trim().split(/\s+/);
    if (parts.length < 2) return null;

    const toNum = (s: string): number => {
      // handles "62.500%" -> 62.5
      const n = s.endsWith("%") ? s.slice(0, -1) : s;
      const x = Number(n);
      return Number.isFinite(x) ? x : NaN;
    };

    const a = toNum(parts[0]);
    const b = toNum(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { a, b };
  };

  const regions: Record<string, TtmlRegion> = {};
  for (const r of Array.from(doc.getElementsByTagName("region"))) {
    const id = r.getAttribute("xml:id") || r.getAttribute("id");
    if (!id) continue;

    const origin = r.getAttribute("tts:origin") || r.getAttribute("origin") || undefined;
    const extent = r.getAttribute("tts:extent") || r.getAttribute("extent") || undefined;

    const o = parsePercentPair(origin);
    const e = parsePercentPair(extent);

    regions[id] = {
      id,
      displayAlign: r.getAttribute("tts:displayAlign") || r.getAttribute("displayAlign") || undefined,
      origin,
      extent,
      originX: o?.a,
      originY: o?.b,
      extentW: e?.a,
      extentH: e?.b,
    };
  }

  // ---- styling/styles ----
  const styles: Record<string, TtmlStyle> = {};

  // <initial ...> 도 전역 스타일처럼 보관 (id는 "__initial")
  const initialEl = doc.getElementsByTagName("initial")?.[0];
  if (initialEl) {
    styles["__initial"] = {
      id: "__initial",
      ...readStyleAttributes(initialEl),
    };
  }

  for (const s of Array.from(doc.getElementsByTagName("style"))) {
    const id = s.getAttribute("xml:id") || s.getAttribute("id");
    if (!id) continue;

    styles[id] = {
      id,
      ...readStyleAttributes(s),
    };
  }

  // ---- time conversion ----
  const toSec = (v: string): number => {
    v = v.trim();
    if (v.endsWith("t")) return Number(v.slice(0, -1)) / tickRate; // ticks
    // "hh:mm:ss.mmm" 대비
    const m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    // "s" (seconds) 같은 케이스 대비
    if (v.endsWith("s")) return Number(v.slice(0, -1));
    return NaN;
  };

  // ---- cues (<p>) ----
  const isNotNull = <T>(v: T | null | undefined): v is T => v != null;

  const cues: TtmlCue[] = Array.from(doc.getElementsByTagName("p"))
    .map((p): TtmlCue | null => {
      const begin = p.getAttribute("begin");
      const end = p.getAttribute("end");
      if (!begin || !end) return null;

      const start = toSec(begin);
      const finish = toSec(end);
      if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;

      // 텍스트 추출: <br/>를 줄바꿈으로 보존하고 싶으면 아래 방식이 안전함
      const text = extractPText(p);
      if (!text) return null;

      const id = p.getAttribute("xml:id") || undefined;
      const region = p.getAttribute("region") || undefined;
      const style = p.getAttribute("style") || undefined;

      const regionInfo = region ? regions[region] : undefined;

      return {
        start,
        end: finish,
        text,
        id,
        region,
        style,
        regionX: regionInfo?.originX,
        regionY: regionInfo?.originY,
      };
    })
    .filter(isNotNull);

  return { meta, regions, styles, cues };
}

export function parseTtmlSubtitle(ttml: string):TtmlSubtitle{
  const cues = parseTtml(ttml).cues;
  const styles = parseTtml(ttml).styles;
  return { cues,styles }
}

// 기존 함수는 이제 이렇게 얇게 유지 가능
export function parseTtmlToCues(ttml: string): Cue[] {
  return parseTtml(ttml).cues;
}

// -------- helpers --------

function readStyleAttributes(el: Element): Omit<TtmlStyle, "id"> {
  // 필요한 것만 추리되, Netflix TTML에서 자주 쓰는 tts:* 위주
  return {
    fontStyle: el.getAttribute("tts:fontStyle") || el.getAttribute("fontStyle") || undefined,
    fontWeight: el.getAttribute("tts:fontWeight") || el.getAttribute("fontWeight") || undefined,
    color: el.getAttribute("tts:color") || el.getAttribute("color") || undefined,
    backgroundColor:
      el.getAttribute("tts:backgroundColor") || el.getAttribute("backgroundColor") || undefined,
    fontSize: el.getAttribute("tts:fontSize") || el.getAttribute("fontSize") || undefined,
    textAlign: el.getAttribute("tts:textAlign") || el.getAttribute("textAlign") || undefined,
    textOutline: el.getAttribute("tts:textOutline") || el.getAttribute("textOutline") || undefined,
    writingMode: el.getAttribute("tts:writingMode") || el.getAttribute("writingMode") || undefined,
    opacity: el.getAttribute("tts:opacity") || el.getAttribute("opacity") || undefined,
    showBackground:
      el.getAttribute("tts:showBackground") || el.getAttribute("showBackground") || undefined,
    displayAlign: el.getAttribute("tts:displayAlign") || el.getAttribute("displayAlign") || undefined,
    origin: el.getAttribute("tts:origin") || el.getAttribute("origin") || undefined,
    extent: el.getAttribute("tts:extent") || el.getAttribute("extent") || undefined,
  };
}

function extractPText(p: Element): string {
  // <p> 내부에서 <br/>를 '\n'로, 나머지는 textContent 기반으로 정리
  // - 단순 textContent는 줄바꿈이 사라질 수 있어서 br를 수동 처리
  const parts: string[] = [];
  for (const node of Array.from(p.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName.toLowerCase() === "br") {
        parts.push("\n");
      } else {
        // <span> 등은 내부 텍스트만
        parts.push((el.textContent || "").replace(/\s+/g, " ").trim());
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
  }

  const joined = parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return joined;
}