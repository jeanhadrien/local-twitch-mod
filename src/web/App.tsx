import { useState } from "react";
import { ActionsPage } from "./pages/Actions";
import { ContextPage } from "./pages/Context";
import { LivePage } from "./pages/Live";
import { RulesPage } from "./pages/Rules";
import { SetupPage } from "./pages/Setup";
import "./styles.css";

const TABS = ["Setup", "Actions", "Rules", "Context", "Live"] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>(() =>
    window.location.search.includes("twitch=ok") ? "Live" : "Setup",
  );
  return (
    <div className="app">
      <header>
        <h1>Klawz Chat Mod</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {/* Keep every page mounted and hide inactive ones so Live keeps its
            EventSource, feeds, and filter text across tab switches. */}
        <div style={{ display: tab === "Setup" ? "block" : "none" }}>
          <SetupPage />
        </div>
        <div style={{ display: tab === "Actions" ? "block" : "none" }}>
          <ActionsPage />
        </div>
        <div style={{ display: tab === "Rules" ? "block" : "none" }}>
          <RulesPage />
        </div>
        <div style={{ display: tab === "Context" ? "block" : "none" }}>
          <ContextPage />
        </div>
        <div style={{ display: tab === "Live" ? "block" : "none" }}>
          <LivePage />
        </div>
      </main>
    </div>
  );
}
