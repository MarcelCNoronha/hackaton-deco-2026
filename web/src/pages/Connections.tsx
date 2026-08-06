import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CatalogPlatform,
  type Connection,
  type LlmProvider,
  type LlmTask,
  type ModelRoutingRow,
  type PriceTier,
  type ProviderRecommendations,
  type ProviderSpend,
} from "../api/client";
import { StatusBadge } from "../components/StatusBadge";

const CREDENTIAL_HELP_URL: Record<"vtex" | "shopify" | "anthropic" | "openai" | "gemini" | "google", string> = {
  vtex: "https://help.vtex.com/en/tutorial/using-rest-api-keys--2iRW4ohyz1UMEIUOWyC5YT",
  shopify: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  google: "https://console.cloud.google.com/apis/credentials",
};

const PLATFORM_LABELS: Record<CatalogPlatform, string> = {
  vtex: "VTEX",
  shopify: "Shopify",
};

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
};

const TIER_LABELS: Record<PriceTier, string> = {
  quality: "Qualidade",
  balanced: "Equilibrado",
  price: "Preço",
};

const TASKS: Array<{ key: LlmTask; label: string; hint: string }> = [
  {
    key: "contentEnrichment",
    label: "Enriquecimento de conteúdo",
    hint: "Gera descrição, FAQ, especificações, SEO e dados estruturados.",
  },
  {
    key: "imageAltText",
    label: "Alt-text de imagem",
    hint: "Tarefa simples de visão, boa candidata ao nível de menor custo.",
  },
  {
    key: "evaluator",
    label: "Evaluator",
    hint: "Avalia o conteúdo antes/depois. Idealmente usa um modelo diferente do gerador.",
  },
];

