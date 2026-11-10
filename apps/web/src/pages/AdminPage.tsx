import { useReducer, useState } from "react";
import { AiPanel } from "./admin/AiTab.tsx";
import { CriticalBanner, Overview } from "./admin/OverviewTab.tsx";
import { ParsingPanel } from "./admin/ParsingTab.tsx";
import { UsersPanel } from "./admin/UsersTab.tsx";
import type { AdminTab } from "./admin/types.ts";

export function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [saved, bump] = useReducer((n: number) => n + 1, 0);
  return (
    <div className="stack">
      <div className="row between">
        <h1>后台管理 Admin</h1>
        <div className="tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")} data-testid="admin-tab-overview">
            概览 Overview
          </button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")} data-testid="admin-tab-users">
            白名单账号 Users
          </button>
          <button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")} data-testid="admin-tab-ai">
            AI 模型 Models
          </button>
          <button className={tab === "parsing" ? "active" : ""} onClick={() => setTab("parsing")} data-testid="admin-tab-parsing">
            外部解析服务 Parsing
          </button>
        </div>
      </div>
      {tab === "overview" ? (
        <Overview saved={saved} open={setTab} />
      ) : (
        <>
          {tab !== "ai" && <CriticalBanner saved={saved} open={setTab} />}
          {tab === "users" ? <UsersPanel /> : tab === "ai" ? <AiPanel onSaved={bump} /> : <ParsingPanel onSaved={bump} />}
        </>
      )}
    </div>
  );
}
