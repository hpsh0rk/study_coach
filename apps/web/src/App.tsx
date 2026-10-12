import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from "react-router";
import { AuthProvider, RequireAuth, useAuth } from "./auth.tsx";
import { AdminPage } from "./pages/AdminPage.tsx";
import { ChangePasswordPage, LoginPage } from "./pages/AuthPages.tsx";
import { DemoGridPage, DemoPlayPage, DemoSpeakerPage } from "./pages/DemoPages.tsx";
import { PlayPage, SpeakerPage } from "./pages/PlayPages.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { SharePage } from "./pages/SharePage.tsx";
import type { ReactNode } from "react";

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
          {me && <NavLink to="/" end>备课 Projects</NavLink>}
          <NavLink to="/demo">放映示例 Demo</NavLink>
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

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route path="/demo/play" element={<DemoPlayPage />} />
          <Route path="/demo/speaker" element={<DemoSpeakerPage />} />
          <Route path="/demo" element={<Shell><DemoGridPage /></Shell>} />
          <Route path="/play/:id" element={<RequireAuth><PlayPage /></RequireAuth>} />
          <Route path="/speaker/:id" element={<RequireAuth><SpeakerPage /></RequireAuth>} />
          <Route path="/admin" element={<RequireAuth admin><Shell><AdminPage /></Shell></RequireAuth>} />
          <Route path="/projects/:id" element={<RequireAuth><Shell><ProjectPage /></Shell></RequireAuth>} />
          <Route path="/" element={<RequireAuth><Shell><ProjectsPage /></Shell></RequireAuth>} />
          <Route path="*" element={<Shell><div className="card narrow">Page not found · 页面不存在</div></Shell>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
