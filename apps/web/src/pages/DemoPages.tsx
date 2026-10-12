import { useSearchParams, Link } from "react-router";
import { DEMO_ASSETS, s0DemoDeck } from "@kj/fixtures";
import { DEFAULT_THEME } from "@kj/schema";
import { DeckPlayer, DeckSpeaker, SlideThumb } from "../components/deck.tsx";

const SYNC = "s0-demo";

export function DemoGridPage() {
  return (
    <div className="stack">
      <section className="hero card">
        <div>
          <h1>S0 放映示例 · Waves 波</h1>
          <p className="muted">
            10 页手写样张：中英混排、术语框、表格、公式、图片、受力图、PhET 实验、分步出现、点击揭示。键盘 ←/→ 翻页，F 全屏，S 打开演讲者视图。
          </p>
        </div>
        <div className="row">
          <Link className="btn primary" to="/demo/play">
            ▶ 放映 Present
          </Link>
          <a className="btn" href="/demo/speaker" target="kj-speaker">
            演讲者视图 Speaker view
          </a>
        </div>
      </section>
      <div className="grid thumbs" data-testid="demo-grid">
        {s0DemoDeck.slides.map((s, i) => (
          <Link key={s.id} to={`/demo/play?slide=${i + 1}`}>
            <SlideThumb slide={s} theme={DEFAULT_THEME} assets={DEMO_ASSETS} label={`${i + 1}. ${s.layoutId}`} />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DemoPlayPage() {
  const [params] = useSearchParams();
  const index = Math.max(0, Number(params.get("slide") ?? 1) - 1);
  const step = Number(params.get("step") ?? 0);
  return (
    <div className="fullscreen">
      <DeckPlayer deck={s0DemoDeck} theme={DEFAULT_THEME} mode="present" assets={DEMO_ASSETS} syncKey={SYNC} speakerUrl="/demo/speaker" start={{ index, step }} />
      <Link className="exit-link" to="/demo">
        ✕
      </Link>
    </div>
  );
}

export function DemoSpeakerPage() {
  return (
    <div className="fullscreen">
      <DeckSpeaker deck={s0DemoDeck} theme={DEFAULT_THEME} assets={DEMO_ASSETS} syncKey={SYNC} />
    </div>
  );
}