function CredentialHelpLink({ provider }: { provider: keyof typeof CREDENTIAL_HELP_URL }) {
  return (
    <a href={CREDENTIAL_HELP_URL[provider]} target="_blank" rel="noreferrer" className="credential-help-link">
      Onde pegar a chave →
    </a>
  );
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function findTier(recommendations: ProviderRecommendations, model: string): PriceTier {
  const match = (Object.entries(recommendations) as Array<[PriceTier, ProviderRecommendations[PriceTier]]>).find(
    ([, info]) => info.id === model,
  );
  return match?.[0] ?? "balanced";
}

function remainingLimit(spend: ProviderSpend | undefined): string {
  if (!spend?.limitUsd) return "Sem limite";
  return formatPrice(Math.max(0, spend.limitUsd - spend.spentUsd));
}

export function Connections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [recommendations, setRecommendations] = useState<Record<LlmProvider, ProviderRecommendations> | null>(null);
  const [routing, setRouting] = useState<ModelRoutingRow[]>([]);
  const [savingRouting, setSavingRouting] = useState(false);
  const [catalogPlatform, setCatalogPlatformState] = useState<CatalogPlatform>("vtex");
  const [spendLimits, setSpendLimits] = useState<ProviderSpend[]>([]);
  const [limitInputs, setLimitInputs] = useState<Record<LlmProvider, string>>({ anthropic: "", openai: "", gemini: "" });
  const [savingLimits, setSavingLimits] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [vtex, setVtex] = useState({
    displayName: "VTEX - mundialacabamentos",
    account: "",
    environment: "vtexcommercestable",
    appKey: "",
    appToken: "",
    storefrontDomain: "www.mundialacabamentos.com.br",
  });
  const [shopify, setShopify] = useState({ displayName: "Shopify", shopDomain: "", accessToken: "" });
  const [anthropic, setAnthropic] = useState({ displayName: "Anthropic (Claude)", apiKey: "" });
  const [openai, setOpenai] = useState({ displayName: "OpenAI (GPT)", apiKey: "" });
  const [gemini, setGemini] = useState({ displayName: "Google (Gemini)", apiKey: "" });
  const [google, setGoogle] = useState({
    displayName: "Google (GSC + GA4)",
    code: "",
    gscSiteUrl: "https://www.mundialacabamentos.com.br/",
    ga4PropertyId: "",
  });

  async function refreshConnections() {
    setConnections(await api.listConnections());
  }

  async function refreshSpendLimits() {
    const limits = await api.getSpendLimits();
    setSpendLimits(limits);
    setLimitInputs(
      Object.fromEntries(limits.map((l) => [l.provider, l.limitUsd !== null ? String(l.limitUsd) : ""])) as Record<LlmProvider, string>,
    );
  }

  useEffect(() => {
    refreshConnections();
    refreshSpendLimits();
    api.listModels().then((all) => setRecommendations(all as Record<LlmProvider, ProviderRecommendations>));
    api.getModelRouting().then(setRouting);
    api.getCatalogPlatform().then(({ platform }) => setCatalogPlatformState(platform));
  }, []);

  function statusFor(provider: Connection["provider"]) {
    return connections.find((c) => c.provider === provider)?.status ?? "untested";
  }

  async function handleVtexSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectVtex(vtex);
    setMessage(ok ? "VTEX conectada com sucesso." : `Falha ao conectar com a VTEX${error ? `: ${error}` : " - confira as credenciais."}`);
    refreshConnections();
  }

  async function handleShopifySubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectShopify(shopify);
    setMessage(ok ? "Shopify conectada com sucesso." : `Falha ao conectar com a Shopify${error ? `: ${error}` : " - confira o domínio/token."}`);
    refreshConnections();
  }

  async function handlePlatformChange(platform: CatalogPlatform) {
    setCatalogPlatformState(platform);
    await api.setCatalogPlatform(platform);
    setMessage(`Plataforma de catálogo ativa: ${PLATFORM_LABELS[platform]}.`);
  }

  async function handleGoogleAuth() {
    const { url } = await api.googleAuthUrl();
    window.open(url, "_blank");
  }

  async function handleGoogleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok } = await api.connectGoogle(google);
    setMessage(ok ? "Google Search Console + GA4 conectado com sucesso." : "Falha ao validar o Google - confira o código/propriedades.");
    refreshConnections();
  }

  async function handleAnthropicSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectAnthropic(anthropic);
    setMessage(ok ? "Anthropic conectado com sucesso." : `Falha ao validar a chave da Anthropic${error ? `: ${error}` : "."}`);
    refreshConnections();
  }

  async function handleOpenAiSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectOpenAi(openai);
    setMessage(ok ? "OpenAI conectado com sucesso." : `Falha ao validar a chave da OpenAI${error ? `: ${error}` : "."}`);
    refreshConnections();
  }

  async function handleGeminiSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectGemini(gemini);
    setMessage(ok ? "Gemini conectado com sucesso." : `Falha ao validar a chave do Gemini${error ? `: ${error}` : "."}`);
    refreshConnections();
  }

  function updateRouting(task: LlmTask, patch: Partial<ModelRoutingRow>) {
    setRouting((prev) => prev.map((row) => (row.task === task ? { ...row, ...patch } : row)));
  }

  function handleProviderChange(task: LlmTask, provider: LlmProvider) {
    if (!recommendations) return;
    const row = routing.find((r) => r.task === task);
    const tier = row ? findTier(recommendations[row.provider], row.model) : "balanced";
    updateRouting(task, { provider, model: recommendations[provider][tier].id });
  }

  function handleTierChange(task: LlmTask, provider: LlmProvider, tier: PriceTier) {
    if (!recommendations) return;
    updateRouting(task, { provider, model: recommendations[provider][tier].id });
  }

  async function handleSaveRouting() {
    setSavingRouting(true);
    try {
      const saved = await api.setModelRouting(routing);
      setRouting(saved);
      setMessage("Roteamento de modelos salvo.");
    } finally {
      setSavingRouting(false);
    }
  }

  async function handleSaveSpendLimits() {
    setSavingLimits(true);
    try {
      await Promise.all(
        (Object.keys(limitInputs) as LlmProvider[]).map((provider) => {
          const raw = limitInputs[provider].trim();
          return api.setSpendLimit(provider, raw ? Number(raw) : null);
        }),
      );
      await refreshSpendLimits();
      setMessage("Limites de gasto salvos.");
    } finally {
      setSavingLimits(false);
    }
  }

  const routingByTask = useMemo(() => new Map(routing.map((r) => [r.task, r])), [routing]);
  const connectedProviders = useMemo(
    () => (Object.keys(PROVIDER_LABELS) as LlmProvider[]).filter((provider) => statusFor(provider) === "connected"),
    [connections],
  );
  const routingWarning = useMemo(() => {
    const content = routingByTask.get("contentEnrichment");
    const evaluator = routingByTask.get("evaluator");
    if (content && evaluator && content.provider === evaluator.provider && content.model === evaluator.model) {
      return "Evaluator está usando o mesmo modelo do enriquecimento. Funciona, mas o score fica menos neutro.";
    }
    return null;
  }, [routingByTask]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Integrações</h1>
          <p className="muted">Credenciais, modelos e limites operacionais do pipeline.</p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}

        <section className="card">
          <h2>
            Plataforma de catálogo <StatusBadge kind="connection" status={statusFor(catalogPlatform)} />
          </h2>
          <p className="muted">Escolha a plataforma que fornece produtos, categorias, fotos e publicação final.</p>
          <div className="actions" style={{ marginBottom: "1rem" }}>
            {(Object.keys(PLATFORM_LABELS) as CatalogPlatform[]).map((platform) => (
              <button key={platform} type="button" className={platform === catalogPlatform ? "" : "secondary"} onClick={() => handlePlatformChange(platform)}>
                {PLATFORM_LABELS[platform]}
              </button>
            ))}
          </div>

          {catalogPlatform === "vtex" ? (
            <form onSubmit={handleVtexSubmit} className="form-grid">
              <input placeholder="Nome" value={vtex.displayName} onChange={(e) => setVtex({ ...vtex, displayName: e.target.value })} />
              <input placeholder="Account (ex: mundialacabamentos)" value={vtex.account} onChange={(e) => setVtex({ ...vtex, account: e.target.value })} />
              <input placeholder="Environment" value={vtex.environment} onChange={(e) => setVtex({ ...vtex, environment: e.target.value })} />
              <input placeholder="App Key" value={vtex.appKey} onChange={(e) => setVtex({ ...vtex, appKey: e.target.value })} />
              <input placeholder="App Token" type="password" value={vtex.appToken} onChange={(e) => setVtex({ ...vtex, appToken: e.target.value })} />
              <input
                placeholder="Domínio da loja (opcional, ex: www.minhaloja.com.br)"
                value={vtex.storefrontDomain}
                onChange={(e) => setVtex({ ...vtex, storefrontDomain: e.target.value })}
              />
              <CredentialHelpLink provider="vtex" />
              <button type="submit">Salvar e testar</button>
            </form>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Use o <strong>Admin API access token</strong> do app customizado, não a API key/secret do OAuth.
              </p>
              <form onSubmit={handleShopifySubmit} className="form-grid">
                <input placeholder="Nome" value={shopify.displayName} onChange={(e) => setShopify({ ...shopify, displayName: e.target.value })} />
                <input
                  placeholder="Domínio da loja (ex: minhaloja.myshopify.com)"
                  value={shopify.shopDomain}
                  onChange={(e) => setShopify({ ...shopify, shopDomain: e.target.value })}
                />
                <input
                  placeholder="Admin API access token (shpat_...)"
                  type="password"
                  value={shopify.accessToken}
                  onChange={(e) => setShopify({ ...shopify, accessToken: e.target.value })}
                />
                <CredentialHelpLink provider="shopify" />
                <button type="submit">Salvar e testar</button>
              </form>
            </>
          )}
        </section>

        <section className="card">
          <h2>
            Google - Search Console + GA4 <StatusBadge kind="connection" status={statusFor("google")} />
          </h2>
          <p className="muted">Conecte depois do catálogo. Essas métricas alimentam Impacto real, painel de resultados e priorização por desempenho.</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={handleGoogleAuth}>
              Autorizar no Google
            </button>
            <CredentialHelpLink provider="google" />
          </div>
          <form onSubmit={handleGoogleSubmit} className="form-grid">
            <input placeholder="Código de autorização" value={google.code} onChange={(e) => setGoogle({ ...google, code: e.target.value })} />
            <input placeholder="URL da propriedade no Search Console" value={google.gscSiteUrl} onChange={(e) => setGoogle({ ...google, gscSiteUrl: e.target.value })} />
            <input placeholder="GA4 Property ID" value={google.ga4PropertyId} onChange={(e) => setGoogle({ ...google, ga4PropertyId: e.target.value })} />
            <button type="submit">Salvar e testar</button>
          </form>
        </section>

        <section className="card">
          <h2>
            Anthropic (Claude) <StatusBadge kind="connection" status={statusFor("anthropic")} />
          </h2>
          <form onSubmit={handleAnthropicSubmit} className="form-grid">
            <input placeholder="Nome" value={anthropic.displayName} onChange={(e) => setAnthropic({ ...anthropic, displayName: e.target.value })} />
            <input placeholder="API Key" type="password" value={anthropic.apiKey} onChange={(e) => setAnthropic({ ...anthropic, apiKey: e.target.value })} />
            <CredentialHelpLink provider="anthropic" />
            <button type="submit">Salvar e testar</button>
          </form>
        </section>

        <section className="card">
          <h2>
            OpenAI (GPT) <StatusBadge kind="connection" status={statusFor("openai")} />
          </h2>
          <form onSubmit={handleOpenAiSubmit} className="form-grid">
            <input placeholder="Nome" value={openai.displayName} onChange={(e) => setOpenai({ ...openai, displayName: e.target.value })} />
            <input placeholder="API Key" type="password" value={openai.apiKey} onChange={(e) => setOpenai({ ...openai, apiKey: e.target.value })} />
            <CredentialHelpLink provider="openai" />
            <button type="submit">Salvar e testar</button>
          </form>
        </section>

        <section className="card">
          <h2>
            Google (Gemini) <StatusBadge kind="connection" status={statusFor("gemini")} />
          </h2>
          <form onSubmit={handleGeminiSubmit} className="form-grid">
            <input placeholder="Nome" value={gemini.displayName} onChange={(e) => setGemini({ ...gemini, displayName: e.target.value })} />
            <input placeholder="API Key" type="password" value={gemini.apiKey} onChange={(e) => setGemini({ ...gemini, apiKey: e.target.value })} />
            <CredentialHelpLink provider="gemini" />
            <button type="submit">Salvar e testar</button>
          </form>
        </section>

        <section className="card">
          <h2>Roteamento de modelos</h2>
          <p className="muted">
            Escolha quem gera, quem descreve imagens e quem avalia. Só provedores conectados aparecem como opção ativa.
          </p>
          {connectedProviders.length === 0 && (
            <div className="banner">Nenhum provedor de IA conectado ainda - conecte Anthropic, OpenAI ou Gemini para poder rotear.</div>
          )}
          {routingWarning && <div className="banner">{routingWarning}</div>}

          <div className="routing-list">
            {recommendations &&
              TASKS.map((task) => {
                const row = routingByTask.get(task.key);
                if (!row) return null;
                const tiers = recommendations[row.provider];
                const currentTier = findTier(tiers, row.model);
                const resolved = tiers[currentTier];
                const selectableProviders = connectedProviders.includes(row.provider)
                  ? connectedProviders
                  : [...connectedProviders, row.provider];

                return (
                  <div key={task.key} className="routing-row">
                    <div className="proposal-header">
                      <h3 style={{ margin: 0 }}>{task.label}</h3>
                      <span className="pill">
                        {resolved.label} · {formatPrice(resolved.inputPrice)} entrada / {formatPrice(resolved.outputPrice)} saída por MTok
                      </span>
                    </div>
                    <p className="muted" style={{ marginTop: 0 }}>
                      {task.hint}
                    </p>
                    <div className="form-grid">
                      <div style={{ flex: "1 1 220px" }}>
                        <label className="muted" style={{ display: "block", marginBottom: "0.3rem" }}>
                          Provedor
                        </label>
                        <select value={row.provider} onChange={(e) => handleProviderChange(task.key, e.target.value as LlmProvider)}>
                          {selectableProviders.map((provider) => (
                            <option key={provider} value={provider} disabled={!connectedProviders.includes(provider)}>
                              {PROVIDER_LABELS[provider]}
                              {connectedProviders.includes(provider) ? "" : " (não conectado)"}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div style={{ flex: "2 1 320px" }}>
                        <label className="muted" style={{ display: "block", marginBottom: "0.3rem" }}>
                          Otimizar para
                        </label>
                        <div className="actions">
                          {(Object.keys(TIER_LABELS) as PriceTier[]).map((tier) => (
                            <button
                              key={tier}
                              type="button"
                              className={tier === currentTier ? "" : "secondary"}
                              onClick={() => handleTierChange(task.key, row.provider, tier)}
                            >
                              {TIER_LABELS[tier]}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          <button type="button" onClick={handleSaveRouting} disabled={savingRouting || !recommendations}>
            {savingRouting ? "Salvando..." : "Salvar roteamento"}
          </button>
        </section>

        <section className="card">
          <h2>Limites de gasto mensal por provedor</h2>
          <p className="muted">
            Controle de segurança em USD. Quando o gasto do mês atinge o teto interno, novas otimizações desse provedor são bloqueadas até ajuste manual.
          </p>
          <div className="provider-spend-grid">
            {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((provider) => {
              const spend = spendLimits.find((l) => l.provider === provider);
              const overLimit = !!spend && spend.limitUsd !== null && spend.spentUsd >= spend.limitUsd;
              return (
                <div key={provider} className="provider-spend-row">
                  <div className="proposal-header">
                    <strong>{PROVIDER_LABELS[provider]}</strong>
                    {overLimit && <span className="pill tone-critical">Limite atingido</span>}
                  </div>
                  <div className="provider-spend-metrics">
                    <span>Gasto: {formatPrice(spend?.spentUsd ?? 0)}</span>
                    <span>Restante: {remainingLimit(spend)}</span>
                  </div>
                  <input
                    placeholder="Limite mensal em USD (vazio = sem limite)"
                    value={limitInputs[provider] ?? ""}
                    onChange={(e) => setLimitInputs({ ...limitInputs, [provider]: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
          <button type="button" onClick={handleSaveSpendLimits} disabled={savingLimits} style={{ marginTop: "0.75rem" }}>
            {savingLimits ? "Salvando..." : "Salvar limites"}
          </button>
        </section>
      </div>
    </>
  );
}
