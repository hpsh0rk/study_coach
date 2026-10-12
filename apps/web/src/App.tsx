import type { ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate, useParams } from "react-router";
import { AuthProvider, RequireAuth, useAuth } from "./auth.tsx";
import { AdminPage } from "./pages/AdminPage.tsx";
import { ChangePasswordPage, LoginPage } from "./pages/AuthPages.tsx";
import { GalleryPage } from "./pages/dev/GalleryPage.tsx";
import { RenderPage } from "./pages/dev/RenderPage.tsx";
import { LessonPage } from "./pages/LessonPage.tsx";
import { LessonsPage } from "./pages/LessonsPage.tsx";
import { PlayPage, SharePage } from "./pages/PlayPages.tsx";
import { PresenterPage } from "./pages/PresenterPage.tsx";
import { ChaptersStep } from "./pages/wizard/ChaptersStep.tsx";
import { UploadStep } from "./pages/wizard/UploadStep.tsx";

function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
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
      <main className="content">{children}</main>
    </div>
  );
}

function NewChapters() {
  const { docId = "" } = useParams();
  return <ChaptersStep key={docId} documentId={docId} reached="chapters" />;
}

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
          <Route path="/dev/gallery" element={<GalleryPage />} />
          <Route path="/dev/render" element={<RenderPage />} />
          <Route path="/play/:id" element={<RequireAuth><PlayPage /></RequireAuth>} />
          <Route path="/presenter/:id" element={<RequireAuth><PresenterPage /></RequireAuth>} />
          <Route path="/admin" element={authed(<AdminPage />, true)} />
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
