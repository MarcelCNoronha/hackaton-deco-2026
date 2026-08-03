import { Link } from "react-router-dom";
import type { Connection } from "../api/client";

interface ToolStatusGridProps {
  connections: Connection[];
  catalogPlatform: "vtex" | "shopify";
  /** Only link cards to the Integrações panel when the viewer actually has access to it. */
  canManage: boolean;
}

const TOOL_LABELS: Record<Connection["provider"], string> = {
  vtex: "VTEX",
  shopify: "Shopify",
  google: "Google (Search Console / GA4)",
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
};

/** Binary, at-a-glance status per tool the pipeline depends on — green only when actually
 *  connected, red for anything else (never connected, or connected but the last test failed),
 *  since "quase conectada" still blocks a run the same way a missing connection does. */
export function ToolStatusGrid({ connections, catalogPlatform, canManage }: ToolStatusGridProps) {
  const statusByProvider = new Map(connections.map((c) => [c.provider, c.status]));
  const providers: Connection["provider"][] = [catalogPlatform, "google", "anthropic", "openai", "gemini"];

  return (
    <div className="tool-status-grid">
      {providers.map((provider) => {
        const active = statusByProvider.get(provider) === "connected";
        const card = (
          <div className={`tool-status-card ${active ? "is-active" : "is-inactive"}`}>
            <span className="tool-status-dot" aria-hidden="true" />
            <div>
              <div className="tool-status-label">{TOOL_LABELS[provider]}</div>
              <div className="tool-status-state">{active ? "Ativa" : "Inativa"}</div>
            </div>
          </div>
        );
        return canManage ? (
          <Link key={provider} to="/connections" className="tool-status-link">
            {card}
          </Link>
        ) : (
          <div key={provider}>{card}</div>
        );
      })}
    </div>
  );
}
