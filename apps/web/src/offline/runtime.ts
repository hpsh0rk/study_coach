import "katex/dist/katex.min.css";
import "@kj/templates/slides.css";
import "@kj/player/player.css";
import "./runtime.css";
import { answerKey, keyAction, Player, type PlayerSlide, type Position } from "@kj/player";
import type { ThemeId } from "@kj/schema";
import { inlineEmbeds } from "@kj/widgets/render";

/** Deck data embedded in an offline file by `buildOfflineHtml`. */
export interface OfflineDeck {
  title: string;
  /** `student` files carry no notes; `teacher` files show notes only in a separate presenter window. */
  audience: "teacher" | "student";
  theme: ThemeId;
  pageLabels: Record<number, string>;
  slides: PlayerSlide[];
  /** Catalog simulation HTML by embed id, loaded via srcdoc. */
  sims: Record<string, string>;
}

const deck = JSON.parse(document.getElementById("kj-deck")!.textContent!) as OfflineDeck;
inlineEmbeds(deck.sims);
document.title = deck.title;

let presenter: Window | null = null;
let pos: Position = { index: 0, step: 0 };

function renderPresenter(): void {
  const doc = presenter && !presenter.closed ? presenter.document : null;
  if (!doc) return;
  const slide = deck.slides[pos.index]!;
  const next = deck.slides[pos.index + 1];
  doc.getElementById("kj-p-pos")!.textContent = `第 ${pos.index + 1} / ${deck.slides.length} 页`;
  doc.getElementById("kj-p-next")!.textContent = next ? `下一页 Next: ${"title" in next.content ? String(next.content.title) : next.pageType}` : "最后一页 Last slide";
  doc.getElementById("kj-p-notes")!.textContent = slide.notes || "—";
  const answers = answerKey(slide.content);
  const box = doc.getElementById("kj-p-answers")!;
  box.hidden = !answers.length;
  box.replaceChildren(...answers.map((a) => Object.assign(doc.createElement("li"), { textContent: a })));
}

/** Notes and answers live in their own window, so pressing a key on the projector never shows them to the class. */
function openPresenter(): void {
  if (presenter && !presenter.closed) return void presenter.focus();
  presenter = window.open("", "kj-offline-presenter", "width=720,height=640");
  if (!presenter) return;
  const doc = presenter.document;
  doc.title = `演讲者 Presenter · ${deck.title}`;
  doc.body.innerHTML =
    '<style>body{font:18px/1.5 system-ui,"Noto Sans SC",sans-serif;margin:24px;background:#0f172a;color:#e2e8f0}h1{font-size:16px;color:#94a3b8;margin:0 0 4px}#kj-p-notes{white-space:pre-wrap;font-size:22px}#kj-p-answers{background:#422006;color:#fde68a;padding:12px 12px 12px 32px;border-radius:8px}</style>' +
    '<h1 id="kj-p-pos"></h1><p id="kj-p-next" style="color:#94a3b8"></p><h1>讲稿 Notes</h1><div id="kj-p-notes"></div><h1 style="margin-top:16px">答案 Answer key</h1><ul id="kj-p-answers"></ul>' +
    '<p style="color:#64748b;font-size:14px">这个窗口留在笔记本屏幕上；→ / PageDown 翻页 · Keep this window on the laptop screen.</p>';
  doc.addEventListener("keydown", (e) => {
    const action = keyAction(e.key);
    if (action === "next") player.next();
    else if (action === "prev") player.prev();
    else return;
    e.preventDefault();
  });
  renderPresenter();
}

const player = new Player(document.getElementById("kj-root")!, {
  slides: deck.slides,
  theme: deck.theme,
  showNotes: false,
  pageLabels: deck.pageLabels,
  onChange: (p) => {
    pos = p;
    renderPresenter();
  },
});

if (deck.audience === "teacher") {
  const bar = document.querySelector(".kj-controls");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kj-ctl";
  btn.textContent = "演讲者窗口 Notes";
  btn.title = "Speaker notes in a separate window · 讲稿在单独的窗口里，不上投影";
  btn.dataset.testid = "offline-presenter";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPresenter();
  });
  bar?.append(btn);
}
void document.fonts.ready.then(() => (document.body.dataset.ready = "1"));
