import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate, useParams } from "react-router";
import { AuthProvider, RequireAuth, useAuth } from "./auth.tsx";
import { AdminPage } from "./pages/AdminPage.tsx";
import { TextbooksPage } from "./pages/TextbooksPage.tsx";
import { ChangePasswordPage, LoginPage } from "./pages/AuthPages.tsx";
import { LessonPage } from "./pages/LessonPage.tsx";
import { LessonsPage } from "./pages/LessonsPage.tsx";
import { PlayPage, SharePage } from "./pages/PlayPages.tsx";
import { PresenterPage } from "./pages/PresenterPage.tsx";
import { ChaptersStep } from "./pages/wizard/ChaptersStep.tsx";
import { UploadStep } from "./pages/wizard/UploadStep.tsx";

function Shell({ children }: { children: ReactNode }) {
  const { me, ai, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">〰</span> AI 课件工坊
        </Link>
        <nav>
          {me && (
            <NavLink to="/" end>
              我的课 Lessons
            </NavLink>
          )}
          {me && <NavLink to="/textbooks">教材 Textbooks</NavLink>}
          {me?.role === "admin" && <NavLink to="/admin">后台 Admin</NavLink>}
        </nav>
        <div className="topbar-user">
          {me ? (
            <>
              <span>{me.displayName ?? me.username}</span>
              <button
                className="btn ghost small"
                onClick={async () => {
                  await logout();
                  nav("/login");
                }}
              >
                退出 Log out
              </button>
            </>
          ) : (
            <Link to="/login" className="btn small">
              登录 Log in
            </Link>
          )}
        </div>
      </header>
      {me && ai === "stub" && (
        <div className="stub-banner" role="status" data-testid="stub-banner">
          演示模式：还没有配置 AI 模型，大纲和幻灯片由内置模板生成，不是 AI 写的
          {me.role === "admin" ? (
            <>
              {" "}· <Link to="/admin">去后台配置模型</Link>
            </>
          ) : (
            "，请联系管理员配置"
          )}{" "}
          · Demo mode: no AI model configured — outlines and slides come from built-in templates, not AI.
        </div>
      )}
      {me && ai === "off" && (
        <div className="stub-banner" role="status" data-testid="ai-off-banner">
          还没有配置 AI 模型，暂时无法生成大纲和幻灯片{me.role === "admin" ? "，请到后台配置" : "，请联系管理员"} · No AI model configured yet; generation is unavailable.
        </div>
      )}
      <main className="content">{children}</main>
    </div>
  );
}

function NewChapters() {
  const { docId = "" } = useParams();
  return <ChaptersStep key={docId} documentId={docId} reached="chapters" />;
}

const devRoutes = __KJ_DEV_PAGES__
  ? (() => {
      const GalleryPage = lazy(() => import("./pages/dev/GalleryPage.tsx").then((m) => ({ default: m.GalleryPage })));
      const RenderPage = lazy(() => import("./pages/dev/RenderPage.tsx").then((m) => ({ default: m.RenderPage })));
      const PlayerPage = lazy(() => import("./pages/dev/PlayerPage.tsx").then((m) => ({ default: m.PlayerPage })));
      return [
        <Route key="gallery" path="/dev/gallery" element={<Suspense><GalleryPage /></Suspense>} />,
        <Route key="render" path="/dev/render" element={<Suspense><RenderPage /></Suspense>} />,
        <Route key="player" path="/dev/player" element={<Suspense><PlayerPage /></Suspense>} />,
      ];
    })()
  : [];

const authed = (node: ReactNode, admin = false) => (
  <RequireAuth admin={admin}>
    <Shell>{node}</Shell>
  </RequireAuth>
);

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/s/:token" element={<SharePage />} />
          {devRoutes}
          <Route path="/play/:id" element={<RequireAuth><PlayPage /></RequireAuth>} />
          <Route path="/presenter/:id" element={<RequireAuth><PresenterPage /></RequireAuth>} />
          <Route path="/admin" element={authed(<AdminPage />, true)} />
          <Route path="/textbooks" element={authed(<TextbooksPage />)} />
          <Route path="/new" element={authed(<UploadStep />)} />
          <Route path="/new/:docId" element={authed(<NewChapters />)} />
          <Route path="/lessons/:id/:step?" element={authed(<LessonPage />)} />
          <Route path="/" element={authed(<LessonsPage />)} />
          <Route path="*" element={<Shell><div className="card narrow">Page not found · 页面不存在</div></Shell>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
