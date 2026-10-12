/** Sentences long enough to teach from; CJK and Latin punctuation both split. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 260);
}

/** First `max` words without trailing punctuation (CJK: max × 1.7 characters). */
export function clip(text: string, max: number): string {
  const s = text.replace(/[.!?。！？;；,，:：]+$/, "").trim();
  if (/[\u3400-\u9fff]/.test(s)) return s.slice(0, Math.floor(max * 1.7));
  return s.split(/\s+/).slice(0, max).join(" ").replace(/[,;:]$/, "");
}

const TERMS_ZH: Record<string, string> = {
  wave: "波",
  amplitude: "振幅",
  wavelength: "波长",
  frequency: "频率",
  period: "周期",
  speed: "速度",
  energy: "能量",
  transverse: "横波",
  longitudinal: "纵波",
  compression: "压缩",
  rarefaction: "稀疏",
  medium: "介质",
  vacuum: "真空",
  echo: "回声",
  ultrasound: "超声波",
  pitch: "音调",
  loudness: "响度",
  reflection: "反射",
  oscillation: "振动",
  displacement: "位移",
  spectrum: "光谱",
  force: "力",
  mass: "质量",
  acceleration: "加速度",
  cell: "细胞",
  membrane: "膜",
  nucleus: "细胞核",
  photosynthesis: "光合作用",
  chlorophyll: "叶绿素",
  mole: "摩尔",
};

/** Deterministic glossary for the stubs: known terms that occur in the text, in a fixed order. */
export function glossaryFrom(text: string, max: number): { term: string; zh: string }[] {
  const lower = text.toLowerCase();
  return Object.entries(TERMS_ZH)
    .filter(([term]) => new RegExp(`\\b${term}s?\\b`).test(lower))
    .slice(0, max)
    .map(([term, zh]) => ({ term, zh }));
}

const QUANTITIES: [term: string, symbol: string, unit: string][] = [
  ["wave speed", "v", "m/s"],
  ["frequency", "f", "Hz"],
  ["wavelength", "λ", "m"],
  ["amplitude", "A", "m"],
  ["period", "T", "s"],
  ["force", "F", "N"],
  ["mass", "m", "kg"],
  ["acceleration", "a", "m/s²"],
  ["energy", "E", "J"],
  ["power", "P", "W"],
  ["current", "I", "A"],
  ["voltage", "V", "V"],
  ["resistance", "R", "Ω"],
];

/** Physical quantities named in the text, with symbol and SI unit, in a fixed order (stub tables). */
export function quantitiesIn(text: string): { term: string; symbol: string; unit: string }[] {
  const lower = text.toLowerCase();
  return QUANTITIES.filter(([term]) => new RegExp(`\\b${term}s?\\b`).test(lower)).map(([term, symbol, unit]) => ({ term, symbol, unit }));
}
