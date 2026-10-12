/** Seed physics glossary used by the stub provider and as a hint for real models. */
export const PHYSICS_GLOSSARY: Record<string, string> = {
  wave: "波",
  amplitude: "振幅",
  wavelength: "波长",
  frequency: "频率",
  period: "周期",
  "wave speed": "波速",
  "transverse wave": "横波",
  "longitudinal wave": "纵波",
  oscillation: "振动",
  vibration: "振动",
  crest: "波峰",
  trough: "波谷",
  compression: "密部",
  rarefaction: "疏部",
  reflection: "反射",
  refraction: "折射",
  diffraction: "衍射",
  interference: "干涉",
  "electromagnetic spectrum": "电磁波谱",
  "electromagnetic wave": "电磁波",
  sound: "声音",
  echo: "回声",
  ultrasound: "超声波",
  pitch: "音调",
  loudness: "响度",
  medium: "介质",
  energy: "能量",
  displacement: "位移",
  velocity: "速度",
  acceleration: "加速度",
  force: "力",
  mass: "质量",
  momentum: "动量",
  tension: "张力",
  damping: "阻尼",
  hertz: "赫兹",
  vacuum: "真空",
  "normal line": "法线",
  "angle of incidence": "入射角",
  "angle of refraction": "折射角",
  "critical angle": "临界角",
  "total internal reflection": "全反射",
};

export function findGlossaryTerms(text: string, limit = 5): { term: string; zh: string }[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ")} `;
  const hits: { term: string; zh: string; at: number }[] = [];
  const keys = Object.keys(PHYSICS_GLOSSARY).sort((a, b) => b.length - a.length);
  const taken: string[] = [];
  for (const key of keys) {
    const m = new RegExp(` ${key}(?:s|es)? `).exec(lower);
    if (!m) continue;
    if (taken.some((t) => t.includes(key))) continue;
    taken.push(key);
    hits.push({ term: key, zh: PHYSICS_GLOSSARY[key]!, at: m.index });
  }
  return hits
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ term, zh }) => ({ term, zh }));
}
