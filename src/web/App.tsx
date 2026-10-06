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
        {tab === "Setup" && <SetupPage />}
        {tab === "Actions" && <ActionsPage />}
        {tab === "Rules" && <RulesPage />}
        {tab === "Context" && <ContextPage />}
        {tab === "Live" && <LivePage />}
      </main>
    </div>
  );
}
