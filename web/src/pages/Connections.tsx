import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CatalogPlatform,
  type Connection,
  type LlmProvider,
  type LlmTask,
  type FreeQuotaStatus,
  type ModelRoutingRow,
  type PriceTier,
  type ProviderRecommendations,
  type ProviderSpend,
} from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import {
  getBrlExchangeRate,
  getDisplayCurrency,
  setBrlExchangeRate,
  setDisplayCurrency,
  type DisplayCurrency,
} from "../lib/currency";

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

function CredentialHelpLink({ provider }: { provider: keyof typeof CREDENTIAL_HELP_URL }) {
  return (
    <a href={CREDENTIAL_HELP_URL[provider]} target="_blank" rel="noreferrer" className="credential-help-link">
      Onde pegar a chave →
    </a>
  );
}

const QUOTA_HELP_URL: Record<LlmProvider, string> = {
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/settings/organization/limits",
  gemini: "https://ai.google.dev/gemini-api/docs/rate-limits",
};

const RESET_INTERVAL_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: "A cada hora" },
  { hours: 6, label: "A cada 6 horas" },
  { hours: 12, label: "A cada 12 horas" },
  { hours: 24, label: "Diariamente (24h)" },
  { hours: 168, label: "Semanalmente (7 dias)" },
];

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
    hint: "Gera descrição, FAQ e dados estruturados — a tarefa mais exigente do pipeline.",
  },
  {
    key: "imageAltText",
    label: "Alt-text de imagem",
    hint: "Tarefa simples de visão — normalmente vale usar o nível 'Preço'.",
  },
  {
    key: "evaluator",
    label: "Evaluator (score de qualidade)",
    hint: "Julga o conteúdo antes/depois — recomendado manter em 'Equilibrado' ou acima.",
  },
];

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function findTier(recommendations: ProviderRecommendations, model: string): PriceTier {
  const match = (Object.entries(recommendations) as Array<[PriceTier, ProviderRecommendations[PriceTier]]>).find(
    ([, info]) => info.id === model,
  );
  return match?.[0] ?? "balanced";
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
  const [freeQuotas, setFreeQuotas] = useState<FreeQuotaStatus[]>([]);
  const [quotaInputs, setQuotaInputs] = useState<Record<LlmProvider, { enabled: boolean; quotaUsd: string; resetIntervalHours: string }>>({
    anthropic: { enabled: false, quotaUsd: "", resetIntervalHours: "24" },
    openai: { enabled: false, quotaUsd: "", resetIntervalHours: "24" },
    gemini: { enabled: false, quotaUsd: "", resetIntervalHours: "24" },
  });
  const [savingQuotas, setSavingQuotas] = useState(false);
  const [currency, setCurrency] = useState<DisplayCurrency>(() => getDisplayCurrency());
  const [brlRateInput, setBrlRateInput] = useState(() => String(getBrlExchangeRate()));
  const [message, setMessage] = useState<string | null>(null);

  const [vtex, setVtex] = useState({
    displayName: "VTEX — mundialacabamentos",
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
  const [google, setGoogle] = useState({ displayName: "Google (GSC + GA4)", code: "", gscSiteUrl: "https://www.mundialacabamentos.com.br/", ga4PropertyId: "" });

  async function refresh() {
    setConnections(await api.listConnections());
  }

  useEffect(() => {
    refresh();
    api.listModels().then((all) => setRecommendations(all as Record<LlmProvider, ProviderRecommendations>));
    api.getModelRouting().then(setRouting);
    api.getCatalogPlatform().then(({ platform }) => setCatalogPlatformState(platform));
    api.getSpendLimits().then((limits) => {
      setSpendLimits(limits);
      setLimitInputs(
        Object.fromEntries(limits.map((l) => [l.provider, l.limitUsd !== null ? String(l.limitUsd) : ""])) as Record<
          LlmProvider,
          string
        >,
      );
    });
    api.getFreeQuotas().then((quotas) => {
      setFreeQuotas(quotas);
      setQuotaInputs(
        Object.fromEntries(
          quotas.map((q) => [
            q.provider,
            { enabled: q.enabled, quotaUsd: String(q.quotaUsd), resetIntervalHours: String(q.resetIntervalHours) },
          ]),
        ) as Record<LlmProvider, { enabled: boolean; quotaUsd: string; resetIntervalHours: string }>,
      );
    });
  }, []);

  function statusFor(provider: Connection["provider"]) {
    return connections.find((c) => c.provider === provider)?.status ?? "untested";
  }

  async function handleVtexSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectVtex(vtex);
    setMessage(ok ? "VTEX conectado com sucesso." : `Falha ao conectar com a VTEX${error ? `: ${error}` : " — confira as credenciais."}`);
    refresh();
  }

  async function handleShopifySubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectShopify(shopify);
    setMessage(ok ? "Shopify conectado com sucesso." : `Falha ao conectar com a Shopify${error ? `: ${error}` : " — confira o domínio/token."}`);
    refresh();
  }

  async function handlePlatformChange(platform: CatalogPlatform) {
    setCatalogPlatformState(platform);
    await api.setCatalogPlatform(platform);
    setMessage(`Plataforma de catálogo ativa: ${PLATFORM_LABELS[platform]}.`);
  }

  async function handleAnthropicSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectAnthropic(anthropic);
    setMessage(ok ? "Anthropic conectado com sucesso." : `Falha ao validar a chave da Anthropic${error ? `: ${error}` : "."}`);
    refresh();
  }

  async function handleOpenAiSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectOpenAi(openai);
    setMessage(ok ? "OpenAI conectado com sucesso." : `Falha ao validar a chave da OpenAI${error ? `: ${error}` : "."}`);
    refresh();
  }

  async function handleGeminiSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok, error } = await api.connectGemini(gemini);
    setMessage(ok ? "Gemini conectado com sucesso." : `Falha ao validar a chave do Gemini${error ? `: ${error}` : "."}`);
    refresh();
  }

  async function handleGoogleAuth() {
    const { url } = await api.googleAuthUrl();
    window.open(url, "_blank");
  }

  async function handleGoogleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { ok } = await api.connectGoogle(google);
    setMessage(ok ? "Google (Search Console + GA4) conectado com sucesso." : "Falha ao validar o Google — confira o código/propriedades.");
    refresh();
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
      setSpendLimits(await api.getSpendLimits());
      setMessage("Limites de gasto salvos.");
    } finally {
      setSavingLimits(false);
    }
  }

  async function handleSaveQuotas() {
    setSavingQuotas(true);
    try {
      await Promise.all(
        (Object.keys(quotaInputs) as LlmProvider[]).map((provider) => {
          const input = quotaInputs[provider];
          return api.setFreeQuota(provider, {
            enabled: input.enabled,
            quotaUsd: Number(input.quotaUsd) || 0,
            resetIntervalHours: Number(input.resetIntervalHours) || 24,
          });
        }),
      );
      setFreeQuotas(await api.getFreeQuotas());
      setMessage("Franquias gratuitas salvas.");
    } finally {
      setSavingQuotas(false);
    }
  }

  function handleCurrencyChange(next: DisplayCurrency) {
    setCurrency(next);
    setDisplayCurrency(next);
    setMessage(`Moeda de exibição: ${next === "BRL" ? "Real (R$)" : "Dólar (US$)"}.`);
  }

  function handleBrlRateSave(e: React.FormEvent) {
    e.preventDefault();
    const rate = Number(brlRateInput);
    if (!Number.isFinite(rate) || rate <= 0) return;
    setBrlExchangeRate(rate);
    setBrlRateInput(String(rate));
    setMessage("Cotação do dólar salva.");
  }

  const routingByTask = useMemo(() => new Map(routing.map((r) => [r.task, r])), [routing]);
  const connectedProviders = useMemo(
    () => (Object.keys(PROVIDER_LABELS) as LlmProvider[]).filter((provider) => statusFor(provider) === "connected"),
    [connections],
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Integrações</h1>
          <p className="muted">Todas as credenciais ficam criptografadas em banco, nunca em arquivo versionado.</p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}

        <section className="card">
          <h2>
            Plataforma de catálogo{" "}
            <StatusBadge kind="connection" status={statusFor(catalogPlatform)} />
          </h2>
          <p className="muted">Só uma plataforma roda o pipeline por vez — escolha qual e preencha a credencial dela.</p>
          <div className="actions" style={{ marginBottom: "1rem" }}>
            {(Object.keys(PLATFORM_LABELS) as CatalogPlatform[]).map((platform) => (
              <button
                key={platform}
                type="button"
                className={platform === catalogPlatform ? "" : "secondary"}
                onClick={() => handlePlatformChange(platform)}
              >
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
                Use o <strong>Admin API access token</strong> (começa com <code>shpat_</code>), na aba "API
                credentials" do seu app custom — não é a "API key and secret key" (esse par é do OAuth/webhooks,
                não dá acesso à Admin API).
              </p>
              <form onSubmit={handleShopifySubmit} className="form-grid">
                <input placeholder="Nome" value={shopify.displayName} onChange={(e) => setShopify({ ...shopify, displayName: e.target.value })} />
                <input
                  placeholder="Domínio da loja (ex: minhaloja.myshopify.com)"
                  value={shopify.shopDomain}
                  onChange={(e) => setShopify({ ...shopify, shopDomain: e.target.value })}
                />
                <input
                  placeholder="Admin API access token (shpat_...) — não é a API key/secret"
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
            Escolha o provedor de IA e o nível de otimização (qualidade ou preço) para cada tarefa do pipeline.
            Só provedores conectados aparecem como opção — conecte o provedor correspondente acima primeiro.
          </p>

          {connectedProviders.length === 0 && (
            <div className="banner">Nenhum provedor de IA conectado ainda — conecte Anthropic, OpenAI ou Gemini acima para poder rotear.</div>
          )}

          {recommendations &&
            TASKS.map((task) => {
              const row = routingByTask.get(task.key);
              if (!row) return null;
              const tiers = recommendations[row.provider];
              const currentTier = findTier(tiers, row.model);
              const resolved = tiers[currentTier];
              // The current selection must always render as a valid <option>, even if that
              // provider isn't connected (e.g. a stale routing row from before it was disconnected).
              const selectableProviders = connectedProviders.includes(row.provider)
                ? connectedProviders
                : [...connectedProviders, row.provider];

              return (
                <div key={task.key} className="card" style={{ background: "var(--surface-2)", marginBottom: "1rem" }}>
                  <div className="proposal-header">
                    <h3 style={{ margin: 0 }}>{task.label}</h3>
                    <span className="pill">
                      {resolved.label} — {formatPrice(resolved.inputPrice)} / {formatPrice(resolved.outputPrice)} por MTok
                    </span>
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {task.hint}
                  </p>
                  <div className="form-grid">
                    <div style={{ flex: "1 1 200px" }}>
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

          <button type="button" onClick={handleSaveRouting} disabled={savingRouting || !recommendations}>
            {savingRouting ? "Salvando…" : "Salvar roteamento"}
          </button>
        </section>

        <section className="card">
          <h2>Limites de gasto mensal por provedor</h2>
          <p className="muted">
            Defina um teto de gasto (USD) por provedor de IA, renovado todo dia 1º do mês. Ao atingir
            o limite, novas otimizações que dependam desse provedor ficam bloqueadas até o próximo mês
            ou até você ajustar o valor — evita cobranças extras por descuido.
          </p>
          <div className="form-grid">
            {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((provider) => {
              const spend = spendLimits.find((l) => l.provider === provider);
              const overLimit = !!spend && spend.limitUsd !== null && spend.spentUsd >= spend.limitUsd;
              return (
                <div key={provider} style={{ flex: "1 1 220px" }}>
                  <label className="muted" style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                    {PROVIDER_LABELS[provider]}
                    {spend && <span className="pill">gasto neste mês: {formatPrice(spend.spentUsd)}</span>}
                    {overLimit && (
                      <span className="pill" style={{ color: "var(--status-critical)" }}>
                        Limite atingido
                      </span>
                    )}
                  </label>
                  <input
                    placeholder="Sem limite"
                    value={limitInputs[provider] ?? ""}
                    onChange={(e) => setLimitInputs({ ...limitInputs, [provider]: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
          <button type="button" onClick={handleSaveSpendLimits} disabled={savingLimits} style={{ marginTop: "0.75rem" }}>
            {savingLimits ? "Salvando…" : "Salvar limites"}
          </button>
        </section>

        <section className="card">
          <h2>Franquia gratuita por provedor</h2>
          <p className="muted">
            Muitos provedores dão uma cota grátis que se renova periodicamente (ex: franquia diária do
            Gemini). Ative "Usar apenas franquia gratuita" para travar novas otimizações assim que essa
            cota acabar, em vez de cair pra cobrança paga — um alerta aparece na tela de Produtos avisando
            quando isso acontece e quando reseta. <strong>O valor em USD é uma aproximação</strong> — algumas
            franquias (ex: Gemini sem faturamento ativado) são medidas em requisições/dia, não em dólar;
            confira o valor real da sua conta no link de cada provedor antes de preencher.
          </p>
          <div className="form-grid" style={{ alignItems: "flex-start" }}>
            {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((provider) => {
              const status = freeQuotas.find((q) => q.provider === provider);
              const input = quotaInputs[provider];
              return (
                <div key={provider} style={{ flex: "1 1 260px" }}>
                  <label className="muted" style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
                    <input
                      type="checkbox"
                      checked={input.enabled}
                      onChange={(e) => setQuotaInputs({ ...quotaInputs, [provider]: { ...input, enabled: e.target.checked } })}
                    />
                    {PROVIDER_LABELS[provider]} — usar apenas franquia gratuita
                    {status?.exhausted && (
                      <span className="pill" style={{ color: "var(--status-critical)" }}>
                        Esgotada
                      </span>
                    )}
                  </label>
                  <a href={QUOTA_HELP_URL[provider]} target="_blank" rel="noreferrer" className="credential-help-link" style={{ marginBottom: "0.5rem" }}>
                    Ver minha franquia →
                  </a>
                  {input.enabled && (
                    <div className="form-grid" style={{ marginTop: "0.5rem" }}>
                      <input
                        placeholder="Cota (USD)"
                        value={input.quotaUsd}
                        onChange={(e) => setQuotaInputs({ ...quotaInputs, [provider]: { ...input, quotaUsd: e.target.value } })}
                      />
                      <select
                        value={input.resetIntervalHours}
                        onChange={(e) =>
                          setQuotaInputs({ ...quotaInputs, [provider]: { ...input, resetIntervalHours: e.target.value } })
                        }
                      >
                        {RESET_INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt.hours} value={opt.hours}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {status && status.enabled && (
                    <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.3rem" }}>
                      Usado no período atual: {formatPrice(status.periodSpentUsd)} / {formatPrice(status.quotaUsd)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <button type="button" onClick={handleSaveQuotas} disabled={savingQuotas} style={{ marginTop: "0.75rem" }}>
            {savingQuotas ? "Salvando…" : "Salvar franquias"}
          </button>
        </section>

        <section className="card">
          <h2>Moeda de exibição</h2>
          <p className="muted">
            Os custos de IA são sempre calculados em USD (moeda de cobrança dos provedores) — isso só
            controla como o valor é <em>exibido</em> nas telas.
          </p>
          <div className="actions" style={{ marginBottom: currency === "BRL" ? "0.75rem" : 0 }}>
            <button type="button" className={currency === "USD" ? "" : "secondary"} onClick={() => handleCurrencyChange("USD")}>
              Dólar (US$)
            </button>
            <button type="button" className={currency === "BRL" ? "" : "secondary"} onClick={() => handleCurrencyChange("BRL")}>
              Real (R$)
            </button>
          </div>
          {currency === "BRL" && (
            <form onSubmit={handleBrlRateSave} className="form-grid">
              <input
                placeholder="Cotação USD → BRL (ex: 5.20)"
                value={brlRateInput}
                onChange={(e) => setBrlRateInput(e.target.value)}
              />
              <button type="submit">Salvar cotação</button>
            </form>
          )}
        </section>

        <section className="card">
          <h2>
            Google — Search Console + GA4 <StatusBadge kind="connection" status={statusFor("google")} />
          </h2>
          <p className="muted">
            1) Autorize o acesso no Google. 2) Cole o código retornado e preencha a propriedade do
            Search Console e o ID da propriedade GA4.
          </p>
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
      </div>
    </>
  );
}
